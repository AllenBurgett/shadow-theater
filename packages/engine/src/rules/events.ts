import type { Event, Side, Visibility } from "../contract/index.ts";
import { deepFreeze } from "../freeze.ts";

/**
 * Event emission for the rules layer.
 *
 * Zod-free by construction (only `import type` crosses the contract boundary):
 * rules modules produce plain objects and the contract schemas exist to
 * validate them at the wire edge, not in the hot path.
 *
 * The log owns two invariants that RD-9 depends on:
 *  - `seq` is monotonic per game and never reused;
 *  - `visibleTo` is stamped AT EMISSION from that turn's observability and
 *    copied, never aliased, so historical visibility can never change later;
 *    every emitted event is deep-frozen, so neither the stamp nor a nested
 *    payload can be rewritten after the fact.
 */

/** Envelope keys the log owns; a payload must not carry them. */
type EnvelopeKey = "v" | "seq" | "turn" | "visibleTo";

type WithoutEnvelope<E> = E extends unknown ? Omit<E, EnvelopeKey> : never;

/** Any event minus the envelope the log stamps — distributes over the union. */
export type EventPayload = WithoutEnvelope<Event>;

/** Per-side observability test; #14 builds the real predicates over state. */
export type VisibilityPredicate = (side: Side, payload: EventPayload) => boolean;

export interface EventLog {
  /**
   * Appends `payload` with the next `seq`, this log's `turn`, and `visibleTo`,
   * and returns the deep-frozen record. Note that freezing reaches into the
   * payload's own nested objects: emit a copy of anything still being built.
   */
  emit(payload: EventPayload, visibleTo: Visibility): Event;
  /** A frozen snapshot of everything emitted so far. */
  events(): readonly Event[];
  /** The `seq` the next `emit` will use — hand this to the next turn's log. */
  nextSeq(): number;
}

export interface EventLogOptions {
  /** The turn every event from this log is stamped with. */
  turn: number;
  /** The `seq` to start at; 1 for the `gameCreated` header. */
  nextSeq: number;
}

const SIDES: readonly Side[] = ["BLUE", "RED"];

/** Builds a `Visibility` from a per-side predicate. */
export function visibility(observer: (side: Side) => boolean): Visibility {
  return { BLUE: observer("BLUE"), RED: observer("RED") };
}

/** Globally visible outcomes: game end, posture-band changes (RD-9). */
export function visibleToAll(): Visibility {
  return { BLUE: true, RED: true };
}

/** Evaluation evidence that is never player-facing, e.g. `redOrdersSource`. */
export function visibleToNone(): Visibility {
  return { BLUE: false, RED: false };
}

/** Acting-side-only disclosure, e.g. `orderFizzled` (analysis A23). */
export function visibleToOnly(side: Side): Visibility {
  return { BLUE: side === "BLUE", RED: side === "RED" };
}

/**
 * Computes a payload's `visibleTo` with a predicate that may inspect the
 * payload itself (an event's region or link decides who observed it).
 */
export function stampVisibility(payload: EventPayload, predicate: VisibilityPredicate): Visibility {
  return {
    BLUE: predicate("BLUE", payload),
    RED: predicate("RED", payload),
  };
}

/** True when every side in `visibleTo` is false — a purely internal record. */
export function isHidden(visibleTo: Visibility): boolean {
  return SIDES.every((side) => !visibleTo[side]);
}

/** Creates an append-only event log for one turn's resolution. */
export function createEventLog(options: EventLogOptions): EventLog {
  const { turn } = options;
  let seq = options.nextSeq;
  const emitted: Event[] = [];

  return {
    emit(payload: EventPayload, visibleTo: Visibility): Event {
      // The spread reassembles a specific union member; TypeScript cannot
      // track that through a distributive `Omit`, so the envelope is
      // reattached with a single assertion at the one place that owns it.
      //
      // Deep-frozen at emission, not merely copied: the spread is shallow, so
      // without this a caller holding the returned event (or the array it
      // passed in) could rewrite recorded history — flip a `visibleTo` stamp
      // or edit an `ordersAccepted` operation list, which is replay input.
      const event = deepFreeze({
        ...payload,
        v: 1,
        seq,
        turn,
        visibleTo: { BLUE: visibleTo.BLUE, RED: visibleTo.RED },
      } as Event);
      seq += 1;
      emitted.push(event);
      return event;
    },
    events(): readonly Event[] {
      return Object.freeze([...emitted]);
    },
    nextSeq(): number {
      return seq;
    },
  };
}
