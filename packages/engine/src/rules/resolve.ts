import type {
  Card,
  Event,
  GameState,
  Operation,
  OrderRejection,
  OrderSet,
  Scenario,
  Side,
} from "../contract/index.ts";
import type { Rng } from "../rng.ts";
import { createRng } from "../rng.ts";
import type { EventLog } from "./events.ts";
import { createEventLog, visibleToAll, visibleToOnly } from "./events.ts";
import { drawHands } from "./hands.ts";
import { counterintelSweep, focusedIsrSweep, jammingCorridor, spoofContacts } from "./info.ts";
import { findCard, isLegalTarget } from "./legality.ts";
import type { OpOutcome } from "./state.ts";
import {
  deliberateAdvance,
  fortifyRegion,
  interdictLink,
  rapidRedeploy,
  secureCorridor,
} from "./surface.ts";
import { validateOrders } from "./validate.ts";

/**
 * Turn resolution (RD-1; engine-api `resolveTurn`).
 *
 * RD-1's phase order, and where each phase lives:
 *
 *  1. validate both order sets against pre-turn state — here
 *  2. info ops (INFO domain)                          — here
 *  3. surface ops (SURFACE domain)                    — here
 *  4. supply recompute                                — T019, issue #15
 *  5. timers/decay (link effects, contact expiry,
 *     intel aging, unrest bookkeeping, attrition)     — T020, issue #15
 *  6. control recompute (all regions, RD-13)          — T021, issue #15
 *  7. unrest evaluation (RD-5)                        — T021, issue #15
 *  8. political upkeep (RD-4, RD-8)                   — T022, issue #15
 *  9. objective evaluation (RD-11)                    — T023, issue #15
 * 10. game-over evaluation (FR-012)                   — T023, issue #15
 * 11. turn increment (skipped once the game ends)     — here
 *
 * Phases 4–10 are absent, not stubbed: the body carries a numbered gap for
 * each so #15 lands its phase where RD-1 puts it, and nothing silently
 * "passes" a phase that does not exist yet. **Until they land, a resolved turn
 * moves presence, forts, link effects and contacts and nothing else** — no
 * supply, attrition, unrest, political drain, scoring, or ending.
 */

/** The seq the very first event of a game takes (the `gameCreated` header). */
const FIRST_SEQ = 1;

/**
 * Where turn 1 starts numbering. `gameCreated` is a mandatory header at
 * `FIRST_SEQ`, so seq 1 is spoken for in every real stream and the first
 * resolved turn legitimately begins after it — defaulting to `FIRST_SEQ` would
 * collide with the header the stream owner is required to emit, and `seq` is
 * monotonic per game and part of the replay format, so a duplicate corrupts
 * rather than merely repeats.
 */
const FIRST_TURN_SEQ = FIRST_SEQ + 1;

export interface TurnOrders {
  BLUE: OrderSet;
  RED: OrderSet;
}

export interface TurnResult {
  state: GameState;
  events: Event[];
}

/**
 * Thrown when an order set fails FR-005 validation against pre-turn state.
 *
 * Rejection is a whole-set outcome with no state change, and engine-api types
 * `resolveTurn` as returning `{state, events}` with no rejection channel — so
 * callers validate first (the server does, before committing) and reaching
 * resolution with an invalid set is a programming error, not a game outcome.
 * Distinct from a fizzle, which is a per-operation resolution outcome.
 */
export class OrderValidationError extends Error {
  readonly side: Side;
  readonly rejection: OrderRejection;

  constructor(side: Side, rejection: OrderRejection) {
    super(
      `${side} order set is invalid: ${rejection.violations
        .map((violation) => violation.code)
        .join(", ")}`,
    );
    this.name = "OrderValidationError";
    this.side = side;
    this.rejection = rejection;
  }
}

/**
 * Thrown when a `TurnOrders` key disagrees with the `OrderSet.side` it holds.
 *
 * `validateOrders` keys off `orders.side` while resolution keys off the
 * property the set is filed under, so `{BLUE: {side: "RED", …}}` would check
 * RED's hand and budgets and then resolve the operations as BLUE. Like an
 * invalid set arriving here, that is a routing mistake in the caller, not a
 * game outcome.
 */
export class OrderSideMismatchError extends Error {
  /** The `TurnOrders` property the set was filed under. */
  readonly key: Side;
  /** The side the set itself declares. */
  readonly declared: Side;

  constructor(key: Side, declared: Side) {
    super(`Order set filed under ${key} declares side ${declared}`);
    this.name = "OrderSideMismatchError";
    this.key = key;
    this.declared = declared;
  }
}

/** RD-1: BLUE on odd turns, RED on even — derived from the turn, never stored. */
export function initiativeFor(turn: number): Side {
  return turn % 2 === 1 ? "BLUE" : "RED";
}

/** Turn-scoped state the phases share but `GameState` deliberately does not hold. */
interface TurnContext {
  scenario: Scenario;
  log: EventLog;
  /** RD-2a's +1-fort-per-region-per-turn cap; per turn, not per side. */
  fortified: Set<string>;
  /** RD-9 rumor substreams, forked once per side per turn (one draw per contact). */
  rumor: Record<Side, Rng>;
}

/**
 * Resolves one turn.
 *
 * `nextSeq` continues the per-game event sequence (data-model: `seq` is
 * monotonic per game, starting at 1 with `gameCreated`). It is a parameter
 * because neither `GameState` nor engine-api's signature carries the counter.
 * The default is only right for the first turn of a stream whose header sits
 * at seq 1: a caller that stores the stream passes the previous turn's
 * `log.nextSeq()` rather than relying on it.
 */
export function resolveTurn(
  scenario: Scenario,
  state: GameState,
  orders: TurnOrders,
  nextSeq: number = FIRST_TURN_SEQ,
): TurnResult {
  const turn = state.turn;
  const initiative = initiativeFor(turn);
  const order: readonly Side[] = initiative === "BLUE" ? ["BLUE", "RED"] : ["RED", "BLUE"];

  // Routing first: everything below reads the hand and budgets through
  // `orders.side` but applies effects as the key, so the two must agree.
  for (const side of order) {
    if (orders[side].side !== side) {
      throw new OrderSideMismatchError(side, orders[side].side);
    }
  }

  // Phase 1 — validation against pre-turn state (FR-005, RD-2/RD-6).
  for (const side of order) {
    const result = validateOrders(scenario, state, orders[side]);
    if (!result.ok) {
      throw new OrderValidationError(side, result.rejection);
    }
  }

  const log = createEventLog({ turn, nextSeq });
  log.emit({ kind: "turnStarted", initiative }, visibleToAll());
  for (const side of order) {
    log.emit(
      { kind: "ordersAccepted", side, operations: structuredClone(orders[side].operations) },
      visibleToOnly(side),
    );
  }

  const context: TurnContext = {
    scenario,
    log,
    fortified: new Set<string>(),
    rumor: {
      BLUE: createRng(state.seed).fork(`rumor:BLUE:${turn}`),
      RED: createRng(state.seed).fork(`rumor:RED:${turn}`),
    },
  };

  // Phase 2 — info ops, then phase 3 — surface ops (RD-1/RD-2a domain column).
  let next = resolvePhase(context, state, orders, order, "INFO");
  next = resolvePhase(context, next, orders, order, "SURFACE");

  // Phase 4 — supply recompute (RD-12) — T019, issue #15.
  // Phase 5 — timers/decay (RD-7, RD-9, RD-12) — T020, issue #15.
  // Phase 6 — control recompute over every region (RD-13) — T021, issue #15.
  // Phase 7 — unrest evaluation (RD-5) — T021, issue #15.
  // Phase 8 — political upkeep and the RD-8 constraint — T022, issue #15.
  // Phase 9 — objective evaluation (RD-11) — T023, issue #15.
  // Phase 10 — game-over evaluation (FR-012) — T023, issue #15.

  // Phase 11 — turn increment. RD-1 skips it once the game has ended, which
  // needs phase 10; #15 gates it on `next.gameOver`.
  const upcoming = next.turn + 1;
  const hands = drawHands(scenario, next.seed, upcoming);
  next = {
    ...next,
    turn: upcoming,
    sides: {
      BLUE: { ...next.sides.BLUE, hand: hands.BLUE },
      RED: { ...next.sides.RED, hand: hands.RED },
    },
  };

  return { state: next, events: [...log.events()] };
}

/** One ops phase: initiative side's operations in submitted order, then the other's. */
function resolvePhase(
  context: TurnContext,
  state: GameState,
  orders: TurnOrders,
  order: readonly Side[],
  domain: Card["domain"],
): GameState {
  let current = state;
  for (const side of order) {
    for (const operation of orders[side].operations) {
      const card = findCard(context.scenario, operation.cardId);
      // Validation resolved every card against this same scenario, so the
      // undefined case is unreachable; the type cannot know that.
      if (!card || card.domain !== domain) {
        continue;
      }
      current = resolveOperation(context, current, side, card, operation);
    }
  }
  return current;
}

/**
 * Resolves one operation against current state.
 *
 * RD-1: legality is re-checked here, not trusted from validation, because an
 * earlier operation this turn may have invalidated it. There are two fizzle
 * sources — the re-check failing, and the operation itself refusing
 * (`applied: false`, e.g. RD-2a's fort cap) — and both record `orderFizzled`.
 */
function resolveOperation(
  context: TurnContext,
  state: GameState,
  side: Side,
  card: Card,
  operation: Operation,
): GameState {
  const targetId = operation.target.id;

  if (!isLegalTarget(context.scenario, state, side, card, targetId)) {
    fizzle(context, side, card, operation, `"${targetId}" is no longer a legal ${card.id} target`);
    return state;
  }

  const outcome = applyOperation(context, state, side, card, operation);
  if (!outcome.applied) {
    fizzle(context, side, card, operation, outcome.reason);
    return state;
  }

  if (card.id === "FORTIFY_REGION") {
    context.fortified.add(targetId);
  }

  // Cloned before emission: the log deep-freezes what it is handed, and an
  // effect's `contact`/`effect` payload is the very object that also sits in
  // the returned state. History must never freeze live state, nor alias it.
  const effects = structuredClone(outcome.effects);
  context.log.emit(
    {
      kind: "orderApplied",
      side,
      cardId: card.id,
      target: { ...operation.target },
      effects,
    },
    // Acting side only: RD-9 requires an enemy operation to surface as what
    // changed on the board, never as which card was played.
    visibleToOnly(side),
  );

  // The data-model gives these board facts their own event kinds; emitting
  // them only inside `orderApplied.effects` would bury them behind an
  // acting-side-only record. Both directions are emitted — an addition that
  // surfaced on its own while its removal did not would be exactly the
  // asymmetry this loop exists to avoid. These are the *operation-driven*
  // removals; `linkEffectExpired` and `contactExpired` are the timers-phase
  // kinds and belong to T020 (issue #15). Stamped conservatively for now —
  // the full observability model is T024 (issue #16).
  //
  // `presenceChanged`, `fortChanged` and `intelRefreshed` have no event kind
  // of their own in the union, so they stay inside `orderApplied.effects`.
  for (const effect of effects) {
    if (effect.kind === "linkEffectAdded") {
      context.log.emit(
        { kind: "linkEffectAdded", linkId: effect.linkId, effect: effect.effect },
        visibleToOnly(side),
      );
    } else if (effect.kind === "linkEffectRemoved") {
      context.log.emit(
        { kind: "linkEffectRemoved", linkId: effect.linkId, effect: effect.effect },
        visibleToOnly(side),
      );
    } else if (effect.kind === "contactCreated") {
      context.log.emit({ kind: "contactCreated", contact: effect.contact }, visibleToOnly(side));
    } else if (effect.kind === "contactRemoved") {
      context.log.emit({ kind: "contactRemoved", contact: effect.contact }, visibleToOnly(side));
    }
  }

  // Control is fully disclosed to both sides in M1 (RD-9), so an inline
  // re-resolve is globally visible even though the operation behind it is not.
  for (const change of outcome.controlChanges) {
    context.log.emit(
      { kind: "controlChanged", regionId: change.regionId, from: change.from, to: change.to },
      visibleToAll(),
    );
  }

  return outcome.state;
}

/** Records a skipped operation (RD-1); visible to the acting side only (A23). */
function fizzle(
  context: TurnContext,
  side: Side,
  card: Card,
  operation: Operation,
  reason: string,
): void {
  context.log.emit(
    {
      kind: "orderFizzled",
      side,
      cardId: card.id,
      target: { ...operation.target },
      reason,
    },
    visibleToOnly(side),
  );
}

/** Dispatches a card to its effect (RD-2a); exhaustive over the catalogue. */
function applyOperation(
  context: TurnContext,
  state: GameState,
  side: Side,
  card: Card,
  operation: Operation,
): OpOutcome {
  const targetId = operation.target.id;
  const { scenario } = context;

  switch (card.id) {
    case "DELIBERATE_ADVANCE":
      return deliberateAdvance(scenario, state, side, targetId);
    case "RAPID_REDEPLOY":
      return rapidRedeploy(scenario, state, side, targetId);
    case "FORTIFY_REGION":
      return fortifyRegion(state, targetId, context.fortified);
    case "INTERDICT_LINK":
      return interdictLink(state, side, targetId);
    case "SECURE_CORRIDOR":
      return secureCorridor(state, side, targetId);
    case "FOCUSED_ISR_SWEEP":
      return focusedIsrSweep(state, side, targetId);
    case "JAMMING_CORRIDOR":
      return jammingCorridor(state, side, targetId);
    case "SPOOF_CONTACTS":
      return spoofContacts(state, side, targetId, operation.theme, context.rumor[side]);
    case "COUNTERINTEL_SWEEP":
      return counterintelSweep(state, side, targetId);
  }
}
