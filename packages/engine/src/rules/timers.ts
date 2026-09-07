import type { Contact, Control, GameState, LinkEffect, Side } from "../contract/index.ts";
import { resolveControl } from "./control.ts";
import { isActive } from "./legality.ts";
import type { ControlChange } from "./state.ts";
import {
  OBSERVED_INTEL_AGE,
  UNOBSERVED_INTEL_AGE,
  withContacts,
  withLink,
  withRegion,
  withSide,
} from "./state.ts";

/**
 * Timers, decay, the whole-board control recompute, and unrest — RD-1 phases 5
 * to 7 minus attrition, which belongs with the supply ladder that decides it
 * (`supply.ts`).
 *
 * Pure like every other rules module: each step returns the next `GameState`
 * and reports what changed as data; the resolver owns the event log.
 *
 * RD-1 lists "unrest bookkeeping" inside phase 5 *and* "unrest evaluation" as
 * phase 7. Only the phase-7 entry can be right: RD-5 defines every unrest
 * transition against **turn-end control**, which does not exist until phase
 * 6's recompute has run. The phase-5 mention is inherited from the prototype's
 * `decayAndTimers`, which had no separate control phase to read. Unrest is
 * therefore evaluated exactly once, in `evaluateUnrest`, and phase 5 does not
 * touch it.
 *
 * `lastController` is never written here. RD-8 writes it once at the very end
 * of evaluation, after unrest (below) and the constraint penalty have both
 * read it (review N7); until that lands, nobody writes it and every region
 * still carries the value `createGame` seeded.
 */

/** A link effect that reached its expiry turn, for `linkEffectExpired`. */
export interface ExpiredLinkEffect {
  linkId: string;
  effect: LinkEffect;
}

export interface LinkExpiryResult {
  state: GameState;
  expired: ExpiredLinkEffect[];
}

export interface ContactExpiryResult {
  state: GameState;
  expired: Contact[];
}

export interface ControlRecomputeResult {
  state: GameState;
  changes: ControlChange[];
}

/** An unrest transition, for the resolver's `unrestChanged`. */
export interface UnrestChange {
  regionId: string;
  from: number;
  to: number;
}

export interface UnrestResult {
  state: GameState;
  changes: UnrestChange[];
}

const SIDES: readonly Side[] = ["BLUE", "RED"];

/** RD-5: unrest is bounded 0..3, matching `RegionStateSchema`. */
const MIN_UNREST = 0;
const MAX_UNREST = 3;

/**
 * Removes every link effect whose expiry turn has arrived (RD-7).
 *
 * The predicate is `isActive`, the same one `effectiveCapacity` applies, so an
 * effect is inert and removed on exactly the same turn — capacity restores
 * because the effect is gone, never because a stored base was edited back up
 * (the prototype's permanent `capacity -= 1` is the deviation this fixes).
 */
export function expireLinkEffects(state: GameState): LinkExpiryResult {
  let next = state;
  const expired: ExpiredLinkEffect[] = [];
  for (const [linkId, link] of Object.entries(state.links)) {
    const kept = link.effects.filter((effect) => isActive(effect, state.turn));
    if (kept.length === link.effects.length) {
      continue;
    }
    for (const effect of link.effects) {
      if (!isActive(effect, state.turn)) {
        expired.push({ linkId, effect });
      }
    }
    next = withLink(next, linkId, { ...link, effects: kept });
  }
  return { state: next, expired };
}

/**
 * Retires contacts on the same predicate as link effects (RD-2a, RD-7).
 *
 * RD-2a states one timing rule covering "link/contact effect timing", so a
 * contact created on turn t with `expiresTurn = t + 2` is active at turn ends
 * t and t+1 and gone here on t+2. The prototype filtered on
 * `expiresTurn >= turn` and kept rumors a turn longer than the card text
 * promised (mechanics-inventory §9); that split is the recorded deviation.
 */
export function expireContacts(state: GameState): ContactExpiryResult {
  const expired = state.contacts.filter((contact) => !isActive(contact, state.turn));
  if (expired.length === 0) {
    return { state, expired };
  }
  return {
    state: withContacts(
      state,
      state.contacts.filter((contact) => isActive(contact, state.turn)),
    ),
    expired,
  };
}

/**
 * Ages every region's intel for both sides (RD-9).
 *
 * One atomic step, not two passes: each region's new age is a function of
 * pre-phase state alone, so "increment everything, then zero what was
 * observed" cannot be got the wrong way round. A turn-N sweep therefore reads
 * age 0 — CONFIRMED — in the next view, which is what review M8/N3 is about;
 * an implementation that incremented a live record after the sweep had zeroed
 * it would render LIKELY and make CONFIRMED unreachable.
 *
 * Observed means own presence > 0 *as presence stands when this runs* — RD-1
 * puts aging ahead of attrition, so a garrison still holds its own eyes on the
 * region this turn — plus the regions `observed` carries: those advanced into
 * and those ISR-swept. Those two facts are produced in the ops phases and
 * cannot be recovered from state here, so the resolver collects them.
 */
export function ageIntel(
  state: GameState,
  observed: Readonly<Record<Side, ReadonlySet<string>>>,
): GameState {
  let next = state;
  for (const side of SIDES) {
    const sideState = state.sides[side];
    const intelAge: Record<string, number> = {};
    for (const [regionId, region] of Object.entries(state.regions)) {
      const seen = region.presence[side] > 0 || observed[side].has(regionId);
      // A region the record has never heard of reads unobserved rather than
      // starting from 0; `createGame` fills every region, so this is a
      // state/scenario mismatch, not a reachable position.
      const previous = sideState.intelAge[regionId] ?? UNOBSERVED_INTEL_AGE;
      intelAge[regionId] = seen ? OBSERVED_INTEL_AGE : previous + 1;
    }
    next = withSide(next, side, { ...sideState, intelAge });
  }
  return next;
}

/**
 * RD-1 phase 6: re-resolves control for **every** region after attrition
 * (RD-13). Its result is the turn-end control RD-5 reads below, and that RD-8
 * and RD-11 will read in the later phases.
 *
 * More `controlChanged` events in the same turn than the inline re-resolves an
 * operation already produced is correct, not duplication: an inline flip
 * records what an operation did, this records what the turn's whole ledger of
 * presence — advances, redeploys, and attrition together — settled on.
 */
export function recomputeAllControl(state: GameState): ControlRecomputeResult {
  let next = state;
  const changes: ControlChange[] = [];
  for (const [regionId, region] of Object.entries(state.regions)) {
    const to = resolveControl(region.presence);
    if (to === region.control) {
      continue;
    }
    changes.push({ regionId, from: region.control, to });
    next = withRegion(next, regionId, { ...region, control: to });
  }
  return { state: next, changes };
}

/**
 * RD-5's per-turn unrest delta for one region.
 *
 * The four clauses are **independent additive terms**, not a first-match
 * ladder, so nothing about the outcome depends on the order they are tested
 * in. RD-5 phrases them that way — "+1 **when** the controller changes" is an
 * event, "+1/turn **while** CONTESTED" and "−1/turn **while** stably
 * controlled" are rates, and NEUTRAL regions "**also** decay". Two
 * consequences are worth naming because RD-5 does not spell them out:
 *
 *  - a held region falling into contest scores the change *and* the contest,
 *    +2 — a front opening in a quiet province is the sharpest shock the rule
 *    can register, and it is one turn from any level to the 3 ceiling;
 *  - a region abandoned to NEUTRAL scores +1 and −1 and nets zero — the
 *    agitation of losing the garrison against the calm of nobody holding it.
 *
 * The stable term is the only one that is exclusive by construction: RD-5
 * defines it as controlled by a side at *both* turn ends and not CONTESTED,
 * which cannot coincide with a change.
 */
function unrestDelta(control: Control, lastController: Control): number {
  let delta = 0;
  if (control !== lastController) {
    delta += 1;
  }
  if (control === "CONTESTED") {
    delta += 1;
  }
  if (control === lastController && (control === "BLUE" || control === "RED")) {
    delta -= 1;
  }
  if (control === "NEUTRAL") {
    delta -= 1;
  }
  return delta;
}

/**
 * RD-1 phase 7: applies RD-5 to every region, reading phase 6's turn-end
 * control against `lastController` — the previous turn end — and clamping to
 * 0..3. Only a real transition is reported; a region already at a rail moves
 * nothing and emits nothing.
 */
export function evaluateUnrest(state: GameState): UnrestResult {
  let next = state;
  const changes: UnrestChange[] = [];
  for (const [regionId, region] of Object.entries(state.regions)) {
    const delta = unrestDelta(region.control, region.lastController);
    const to = Math.min(MAX_UNREST, Math.max(MIN_UNREST, region.unrest + delta));
    if (to === region.unrest) {
      continue;
    }
    changes.push({ regionId, from: region.unrest, to });
    next = withRegion(next, regionId, { ...region, unrest: to });
  }
  return { state: next, changes };
}
