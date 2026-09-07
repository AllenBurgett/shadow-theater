import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  CardId,
  ContactKind,
  GameState,
  Operation,
  OrderRejection,
  OrderSet,
  Scenario,
  ViolationCode,
} from "../contract/index.ts";
import { OrderRejectionSchema } from "../contract/index.ts";
import { deepFreeze } from "../freeze.ts";
import { loadScenario } from "../scenario.ts";
import { createGame } from "./state.ts";
import { validateOrders } from "./validate.ts";

const RAW = readFileSync(new URL("../scenarios/vespera-01.json", import.meta.url), "utf8");
const SCENARIO: Scenario = loadScenario(JSON.parse(RAW) as unknown);
const SEED = "vespera-01";
const FULL_HAND: CardId[] = SCENARIO.cards.map((card) => card.id);

/** Base state with a hand chosen by the test, so no case depends on a draw. */
function stateWithHand(hand: CardId[]): GameState {
  const state = createGame(SCENARIO, SEED);
  return { ...state, sides: { ...state.sides, BLUE: { ...state.sides.BLUE, hand } } };
}

const BASE = stateWithHand(FULL_HAND);

function op(cardId: CardId, id: string, theme: ContactKind | null = null): Operation {
  const card = SCENARIO.cards.find((entry) => entry.id === cardId);
  return { cardId, target: { kind: card?.target ?? "REGION", id }, theme };
}

function orders(operations: Operation[], turn = 1): OrderSet {
  return { side: "BLUE", turn, operations };
}

function rejectionOf(state: GameState, orderSet: OrderSet): OrderRejection {
  const result = validateOrders(SCENARIO, state, orderSet);
  if (result.ok) {
    throw new Error("expected validateOrders to reject");
  }
  return result.rejection;
}

function codesOf(state: GameState, orderSet: OrderSet): ViolationCode[] {
  return rejectionOf(state, orderSet).violations.map((violation) => violation.code);
}

describe("validateOrders acceptance", () => {
  it("accepts an empty set and a legal set inside both budgets", () => {
    expect(validateOrders(SCENARIO, BASE, orders([]))).toEqual({ ok: true });
    expect(
      validateOrders(
        SCENARIO,
        BASE,
        // 8 of 10 CP, 2 of 6 ISR.
        orders([
          op("DELIBERATE_ADVANCE", "R-02"),
          op("FORTIFY_REGION", "R-01"),
          op("JAMMING_CORRIDOR", "L-01-02"),
        ]),
      ),
    ).toEqual({ ok: true });
  });

  it("accepts the same dealt card played several times (permission set)", () => {
    // RD-2a / data-model: a dealt card may back several operations in one set;
    // only the CP and ISR budgets limit repetition.
    const thrice = orders([
      op("DELIBERATE_ADVANCE", "R-02"),
      op("DELIBERATE_ADVANCE", "R-02"),
      op("DELIBERATE_ADVANCE", "R-04"),
    ]);

    expect(validateOrders(SCENARIO, BASE, thrice)).toEqual({ ok: true });
  });

  it("accepts a theme on SPOOF_CONTACTS and a null theme anywhere", () => {
    expect(
      validateOrders(
        SCENARIO,
        BASE,
        orders([op("SPOOF_CONTACTS", "R-05", "armour-massing"), op("FOCUSED_ISR_SWEEP", "R-05")]),
      ),
    ).toEqual({ ok: true });
  });
});

describe("validateOrders violation codes (RD-2)", () => {
  it("reports TURN_MISMATCH when the set is not for the current turn", () => {
    expect(codesOf(BASE, orders([], 2))).toEqual(["TURN_MISMATCH"]);
  });

  it("reports UNKNOWN_CARD alone for a card outside the catalogue", () => {
    // Unreachable through `loadScenario` since the catalogue must cover the
    // enum (slice C1), so the code's defence is exercised directly.
    const trimmed: Scenario = {
      ...SCENARIO,
      cards: SCENARIO.cards.filter((card) => card.id !== "SECURE_CORRIDOR"),
    };
    const state = stateWithHand(trimmed.cards.map((card) => card.id));
    const set = orders([
      { cardId: "SECURE_CORRIDOR", target: { kind: "LINK", id: "L-01-02" }, theme: null },
    ]);

    // The card has no definition, so hand membership, target kind, legality
    // and cost are all unanswerable: the operation reports once and stops.
    const result = validateOrders(trimmed, state, set);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.rejection.violations.map((v) => v.code)).toEqual([
      "UNKNOWN_CARD",
    ]);
  });

  it("reports CARD_NOT_IN_HAND for an undealt catalogue card", () => {
    const restricted = stateWithHand(["FORTIFY_REGION"]);

    expect(codesOf(restricted, orders([op("DELIBERATE_ADVANCE", "R-02")]))).toEqual([
      "CARD_NOT_IN_HAND",
    ]);
  });

  it("reports TARGET_KIND_MISMATCH without also judging legality", () => {
    const set = orders([
      { cardId: "DELIBERATE_ADVANCE", target: { kind: "LINK", id: "L-01-02" }, theme: null },
    ]);

    expect(codesOf(BASE, set)).toEqual(["TARGET_KIND_MISMATCH"]);
  });

  it("reports TARGET_ILLEGAL for a well-formed but illegal target", () => {
    // R-05 is neither controlled nor adjacent to a BLUE-held region.
    expect(codesOf(BASE, orders([op("FORTIFY_REGION", "R-05")]))).toEqual(["TARGET_ILLEGAL"]);
    expect(codesOf(BASE, orders([op("DELIBERATE_ADVANCE", "R-05")]))).toEqual(["TARGET_ILLEGAL"]);
  });

  it("reports CP_EXCEEDED once for the whole set", () => {
    const set = orders([
      op("DELIBERATE_ADVANCE", "R-02"),
      op("DELIBERATE_ADVANCE", "R-04"),
      op("DELIBERATE_ADVANCE", "R-07"),
      op("DELIBERATE_ADVANCE", "R-09"),
    ]);

    expect(codesOf(BASE, set)).toEqual(["CP_EXCEEDED"]);
  });

  it("reports ISR_EXCEEDED for the CP-legal, ISR-illegal set RD-6 was tuned to catch", () => {
    // sweep + spoof + counterintel: 7 CP against a pool of 10, but 8 ISR
    // against a pool of 6 — the set that proves ISR binds independently of CP.
    const set = orders([
      op("FOCUSED_ISR_SWEEP", "R-05"),
      op("SPOOF_CONTACTS", "R-05", "recon-activity"),
      op("COUNTERINTEL_SWEEP", "R-01"),
    ]);
    const cost = set.operations.reduce(
      (total, operation) => {
        const card = SCENARIO.cards.find((entry) => entry.id === operation.cardId);
        return { cp: total.cp + (card?.cp ?? 0), isr: total.isr + (card?.isr ?? 0) };
      },
      { cp: 0, isr: 0 },
    );

    expect(cost).toEqual({ cp: 7, isr: 8 });
    expect(cost.cp).toBeLessThanOrEqual(SCENARIO.resources.cpPerTurn);
    expect(codesOf(BASE, set)).toEqual(["ISR_EXCEEDED"]);
  });

  it("reports THEME_NOT_APPLICABLE for a theme on any card but SPOOF_CONTACTS", () => {
    // The wire schema deliberately admits `theme` on every card so the whole-set
    // Violation[] contract — not a parse error — is what reports it.
    expect(codesOf(BASE, orders([op("FOCUSED_ISR_SWEEP", "R-05", "armour-massing")]))).toEqual([
      "THEME_NOT_APPLICABLE",
    ]);
    expect(codesOf(BASE, orders([op("DELIBERATE_ADVANCE", "R-02", "supply-buildup")]))).toEqual([
      "THEME_NOT_APPLICABLE",
    ]);
  });
});

describe("validateOrders whole-set semantics", () => {
  it("names every violation in the set, not just the first", () => {
    const restricted = stateWithHand(["DELIBERATE_ADVANCE", "FORTIFY_REGION", "FOCUSED_ISR_SWEEP"]);
    const set = orders(
      [
        op("FORTIFY_REGION", "R-05"),
        { cardId: "DELIBERATE_ADVANCE", target: { kind: "LINK", id: "L-01-02" }, theme: null },
        op("FOCUSED_ISR_SWEEP", "R-05", "recon-activity"),
        op("SPOOF_CONTACTS", "R-05", "recon-activity"),
      ],
      3,
    );

    expect(codesOf(restricted, set).sort()).toEqual(
      [
        "CARD_NOT_IN_HAND",
        "TARGET_ILLEGAL",
        "TARGET_KIND_MISMATCH",
        "THEME_NOT_APPLICABLE",
        "TURN_MISMATCH",
      ].sort(),
    );
  });

  it("attributes each operation-scoped violation to its card and target", () => {
    const rejection = rejectionOf(BASE, orders([op("FORTIFY_REGION", "R-05")]));

    expect(rejection.violations[0]).toMatchObject({
      code: "TARGET_ILLEGAL",
      cardId: "FORTIFY_REGION",
      targetId: "R-05",
    });
    expect(rejection.violations[0]?.detail).toBeTruthy();
  });

  it("produces a rejection that satisfies the wire contract", () => {
    const rejection = rejectionOf(BASE, orders([op("FORTIFY_REGION", "R-05")], 9));

    expect(OrderRejectionSchema.safeParse(rejection).success).toBe(true);
  });

  it("changes no state and mutates neither frozen input", () => {
    const frozenState = deepFreeze(structuredClone(BASE));
    const before = JSON.stringify(frozenState);

    expect(Object.isFrozen(SCENARIO)).toBe(true);
    validateOrders(SCENARIO, frozenState, orders([op("DELIBERATE_ADVANCE", "R-02")]));
    validateOrders(SCENARIO, frozenState, orders([op("FORTIFY_REGION", "R-05")], 4));

    expect(JSON.stringify(frozenState)).toBe(before);
    expect(JSON.stringify(SCENARIO)).toBe(JSON.stringify(loadScenario(JSON.parse(RAW))));
  });
});
