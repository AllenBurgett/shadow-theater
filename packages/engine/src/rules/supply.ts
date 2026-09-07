import type { GameState, RegionState, Scenario, Side, SupplyState } from "../contract/index.ts";
import { effectiveCapacity, otherEndpoint, PASSABLE_CAPACITY } from "./legality.ts";
import { withRegion } from "./state.ts";

/**
 * Supply and attrition (RD-12; RD-1 phase 4 and the attrition step of phase 5).
 *
 * Pure like every other rules module: these return the next `GameState` and
 * report what changed as data — the resolver owns the event log and turns
 * `SupplyChange` into `supplyChanged` and `AttritionLoss` into `attrition`.
 *
 * This is the rule `createGame`'s `initialSupply` placeholder stands in for.
 * That placeholder cannot produce IN_SUPPLY because the top of the ladder
 * needs the port-reachability BFS below; the phase-4 recompute supersedes it
 * on the first resolved turn, and no other module writes `RegionState.supply`.
 *
 * The BFS reads `effectiveCapacity`, which already discounts an INTERDICT
 * whose `expiresTurn` has arrived (`isActive` is `turn < expiresTurn`). So
 * running supply in phase 4, *before* phase 5 removes those effects, is not a
 * one-turn lag: the effect is inert from the moment the turn opens and phase 5
 * only collects it. Removal is bookkeeping, not a capacity change.
 */

/** A supply transition, for the resolver's `supplyChanged`. */
export interface SupplyChange {
  regionId: string;
  side: Side;
  from: SupplyState;
  to: SupplyState;
}

/** Presence a side actually lost to attrition, for the resolver's `attrition`. */
export interface AttritionLoss {
  regionId: string;
  side: Side;
  amount: number;
}

export interface SupplyResult {
  state: GameState;
  changes: SupplyChange[];
}

export interface AttritionResult {
  state: GameState;
  losses: AttritionLoss[];
}

/**
 * ⚙ RD-12: presence a side loses per turn in a THIN or CUT region.
 *
 * The prototype wrote −3 but only on CUT, and its own assignment made a
 * controlled region unreachable-but-CUT impossible, so the branch never ran
 * (mechanics-inventory §7). RD-12 penalises both out-of-supply tiers, which is
 * what makes THIN mean anything at all.
 */
export const ATTRITION_PER_TURN = 2;

const SIDES: readonly Side[] = ["BLUE", "RED"];

const MIN_PRESENCE = 0;

/**
 * The regions `side` can trace back to one of its ports (RD-12).
 *
 * Sources are the side's **controlled** PORT regions; a CONTESTED port is
 * enterable but never a source. Traversal crosses a link of effective capacity
 * ≥ 1 (RD-7 — an interdicted-to-zero corridor carries nothing, a JAM costs
 * nothing) and enters a region only if the side controls it or it is
 * CONTESTED. A side with no port reaches nothing at all.
 */
function reachable(scenario: Scenario, state: GameState, side: Side): ReadonlySet<string> {
  const reached = new Set<string>();

  // The frontier is walked with `for…of` rather than a pop loop: an array
  // iterator re-reads `length` each step, so regions appended while it runs
  // are visited in turn. That is the whole queue, without a `pop()` whose
  // `undefined` case is unreachable but still has to be written down.
  const frontier: string[] = [];
  for (const region of scenario.map.regions) {
    if (region.type === "PORT" && state.regions[region.id]?.control === side) {
      reached.add(region.id);
      frontier.push(region.id);
    }
  }

  for (const current of frontier) {
    for (const link of scenario.map.links) {
      const nextId = otherEndpoint(link, current);
      if (nextId === undefined || reached.has(nextId)) {
        continue;
      }
      const next = state.regions[nextId];
      if (!next || (next.control !== side && next.control !== "CONTESTED")) {
        continue;
      }
      if (effectiveCapacity(scenario, state, link.id) < PASSABLE_CAPACITY) {
        continue;
      }
      reached.add(nextId);
      frontier.push(nextId);
    }
  }

  return reached;
}

/** RD-12's ordered assignment for one side; the first match wins. */
function assign(
  region: RegionState,
  regionId: string,
  side: Side,
  reached: ReadonlySet<string>,
): SupplyState {
  if (reached.has(regionId)) {
    // A CONTESTED region the BFS entered is IN_SUPPLY for the side that
    // reached it, even though that side does not control it.
    return "IN_SUPPLY";
  }
  if (region.control === side) {
    return "THIN";
  }
  if (region.presence[side] > 0) {
    return "CUT";
  }
  return "NONE";
}

/** Reassigns every region's supply for both sides (RD-12, RD-1 phase 4). */
export function recomputeSupply(scenario: Scenario, state: GameState): SupplyResult {
  const reached: Record<Side, ReadonlySet<string>> = {
    BLUE: reachable(scenario, state, "BLUE"),
    RED: reachable(scenario, state, "RED"),
  };

  let next = state;
  const changes: SupplyChange[] = [];
  for (const [regionId, region] of Object.entries(state.regions)) {
    let updated = region;
    for (const side of SIDES) {
      const from = region.supply[side];
      const to = assign(region, regionId, side, reached[side]);
      if (to === from) {
        continue;
      }
      changes.push({ regionId, side, from, to });
      updated = { ...updated, supply: { ...updated.supply, [side]: to } };
    }
    if (updated !== region) {
      next = withRegion(next, regionId, updated);
    }
  }

  return { state: next, changes };
}

/**
 * RD-12 attrition: every side out of supply in a region loses presence there.
 *
 * Control is deliberately **not** re-resolved here — RD-1 gives the whole-board
 * recompute its own phase immediately after this one, so a margin this drains
 * through flips exactly once, in phase 6.
 *
 * The reported `amount` is the presence actually lost, so a side clamped to 0
 * reports what it had rather than the nominal rate, and a side already at 0
 * reports nothing at all.
 */
export function applyAttrition(state: GameState): AttritionResult {
  let next = state;
  const losses: AttritionLoss[] = [];
  for (const [regionId, region] of Object.entries(state.regions)) {
    let updated = region;
    for (const side of SIDES) {
      const supply = region.supply[side];
      if (supply !== "THIN" && supply !== "CUT") {
        continue;
      }
      const before = region.presence[side];
      const after = Math.max(MIN_PRESENCE, before - ATTRITION_PER_TURN);
      if (after === before) {
        continue;
      }
      losses.push({ regionId, side, amount: before - after });
      updated = { ...updated, presence: { ...updated.presence, [side]: after } };
    }
    if (updated !== region) {
      next = withRegion(next, regionId, updated);
    }
  }

  return { state: next, losses };
}
