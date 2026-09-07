import type { Control, Effect, GameState, RegionState, Scenario, Side } from "../contract/index.ts";
import { resolveControl } from "./control.ts";
import { EFFECT_DURATION, MAX_FORT, supportingRegions } from "./legality.ts";
import type { ControlChange, OpOutcome } from "./state.ts";
import { withLink, withRegion } from "./state.ts";

/**
 * Surface operation effects (RD-2a's effect column, RD-7, RD-13).
 *
 * Every function here is pure: it returns the next `GameState` rather than
 * editing the one it is given, and it emits nothing. The resolver (T016) owns
 * the event log; these report what changed as data — `effects` for
 * `orderApplied`, `controlChanges` for `controlChanged`.
 *
 * Legality is the caller's precondition (`isLegalTarget`, re-checked at
 * resolution for RD-1 fizzles). What is checked here is only what legality
 * cannot see: the fort cap per turn, and that the target is on the map at all.
 *
 * `lastController` is never touched — RD-8 writes it once at the very end of
 * evaluation, after unrest and the constraint penalty have read it (review N7).
 */

/** Advance strength from a supplied approach, else the unsupplied base (⚙). */
const ADVANCE_BASE_IN_SUPPLY = 18;
const ADVANCE_BASE = 10;

/** Each fort level absorbs this much of the attacker's damage (⚙). */
const FORT_DAMAGE_PER_LEVEL = 4;

/** RD-2a redeploy: 25% of the stronger endpoint, bounded to 5..20 (⚙). */
const REDEPLOY_SHARE = 0.25;
const REDEPLOY_MIN = 5;
const REDEPLOY_MAX = 20;

const MIN_PRESENCE = 0;
const MAX_PRESENCE = 100;

function clampPresence(value: number): number {
  return Math.min(MAX_PRESENCE, Math.max(MIN_PRESENCE, value));
}

/** A presence write plus the `presenceChanged` effect it actually produced. */
function shiftPresence(
  region: RegionState,
  side: Side,
  delta: number,
  regionId: string,
  effects: Effect[],
): RegionState {
  const before = region.presence[side];
  const after = clampPresence(before + delta);
  if (after === before) {
    // Clamping can swallow a nominal delta entirely; the AAR should describe
    // what happened on the board, not what was attempted.
    return region;
  }
  effects.push({ kind: "presenceChanged", regionId, side, delta: after - before });
  return { ...region, presence: { ...region.presence, [side]: after } };
}

/** Re-resolves control inline (RD-13) and records the flip, if any. */
function reresolveControl(
  region: RegionState,
  regionId: string,
  changes: ControlChange[],
): RegionState {
  const from: Control = region.control;
  const to = resolveControl(region.presence);
  if (to === from) {
    return region;
  }
  changes.push({ regionId, from, to });
  return { ...region, control: to };
}

/**
 * DELIBERATE_ADVANCE (RD-2a).
 *
 * Base is existential over the approach: 18 if **any** side-held region joined
 * to the target by a usable link is IN_SUPPLY, else 10. No source region is
 * named in the operation and none is debited — attacker presence is created,
 * exactly as in the prototype. Defender damage is `base - fort*4` floored at
 * 0, the flagged fix for the prototype's fort-heals-defender defect.
 */
export function deliberateAdvance(
  scenario: Scenario,
  state: GameState,
  side: Side,
  regionId: string,
): OpOutcome {
  const region = state.regions[regionId];
  if (!region) {
    return { applied: false, reason: `Region "${regionId}" is not on the map` };
  }

  const supplied = supportingRegions(scenario, state, side, regionId).some(
    (source) => source.supply[side] === "IN_SUPPLY",
  );
  const base = supplied ? ADVANCE_BASE_IN_SUPPLY : ADVANCE_BASE;
  const defender: Side = side === "BLUE" ? "RED" : "BLUE";
  const damage = Math.max(0, base - region.fort * FORT_DAMAGE_PER_LEVEL);

  const effects: Effect[] = [];
  const controlChanges: ControlChange[] = [];
  let next = shiftPresence(region, side, base, regionId, effects);
  next = shiftPresence(next, defender, -damage, regionId, effects);
  next = reresolveControl(next, regionId, controlChanges);

  return { applied: true, state: withRegion(state, regionId, next), effects, controlChanges };
}

/**
 * RAPID_REDEPLOY (RD-2a).
 *
 * Direction is forced strong → weak by *friendly* presence with ties to
 * `link.a` (prototype `fromId = a[key] >= b[key] ? l.a : l.b`). The 5-minimum
 * means a 10-presence source moves half of itself, not a quarter.
 */
export function rapidRedeploy(
  scenario: Scenario,
  state: GameState,
  side: Side,
  linkId: string,
): OpOutcome {
  const link = scenario.map.links.find((entry) => entry.id === linkId);
  if (!link) {
    return { applied: false, reason: `Link "${linkId}" is not on the map` };
  }
  const endpointA = state.regions[link.a];
  const endpointB = state.regions[link.b];
  if (!endpointA || !endpointB) {
    return { applied: false, reason: `Link "${linkId}" has an endpoint the state does not track` };
  }

  const fromIsA = endpointA.presence[side] >= endpointB.presence[side];
  const fromId = fromIsA ? link.a : link.b;
  const toId = fromIsA ? link.b : link.a;
  const from = fromIsA ? endpointA : endpointB;
  const to = fromIsA ? endpointB : endpointA;
  const moved = Math.min(
    REDEPLOY_MAX,
    Math.max(REDEPLOY_MIN, Math.floor(from.presence[side] * REDEPLOY_SHARE)),
  );

  const effects: Effect[] = [];
  const controlChanges: ControlChange[] = [];
  const nextFrom = reresolveControl(
    shiftPresence(from, side, -moved, fromId, effects),
    fromId,
    controlChanges,
  );
  const nextTo = reresolveControl(
    shiftPresence(to, side, moved, toId, effects),
    toId,
    controlChanges,
  );

  return {
    applied: true,
    state: withRegion(withRegion(state, fromId, nextFrom), toId, nextTo),
    effects,
    controlChanges,
  };
}

/**
 * FORTIFY_REGION (RD-2a, RD-5).
 *
 * The +1-per-region-per-turn cap is the one legality clause `isLegalTarget`
 * cannot answer, because it quantifies over what has already happened during
 * this resolution. The set of regions raised so far is passed in rather than
 * stored: it is turn-scoped bookkeeping the resolver owns, and a field on
 * `GameState` would have to be created, cleared, replayed, and projected for a
 * fact that never outlives the turn.
 *
 * It takes no `side`: fort is not side-owned (it persists through capture and
 * then serves the captor), and "controlled by the side" is legality, which the
 * resolver re-checks before calling.
 */
export function fortifyRegion(
  state: GameState,
  regionId: string,
  raisedThisTurn: ReadonlySet<string>,
): OpOutcome {
  const region = state.regions[regionId];
  if (!region) {
    return { applied: false, reason: `Region "${regionId}" is not on the map` };
  }
  if (raisedThisTurn.has(regionId)) {
    return { applied: false, reason: `"${regionId}" was already fortified this turn` };
  }
  if (region.fort >= MAX_FORT) {
    return { applied: false, reason: `"${regionId}" is already at the fort ceiling` };
  }

  const to = region.fort + 1;
  return {
    applied: true,
    state: withRegion(state, regionId, { ...region, fort: to }),
    effects: [{ kind: "fortChanged", regionId, from: region.fort, to }],
    controlChanges: [],
  };
}

/**
 * INTERDICT_LINK (RD-2a, RD-7): stackable; each active effect costs one point
 * of effective capacity, and the capacity returns when the effect expires —
 * unlike the prototype, which lowered the base permanently.
 */
export function interdictLink(state: GameState, side: Side, linkId: string): OpOutcome {
  return addLinkEffect(state, side, linkId, "INTERDICT");
}

/** JAM and INTERDICT differ only in what reads them (RD-7); adding is shared. */
export function addLinkEffect(
  state: GameState,
  side: Side,
  linkId: string,
  kind: "INTERDICT" | "JAM",
): OpOutcome {
  const linkState = state.links[linkId];
  if (!linkState) {
    return { applied: false, reason: `Link "${linkId}" is not on the map` };
  }

  const effect = { kind, side, expiresTurn: state.turn + EFFECT_DURATION } as const;
  return {
    applied: true,
    state: withLink(state, linkId, { ...linkState, effects: [...linkState.effects, effect] }),
    effects: [{ kind: "linkEffectAdded", linkId, effect }],
    controlChanges: [],
  };
}

/**
 * SECURE_CORRIDOR (RD-2a): removes every enemy effect on the link — both
 * INTERDICT and JAM — and never raises capacity above the map base, the
 * flagged fix for the prototype's capacity inflation.
 */
export function secureCorridor(state: GameState, side: Side, linkId: string): OpOutcome {
  const linkState = state.links[linkId];
  if (!linkState) {
    return { applied: false, reason: `Link "${linkId}" is not on the map` };
  }

  const kept = linkState.effects.filter((effect) => effect.side === side);
  const effects: Effect[] = linkState.effects
    .filter((effect) => effect.side !== side)
    .map((effect) => ({ kind: "linkEffectRemoved", linkId, effect }));

  return {
    applied: true,
    state: withLink(state, linkId, { ...linkState, effects: kept }),
    effects,
    controlChanges: [],
  };
}
