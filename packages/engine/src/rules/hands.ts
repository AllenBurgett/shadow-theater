import type { CardId, Scenario, Side } from "../contract/index.ts";
import { createRng } from "../rng.ts";

/**
 * Hand drawing (RD-3, FR-006).
 *
 * Both sides draw `scenario.handSize` of the catalogue per turn from the
 * substream `hand:<SIDE>:<turn>`. Like the prototype's `drawHand`
 * (mechanics-inventory §5) this is stateless and re-derived on demand: there
 * is no deck, discard, or draw pointer in `GameState`, so a hand is a pure
 * function of (seed, side, turn) and every caller — creation, resolution,
 * validation, projection — agrees without coordinating.
 *
 * A hand is a **permission set**, not a consumable stack: a dealt card may
 * back several operations in the same order set, and nothing here consumes,
 * marks, or dedupes a play. Only the CP and ISR budgets limit repetition
 * (RD-2/RD-6, enforced in `validateOrders`).
 *
 * The prototype's RED-full-hand exception (`RED_FULL_HAND`) is deliberately
 * not carried over — RD-3 draws both sides symmetrically.
 */

/**
 * The substream label. Both the grammar and the number of draws `sample`
 * consumes are part of the frozen replay format (`rng.ts`), so `fork`
 * validates the label rather than this module re-checking `turn`.
 */
function handLabel(side: Side, turn: number): string {
  return `hand:${side}:${turn}`;
}

/** Draws one side's hand for `turn`; the scenario is never mutated. */
export function drawHand(scenario: Scenario, seed: string, side: Side, turn: number): CardId[] {
  const pool = scenario.cards.map((card) => card.id);
  return createRng(seed).fork(handLabel(side, turn)).sample(pool, scenario.handSize);
}

/** Draws both sides' hands for `turn` from their independent substreams. */
export function drawHands(
  scenario: Scenario,
  seed: string,
  turn: number,
): { BLUE: CardId[]; RED: CardId[] } {
  return {
    BLUE: drawHand(scenario, seed, "BLUE", turn),
    RED: drawHand(scenario, seed, "RED", turn),
  };
}
