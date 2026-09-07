import type {
  CardId,
  GameState,
  OrderRejection,
  OrderSet,
  Scenario,
  Violation,
} from "../contract/index.ts";
import { findCard, isLegalTarget } from "./legality.ts";

/**
 * Whole-set order validation (RD-2, RD-6; engine-api `validateOrders`).
 *
 * Whole-set means two things. Every violation in the set is named — a caller
 * fixing one problem at a time is exactly the loop RD-2 was written to avoid,
 * and the RED adapter's repair pass needs the full list in one round. And
 * nothing is applied: this function only reads, so a rejection leaves no
 * observable state change (guarantee 4).
 */

/** The only card RD-2a gives a `theme`; a theme anywhere else is a violation. */
const THEMED_CARD: CardId = "SPOOF_CONTACTS";

export type OrderValidation = { ok: true } | { ok: false; rejection: OrderRejection };

export function validateOrders(
  scenario: Scenario,
  state: GameState,
  orders: OrderSet,
): OrderValidation {
  const violations: Violation[] = [];

  if (orders.turn !== state.turn) {
    violations.push({
      code: "TURN_MISMATCH",
      detail: `Order set is for turn ${orders.turn}; the game is on turn ${state.turn}`,
    });
  }

  const { hand } = state.sides[orders.side];
  let cp = 0;
  let isr = 0;

  for (const operation of orders.operations) {
    const targetId = operation.target.id;
    const card = findCard(scenario, operation.cardId);

    if (!card) {
      // The only short-circuit: without a definition there is no cost, no
      // target kind, and no legality to judge, so further codes would be
      // guesses about a card this scenario does not have.
      violations.push({
        code: "UNKNOWN_CARD",
        cardId: operation.cardId,
        targetId,
        detail: `Card "${operation.cardId}" is not in the ${scenario.id} catalogue`,
      });
      continue;
    }

    // Costs accrue for every defined card, including ones that drew another
    // violation: the budget report should describe the set as submitted rather
    // than a hypothetical subset the caller did not send.
    cp += card.cp;
    isr += card.isr;

    if (!hand.includes(card.id)) {
      violations.push({
        code: "CARD_NOT_IN_HAND",
        cardId: card.id,
        targetId,
        detail: `${orders.side} was not dealt "${card.id}" on turn ${state.turn}`,
      });
    }

    if (operation.target.kind !== card.target) {
      violations.push({
        code: "TARGET_KIND_MISMATCH",
        cardId: card.id,
        targetId,
        detail: `"${card.id}" targets a ${card.target}, not a ${operation.target.kind}`,
      });
    } else if (!isLegalTarget(scenario, state, orders.side, card, targetId)) {
      violations.push({
        code: "TARGET_ILLEGAL",
        cardId: card.id,
        targetId,
        detail: `"${targetId}" is not a legal ${card.id} target for ${orders.side} this turn`,
      });
    }

    if (operation.theme !== null && card.id !== THEMED_CARD) {
      violations.push({
        code: "THEME_NOT_APPLICABLE",
        cardId: card.id,
        targetId,
        detail: `"${card.id}" takes no theme; only ${THEMED_CARD} does`,
      });
    }
  }

  // Both pools are per side per turn with no carry-over (RD-2/RD-6), so they
  // are judged against the whole set and reported once each.
  if (cp > scenario.resources.cpPerTurn) {
    violations.push({
      code: "CP_EXCEEDED",
      detail: `Set costs ${cp} CP against a pool of ${scenario.resources.cpPerTurn}`,
    });
  }
  if (isr > scenario.resources.isrPerTurn) {
    violations.push({
      code: "ISR_EXCEEDED",
      detail: `Set costs ${isr} ISR against a pool of ${scenario.resources.isrPerTurn}`,
    });
  }

  if (violations.length === 0) {
    return { ok: true };
  }
  return { ok: false, rejection: { violations } };
}
