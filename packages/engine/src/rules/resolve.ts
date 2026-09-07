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
import { evaluateEnding } from "./endings.ts";
import type { EventLog } from "./events.ts";
import { createEventLog, visibleToAll, visibleToOnly } from "./events.ts";
import { drawHands } from "./hands.ts";
import { counterintelSweep, focusedIsrSweep, jammingCorridor, spoofContacts } from "./info.ts";
import { findCard, isLegalTarget } from "./legality.ts";
import { evaluateObjectives } from "./objectives.ts";
import { politicalUpkeep, writeLastController } from "./political.ts";
import type { OpOutcome } from "./state.ts";
import { applyAttrition, recomputeSupply } from "./supply.ts";
import {
  deliberateAdvance,
  fortifyRegion,
  interdictLink,
  rapidRedeploy,
  secureCorridor,
} from "./surface.ts";
import {
  ageIntel,
  evaluateUnrest,
  expireContacts,
  expireLinkEffects,
  recomputeAllControl,
} from "./timers.ts";
import { validateOrders } from "./validate.ts";

/**
 * Turn resolution (RD-1; engine-api `resolveTurn`).
 *
 * RD-1's phase order, and where each phase lives:
 *
 *  1. validate both order sets against pre-turn state — here
 *  2. info ops (INFO domain)                          — here
 *  3. surface ops (SURFACE domain)                    — here
 *  4. supply recompute                                — `supply.ts`
 *  5. timers/decay (link effects, contact expiry,
 *     intel aging, attrition)                         — `timers.ts` + `supply.ts`
 *  6. control recompute (all regions, RD-13)          — `timers.ts`
 *  7. unrest evaluation (RD-5)                        — `timers.ts`
 *  8. political upkeep (RD-4, RD-8)                   — `political.ts`
 *  9. objective evaluation (RD-11)                    — `objectives.ts`
 * 10. game-over evaluation (FR-012)                   — `endings.ts`
 * 11. turn increment (skipped once the game ends)     — here
 *
 * RD-8's `lastController` write is not one of RD-1's phases: it is the last
 * act of evaluation, sitting between phase 10 and the increment, because two
 * phases above it read the value it overwrites (review N7).
 *
 * RD-1's phase-5 parenthetical also names "unrest bookkeeping"; `timers.ts`
 * records why that is vestigial — RD-5 reads turn-end control, so unrest can
 * only be evaluated after phase 6, and it is evaluated exactly once.
 *
 * RD-1's phase list is complete as of issue #15: a resolved turn runs every
 * phase, and the ending it may produce is computed once here and stored, never
 * recomputed by a view (FR-012).
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
  /**
   * RD-9's per-side "observed this turn" regions beyond own presence: those
   * advanced into and those ISR-swept. Both facts are made in the ops phases
   * and read by phase 5's intel aging, and neither survives in `GameState` —
   * a sweep's age 0 is about to be incremented, and an advance's presence may
   * be attritioned away — so the resolver carries them rather than the
   * operation modules changing shape to return them.
   */
  observed: Record<Side, Set<string>>;
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
    observed: { BLUE: new Set<string>(), RED: new Set<string>() },
    rumor: {
      BLUE: createRng(state.seed).fork(`rumor:BLUE:${turn}`),
      RED: createRng(state.seed).fork(`rumor:RED:${turn}`),
    },
  };

  // Phase 2 — info ops, then phase 3 — surface ops (RD-1/RD-2a domain column).
  let next = resolvePhase(context, state, orders, order, "INFO");
  next = resolvePhase(context, next, orders, order, "SURFACE");

  // Phase 4 — supply recompute (RD-12).
  next = applySupply(context, next);
  // Phase 5 — timers/decay (RD-7, RD-9, RD-12).
  next = applyTimers(context, next);
  // Phase 6 — control recompute over every region (RD-13).
  next = applyControlRecompute(context, next);
  // Phase 7 — unrest evaluation (RD-5), on phase 6's turn-end control.
  next = applyUnrest(context, next);

  // Phase 8 — political upkeep and the RD-8 constraint (RD-4, RD-5, RD-8).
  next = applyPolitical(context, next);

  // Phase 9 — objective evaluation (RD-11).
  next = applyObjectives(context, next);
  // Phase 10 — game-over evaluation, pre-increment (FR-012, RD-11).
  next = applyEnding(context, next);

  // End of evaluation — RD-8's `lastController` snapshot (review N7).
  //
  // ORDERING WARNING: every phase that reads the previous turn's control
  // belongs ABOVE this line, never below it — RD-5's unrest comparison in
  // phase 7, RD-8's habitat-loss penalty in phase 8, and any later rule that
  // quantifies over turn-end control. Moving the write up would blank those
  // rules silently, with no test of theirs failing to say so.
  next = writeLastController(next);

  // Phase 11 — turn increment, skipped once the game has ended (RD-1). A
  // finished game therefore keeps the turn its ending landed on, which is what
  // `GameOverRecord.endedOnTurn` says, and draws no hand nobody will play.
  if (next.gameOver === null) {
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
  }

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

  // RD-9's two non-presence observations. Recorded only for an operation that
  // actually applied: an advance or a sweep that fizzled observed nothing.
  if (card.id === "DELIBERATE_ADVANCE" || card.id === "FOCUSED_ISR_SWEEP") {
    context.observed[side].add(targetId);
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

/**
 * Phase 4 (RD-12): reassigns supply for every region and side.
 *
 * `supplyChanged` is stamped to the side it describes — `RegionView` exposes
 * `ownSupply` only, so an enemy supply state is not a disclosed fact. Like
 * #14's operation events these stamps are the conservative reading until T024
 * (issue #16) builds the real observability model.
 */
function applySupply(context: TurnContext, state: GameState): GameState {
  const { state: next, changes } = recomputeSupply(context.scenario, state);
  for (const change of changes) {
    context.log.emit(
      {
        kind: "supplyChanged",
        regionId: change.regionId,
        side: change.side,
        from: change.from,
        to: change.to,
      },
      visibleToOnly(change.side),
    );
  }
  return next;
}

/**
 * Phase 5 (RD-7, RD-9, RD-12), in the order RD-1 lists it: link effects,
 * contact expiry, intel aging, attrition.
 *
 * That order is load-bearing in exactly one place. Aging reads "own presence
 * > 0" as presence stands when it runs, so putting it ahead of attrition means
 * a garrison attrition wipes out this turn still observed its region this
 * turn. The two expiries commute with everything else here — nothing in this
 * phase reads a link effect or a contact.
 *
 * Payloads are deep-copied before emission: the log deep-freezes what it is
 * handed, and these objects are still reachable from the state the caller
 * passed in. `structuredClone` rather than a spread even where the payload is
 * flat today -- a spread is correct only for as long as the shape stays flat,
 * and a nested field added later would reintroduce the freeze-live-state bug
 * silently, with no test of ours failing to say so.
 */
function applyTimers(context: TurnContext, state: GameState): GameState {
  const links = expireLinkEffects(state);
  for (const { linkId, effect } of links.expired) {
    context.log.emit(
      { kind: "linkEffectExpired", linkId, effect: structuredClone(effect) },
      visibleToOnly(effect.side),
    );
  }

  const contacts = expireContacts(links.state);
  for (const contact of contacts.expired) {
    context.log.emit(
      { kind: "contactExpired", contact: structuredClone(contact) },
      visibleToOnly(contact.side),
    );
  }

  const aged = ageIntel(contacts.state, context.observed);

  const attrition = applyAttrition(aged);
  for (const loss of attrition.losses) {
    context.log.emit(
      { kind: "attrition", regionId: loss.regionId, side: loss.side, amount: loss.amount },
      visibleToOnly(loss.side),
    );
  }
  return attrition.state;
}

/** Phase 6 (RD-13); control is fully disclosed in M1, so the flips are global. */
function applyControlRecompute(context: TurnContext, state: GameState): GameState {
  const { state: next, changes } = recomputeAllControl(state);
  for (const change of changes) {
    context.log.emit(
      { kind: "controlChanged", regionId: change.regionId, from: change.from, to: change.to },
      visibleToAll(),
    );
  }
  return next;
}

/** Phase 7 (RD-5); `RegionView` carries unrest for both sides, as it does control. */
function applyUnrest(context: TurnContext, state: GameState): GameState {
  const { state: next, changes } = evaluateUnrest(state);
  for (const change of changes) {
    context.log.emit(
      { kind: "unrestChanged", regionId: change.regionId, from: change.from, to: change.to },
      visibleToAll(),
    );
  }
  return next;
}

/**
 * Phase 8 (RD-4, RD-8): charges both sides their political upkeep.
 *
 * `politicalChanged` carries the exact value, which SC-003 forbids disclosing
 * to the enemy, so it is stamped acting-side-only pending T024's observability
 * model (issue #16). `postureChanged` is the coarse figure both sides are
 * meant to see, and RD-9 lists posture-band changes among the globally visible
 * outcomes, so it is stamped to all.
 */
function applyPolitical(context: TurnContext, state: GameState): GameState {
  const { state: next, drains, postures } = politicalUpkeep(context.scenario, state);
  for (const drain of drains) {
    context.log.emit(
      {
        kind: "politicalChanged",
        side: drain.side,
        from: drain.from,
        to: drain.to,
        cause: drain.cause,
      },
      visibleToOnly(drain.side),
    );
  }
  for (const posture of postures) {
    context.log.emit(
      { kind: "postureChanged", side: posture.side, band: posture.band },
      visibleToAll(),
    );
  }
  return next;
}

/**
 * Phase 9 (RD-11): evaluates every objective against the turn end.
 *
 * `objectiveCompleted` is stamped acting-side-only for now. RD-9 makes a
 * *public* objective's completion enemy-visible while a secret one stays
 * hidden, and that split needs the observability model T024/T025 builds
 * (issue #16); under-disclosure is the safe default until then.
 */
function applyObjectives(context: TurnContext, state: GameState): GameState {
  const { state: next, completions } = evaluateObjectives(context.scenario, state);
  for (const completion of completions) {
    const objective = context.scenario.objectives[completion.side].find(
      (entry) => entry.id === completion.objectiveId,
    );
    context.log.emit(
      {
        kind: "objectiveCompleted",
        objectiveId: completion.objectiveId,
        side: completion.side,
        // `evaluateObjectives` only ever completes an objective it read from
        // this same scenario, so the fallback is unreachable and is the one
        // branch here coverage cannot exercise; the type cannot know that.
        points: objective?.points ?? 0,
      },
      visibleToOnly(completion.side),
    );
  }
  return next;
}

/**
 * Phase 10 (FR-012, RD-11): computes the ending once and stores it.
 *
 * A state that already carries a `gameOver` is left exactly as it is — the
 * record is written once and never recomputed, which is the whole point of
 * storing it (the prototype recomputed it per view and drifted). Resolving
 * another turn on a finished game is a caller error, not a game outcome, so it
 * neither re-decides the ending nor emits a second `gameEnded`.
 */
function applyEnding(context: TurnContext, state: GameState): GameState {
  if (state.gameOver !== null) {
    return state;
  }
  const record = evaluateEnding(context.scenario, state);
  if (record === null) {
    return state;
  }
  // Deep-copied before emission, not spread: the log freezes everything
  // *reachable* from the payload, and `GameOverRecord` nests a `points`
  // object. A shallow copy hands over a new outer record whose `points` is
  // still the very object the state below stores, so emission would freeze
  // live state through it — the one field of the returned `GameState` that is
  // frozen while every region beside it is not.
  context.log.emit({ kind: "gameEnded", record: structuredClone(record) }, visibleToAll());
  return { ...state, gameOver: record };
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
