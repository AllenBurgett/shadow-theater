import type { GameOverRecord, GameState, Scenario, Side, Winner } from "../contract/index.ts";
import { pointsFor } from "./objectives.ts";

/**
 * The endings ladder (RD-11; RD-1 phase 10, FR-012).
 *
 * A pure read over turn-end state: it decides nothing about the board and
 * writes nothing. The resolver stores the record it returns in
 * `GameState.gameOver` **once** and emits `gameEnded`; views read the stored
 * record and never recompute it (FR-012 — the prototype's game-over recompute
 * drift is the deviation this fixes).
 *
 * Evaluated **pre-increment**, so an ending lands ON the turn it fires and
 * `turn >= scenario.turnLimit` is the turn limit itself, not the turn after.
 *
 * The four rungs are ordered and the order is load-bearing, not incidental:
 * the symmetric no-op game reaches mutual collapse on turn 16, which is also
 * the turn limit, so a ladder that tested the turn limit first would report
 * TURN_LIMIT for a match both sides actually lost.
 */

const SIDES: readonly Side[] = ["BLUE", "RED"];

/** A side is wiped out when it holds no presence anywhere (RD-11). */
const WIPEOUT_PRESENCE = 0;

/** RD-4 collapse: capital is unclamped, so a collapsed side may be negative. */
const COLLAPSE_POLITICAL = 0;

/** A side's presence summed across the whole map. */
export function totalPresence(state: GameState, side: Side): number {
  let total = 0;
  for (const region of Object.values(state.regions)) {
    total += region.presence[side];
  }
  return total;
}

/**
 * The side that did *not* suffer `afflicted`; both afflicted is a DRAW.
 *
 * Shared by wipeout and collapse because RD-11 gives them the same shape: a
 * loss condition one side can meet, and a DRAW when both meet it at once.
 */
function survivor(afflicted: Record<Side, boolean>): Winner {
  if (afflicted.BLUE && afflicted.RED) {
    return "DRAW";
  }
  return afflicted.BLUE ? "RED" : "BLUE";
}

/**
 * The higher score, or DRAW on a tie.
 *
 * This is right for both scoring rungs, including the case where only one side
 * reached `winPoints`: the other is by definition below it, so "the side that
 * crossed" and "the higher total" cannot disagree.
 */
function leader(points: Record<Side, number>): Winner {
  if (points.BLUE === points.RED) {
    return "DRAW";
  }
  return points.BLUE > points.RED ? "BLUE" : "RED";
}

function anySide(flags: Record<Side, boolean>): boolean {
  return SIDES.some((side) => flags[side]);
}

/**
 * RD-11's ladder, in order: wipeout → collapse → points → turn limit. Returns
 * null while the match is live.
 */
export function evaluateEnding(scenario: Scenario, state: GameState): GameOverRecord | null {
  const points = {
    BLUE: pointsFor(scenario, state, "BLUE"),
    RED: pointsFor(scenario, state, "RED"),
  };
  const base = { endedOnTurn: state.turn, points };

  const wiped = {
    BLUE: totalPresence(state, "BLUE") <= WIPEOUT_PRESENCE,
    RED: totalPresence(state, "RED") <= WIPEOUT_PRESENCE,
  };
  if (anySide(wiped)) {
    return { reason: "WIPEOUT", winner: survivor(wiped), ...base };
  }

  const collapsed = {
    BLUE: state.sides.BLUE.political <= COLLAPSE_POLITICAL,
    RED: state.sides.RED.political <= COLLAPSE_POLITICAL,
  };
  if (anySide(collapsed)) {
    return { reason: "COLLAPSE", winner: survivor(collapsed), ...base };
  }

  if (SIDES.some((side) => points[side] >= scenario.winPoints)) {
    return { reason: "POINTS", winner: leader(points), ...base };
  }

  if (state.turn >= scenario.turnLimit) {
    return { reason: "TURN_LIMIT", winner: leader(points), ...base };
  }

  return null;
}
