import type { GameState, PostureBand, Scenario, Side } from "../contract/index.ts";
import { withRegion, withSide } from "./state.ts";

/**
 * Political capital, posture bands, the RD-8 constraint penalty, and the
 * end-of-evaluation `lastController` write (RD-1 phase 8; RD-4, RD-5, RD-8).
 *
 * Pure like every other rules module: it returns the next `GameState` and
 * reports what changed as data; the resolver owns the event log.
 *
 * **This module drains and reports; it never decides an ending.** Political
 * capital is deliberately *not* clamped at 0 — `SideState.political` is
 * `z.int()` with no floor, and RD-11's endings ladder (slice C) tests `<= 0`
 * per side and calls a simultaneous crossing a DRAW. Clamping would erase how
 * far past zero a side went and would flatten two different positions into the
 * same number for a rule that only ever compares them.
 */

/** ⚙ RD-4: the per-HABITAT rate both drain clauses charge. */
export const HABITAT_DRAIN = 1;

/** RD-5: the unrest level at which a *controlled* HABITAT starts costing. */
export const UNREST_DRAIN_LEVEL = 2;

/**
 * RD-4 posture bands: STABLE above 12, STRAINED 6..12 inclusive, CRITICAL
 * below 6. The band is the only political figure the enemy ever sees
 * (`SideView.posture`); the exact number is an SC-003 forbidden field.
 *
 * Known M1 limitation, accepted (review N18): drains are deterministic and
 * control is fully disclosed, so a diligent player can reconstruct the enemy's
 * exact value from the turns its band changes. The band is a presentation
 * boundary, not an information-theoretic one, until Milestone 2's intel work.
 * This is recorded here so it is not later mistaken for an oversight.
 */
const POSTURE_STABLE_ABOVE = 12;
const POSTURE_CRITICAL_BELOW = 6;

export function postureBand(political: number): PostureBand {
  if (political > POSTURE_STABLE_ABOVE) {
    return "STABLE";
  }
  if (political >= POSTURE_CRITICAL_BELOW) {
    return "STRAINED";
  }
  return "CRITICAL";
}

/**
 * Why capital moved, for `politicalChanged.cause`.
 *
 * `politicalChanged` carries no `regionId`, so per-region granularity is not
 * expressible on the wire; one event per cause per side is the finest split
 * the schema allows, and a bare "upkeep" would throw away the *why* that the
 * field exists for. The slugs are stable — #16's AAR renderer turns them into
 * text, so they are read as identifiers, not prose.
 */
export type PoliticalCause = "habitatNotControlled" | "habitatUnrest" | "habitatLossPenalty";

/** One cause's contribution to a side's capital this upkeep. */
export interface PoliticalDrain {
  side: Side;
  from: number;
  to: number;
  cause: PoliticalCause;
}

/** A side's posture band as of this upkeep, when it differs from the last. */
export interface PostureChange {
  side: Side;
  band: PostureBand;
}

export interface PoliticalResult {
  state: GameState;
  drains: PoliticalDrain[];
  postures: PostureChange[];
}

const SIDES: readonly Side[] = ["BLUE", "RED"];

/** The scenario's HABITAT region ids, in map order. */
function habitats(scenario: Scenario): string[] {
  return scenario.map.regions
    .filter((region) => region.type === "HABITAT")
    .map((region) => region.id);
}

/**
 * The total `habitatLossPoliticalPenalty` a side owes this turn (RD-8).
 *
 * A side pays when its **previous** turn-end control of a HABITAT was itself
 * and its **current** turn-end control is anything else — `lastController` vs
 * `control`, which is why RD-8 pins the `lastController` write to the very end
 * of evaluation (`writeLastController`, review N7).
 *
 * Charged **per habitat lost**, not once per turn: the constraint is written
 * as a per-region condition alongside RD-4's other per-region clauses, and a
 * second habitat falling in the same turn being free would be a strange rule.
 * On this scenario the two readings only differ if one side holds both.
 *
 * Zero when the scenario declares no such constraint — the anti-ghost-rule
 * requirement (review M3). Multiple declarations each apply.
 *
 * The type guard is unreachable today and deliberately so: `TypedConstraint`
 * has one member in M1, so no scenario can produce a constraint this loop must
 * skip. It stays because the union is written to grow, and dropping it would
 * make a future constraint that happens to carry an `amount` silently bill
 * itself as a habitat loss. It is the one line here coverage cannot reach.
 */
function lossPenalty(scenario: Scenario, state: GameState, side: Side): number {
  let amount = 0;
  for (const constraint of scenario.constraints) {
    if (constraint.type !== "habitatLossPoliticalPenalty") {
      continue;
    }
    for (const regionId of habitats(scenario)) {
      const region = state.regions[regionId];
      if (region && region.lastController === side && region.control !== side) {
        amount += constraint.amount;
      }
    }
  }
  return amount;
}

/**
 * RD-4's two per-habitat drain clauses, which are **mutually exclusive per
 * region** by construction: a region the side does not control bills once for
 * that, and a region it does control bills only if unrest has reached the
 * level. Neither clause can see a region the other one charged.
 */
function habitatDrains(
  scenario: Scenario,
  state: GameState,
  side: Side,
): Record<"habitatNotControlled" | "habitatUnrest", number> {
  let notControlled = 0;
  let unrest = 0;
  for (const regionId of habitats(scenario)) {
    const region = state.regions[regionId];
    if (!region) {
      continue;
    }
    if (region.control !== side) {
      notControlled += HABITAT_DRAIN;
    } else if (region.unrest >= UNREST_DRAIN_LEVEL) {
      unrest += HABITAT_DRAIN;
    }
  }
  return { habitatNotControlled: notControlled, habitatUnrest: unrest };
}

/**
 * RD-1 phase 8: charges both sides their upkeep against the turn-end board.
 *
 * Sides are processed BLUE then RED and never in initiative order — RD-1
 * lists upkeep as a single phase and the charges are independent, so nothing
 * about the outcome depends on the sequence. That matters for the DRAW case:
 * both sides crossing zero in one upkeep must be one state, not a race.
 */
export function politicalUpkeep(scenario: Scenario, state: GameState): PoliticalResult {
  let next = state;
  const drains: PoliticalDrain[] = [];
  const postures: PostureChange[] = [];

  for (const side of SIDES) {
    const sideState = state.sides[side];
    const before = sideState.political;
    const perHabitat = habitatDrains(scenario, state, side);
    const charges: readonly (readonly [PoliticalCause, number])[] = [
      ["habitatNotControlled", perHabitat.habitatNotControlled],
      ["habitatUnrest", perHabitat.habitatUnrest],
      ["habitatLossPenalty", lossPenalty(scenario, state, side)],
    ];

    let running = before;
    for (const [cause, amount] of charges) {
      if (amount === 0) {
        continue;
      }
      const to = running - amount;
      drains.push({ side, from: running, to, cause });
      running = to;
    }

    if (running === before) {
      continue;
    }
    next = withSide(next, side, { ...sideState, political: running });
    const band = postureBand(running);
    if (band !== postureBand(before)) {
      postures.push({ side, band });
    }
  }

  return { state: next, drains, postures };
}

/**
 * RD-8's `lastController` write: every region's turn-end control, snapshotted.
 *
 * A snapshot, not a delta — `lastController` means "control at the previous
 * turn end", so an unchanged region records its unchanged control just as
 * loudly as a flipped one does.
 *
 * Ordering is the whole point of this being a separate step (review N7). It
 * runs at the **very end of evaluation**, after every reader: RD-5's unrest
 * comparison in phase 7 and RD-8's penalty in phase 8 both read the previous
 * turn's value, and moving this write above either of them would silently
 * blank both rules rather than fail.
 */
export function writeLastController(state: GameState): GameState {
  let next = state;
  for (const [regionId, region] of Object.entries(state.regions)) {
    if (region.lastController === region.control) {
      continue;
    }
    next = withRegion(next, regionId, { ...region, lastController: region.control });
  }
  return next;
}
