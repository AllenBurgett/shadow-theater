import type {
  Card,
  CardId,
  GameState,
  Link,
  LinkEffect,
  RegionState,
  Scenario,
  Side,
} from "../contract/index.ts";

/**
 * Target legality (RD-2a's legality column, RD-5, RD-7).
 *
 * Two views of one rule set: `isLegalTarget` answers for a single operation —
 * which is what RD-1's resolution re-check needs to decide a fizzle — and
 * `legalTargets` enumerates by filtering the map through that same predicate,
 * so the list a planner or a view reads can never drift from the check that
 * validation and resolution apply.
 *
 * Every lookup here is defensive about ids: `legalTargets` only asks about ids
 * the scenario declares, but `isLegalTarget` is reached from the wire (and
 * from a language model), so an off-map id must answer "not legal" rather than
 * throw. A state that does not track a scenario element reads as an empty
 * position for the same reason.
 */

/** RD-2a `linkReach`: the friendly presence that reaches across a link. */
const REACH_PRESENCE = 10;

/** RD-7: a link is usable while at least this much capacity survives. */
const PASSABLE_CAPACITY = 1;

/** RD-5: fortification is illegal from this unrest level up. */
const FORTIFY_UNREST_LIMIT = 2;

/** RD-2a: the fort ceiling. */
const MAX_FORT = 3;

const NO_EFFECTS: readonly LinkEffect[] = [];

/**
 * RD-2a's pinned effect timing: an effect added on turn N has
 * `expiresTurn = N + 2`, is active at turn ends N and N+1, and is removed in
 * the timers phase of turn `expiresTurn`. Both halves of that rule live here —
 * the duration the operations stamp, and the `isActive` test everything reads.
 */
export const EFFECT_DURATION = 2;

/** Resolves a card in the scenario's catalogue; absent = `UNKNOWN_CARD` (RD-2). */
export function findCard(scenario: Scenario, cardId: CardId): Card | undefined {
  return scenario.cards.find((card) => card.id === cardId);
}

function findLink(scenario: Scenario, linkId: string): Link | undefined {
  return scenario.map.links.find((link) => link.id === linkId);
}

function regionAt(state: GameState, regionId: string): RegionState | undefined {
  return state.regions[regionId];
}

function controls(state: GameState, side: Side, regionId: string): boolean {
  return regionAt(state, regionId)?.control === side;
}

function presenceAt(state: GameState, side: Side, regionId: string): number {
  return regionAt(state, regionId)?.presence[side] ?? 0;
}

/** Whether `effect` is still in force on `turn` (see `EFFECT_DURATION`). */
export function isActive(effect: LinkEffect, turn: number): boolean {
  return turn < effect.expiresTurn;
}

/** The far end of `link` from `regionId`, or undefined if it is not incident. */
function otherEndpoint(link: Link, regionId: string): string | undefined {
  if (link.a === regionId) {
    return link.b;
  }
  if (link.b === regionId) {
    return link.a;
  }
  return undefined;
}

/**
 * RD-7 effective capacity: base minus the active INTERDICT effects, floored at
 * 0. JAM never reduces capacity — it masks intel (RD-9). Supply (T019),
 * advance adjacency, and redeploy all read this rather than `link.capacity`.
 *
 * It lives here because issue #14's touch surface has no links module; it is a
 * candidate to move to its own module when #15 lands the supply BFS.
 */
export function effectiveCapacity(scenario: Scenario, state: GameState, linkId: string): number {
  const link = findLink(scenario, linkId);
  if (!link) {
    return 0;
  }
  const effects = state.links[linkId]?.effects ?? NO_EFFECTS;
  let interdicted = 0;
  for (const effect of effects) {
    if (effect.kind === "INTERDICT" && isActive(effect, state.turn)) {
      interdicted += 1;
    }
  }
  return Math.max(0, link.capacity - interdicted);
}

/**
 * RD-2a `linkReach(link, side)`: either endpoint controlled by the side, or
 * friendly presence ≥ 10 at either endpoint. Note it says nothing about
 * capacity — INTERDICT_LINK, SECURE_CORRIDOR, and JAMMING_CORRIDOR all remain
 * legal on a link already interdicted to 0.
 */
export function linkReach(
  scenario: Scenario,
  state: GameState,
  linkId: string,
  side: Side,
): boolean {
  const link = findLink(scenario, linkId);
  if (!link) {
    return false;
  }
  return [link.a, link.b].some(
    (regionId) =>
      controls(state, side, regionId) || presenceAt(state, side, regionId) >= REACH_PRESENCE,
  );
}

/**
 * The side-controlled regions joined to `regionId` by a link of effective
 * capacity ≥ 1 — RD-2a's advance adjacency — as their region states.
 *
 * Shared by legality and by the advance effect, which reads the same set to
 * decide its base strength (existential IN_SUPPLY). One definition, so a
 * target can never be legal by one adjacency rule and resolved by another.
 */
export function supportingRegions(
  scenario: Scenario,
  state: GameState,
  side: Side,
  regionId: string,
): RegionState[] {
  const sources: RegionState[] = [];
  for (const link of scenario.map.links) {
    const sourceId = otherEndpoint(link, regionId);
    if (sourceId === undefined) {
      continue;
    }
    const source = regionAt(state, sourceId);
    if (!source || source.control !== side) {
      continue;
    }
    if (effectiveCapacity(scenario, state, link.id) >= PASSABLE_CAPACITY) {
      sources.push(source);
    }
  }
  return sources;
}

/** RD-2a: unheld region joined to a held one by a link of capacity ≥ 1. */
function canAdvance(scenario: Scenario, state: GameState, side: Side, regionId: string): boolean {
  const region = regionAt(state, regionId);
  if (!region || region.control === side) {
    return false;
  }
  return supportingRegions(scenario, state, side, regionId).length > 0;
}

/** RD-2a: reachable, the stronger endpoint friendly ≥ 10, capacity ≥ 1. */
function canRedeploy(scenario: Scenario, state: GameState, side: Side, linkId: string): boolean {
  const link = findLink(scenario, linkId);
  if (!link) {
    return false;
  }
  const stronger = Math.max(presenceAt(state, side, link.a), presenceAt(state, side, link.b));
  return (
    linkReach(scenario, state, linkId, side) &&
    stronger >= REACH_PRESENCE &&
    effectiveCapacity(scenario, state, linkId) >= PASSABLE_CAPACITY
  );
}

/**
 * RD-2a/RD-5: held, unrest < 2, fort < 3.
 *
 * RD-2a's fourth clause — "fort not already raised this turn" — is deliberately
 * absent: it quantifies over what has happened *during* resolution, not over
 * pre-turn state, so it belongs to the resolver (T017) as a fizzle condition.
 * Adding it here would require per-turn bookkeeping in `GameState` that no
 * other rule needs.
 */
function canFortify(state: GameState, side: Side, regionId: string): boolean {
  const region = regionAt(state, regionId);
  return (
    region !== undefined &&
    region.control === side &&
    region.unrest < FORTIFY_UNREST_LIMIT &&
    region.fort < MAX_FORT
  );
}

/** Whether `targetId` is a legal target for `card` played by `side` right now. */
export function isLegalTarget(
  scenario: Scenario,
  state: GameState,
  side: Side,
  card: Card,
  targetId: string,
): boolean {
  // Exhaustive over the nine-card catalogue on purpose: a tenth card is a
  // typecheck failure here rather than a silently unplayable one.
  switch (card.id) {
    case "DELIBERATE_ADVANCE":
      return canAdvance(scenario, state, side, targetId);
    case "RAPID_REDEPLOY":
      return canRedeploy(scenario, state, side, targetId);
    case "FORTIFY_REGION":
      return canFortify(state, side, targetId);
    case "INTERDICT_LINK":
    case "SECURE_CORRIDOR":
    case "JAMMING_CORRIDOR":
      return linkReach(scenario, state, targetId, side);
    case "FOCUSED_ISR_SWEEP":
    case "SPOOF_CONTACTS":
      // "Any region" still means a region that exists (RD-2a).
      return regionAt(state, targetId) !== undefined;
    case "COUNTERINTEL_SWEEP":
      return controls(state, side, targetId);
  }
}

/**
 * Every catalogue card's legal targets for `side`, in map order.
 *
 * The entry set is the **catalogue**, not the hand: `SideView.legalTargets` is
 * `z.record(CardIdSchema, …)`, which requires a key per card id, and a view
 * greys out undealt cards rather than hiding them. A card with nothing to hit
 * maps to an empty array; the hand filter belongs to the caller (RD-3).
 */
export function legalTargets(
  scenario: Scenario,
  state: GameState,
  side: Side,
): Record<CardId, string[]> {
  const regionIds = scenario.map.regions.map((region) => region.id);
  const linkIds = scenario.map.links.map((link) => link.id);

  // Assembled key by key from the catalogue, so completeness is the scenario's
  // property, not this loop's — the single assertion is where that is assumed.
  const targets = {} as Record<CardId, string[]>;
  for (const card of scenario.cards) {
    const candidates = card.target === "REGION" ? regionIds : linkIds;
    targets[card.id] = candidates.filter((targetId) =>
      isLegalTarget(scenario, state, side, card, targetId),
    );
  }
  return targets;
}
