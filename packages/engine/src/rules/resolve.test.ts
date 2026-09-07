import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  CardId,
  Event,
  GameState,
  Operation,
  OrderSet,
  Scenario,
  Side,
} from "../contract/index.ts";
import { EventSchema } from "../contract/index.ts";
import { deepFreeze } from "../freeze.ts";
import { loadScenario } from "../scenario.ts";
import { drawHands } from "./hands.ts";
import {
  initiativeFor,
  OrderSideMismatchError,
  OrderValidationError,
  resolveTurn,
} from "./resolve.ts";
import { createGame } from "./state.ts";

const RAW = readFileSync(new URL("../scenarios/vespera-01.json", import.meta.url), "utf8");
const SCENARIO: Scenario = loadScenario(JSON.parse(RAW) as unknown);
const SEED = "vespera-01";
const BASE = createGame(SCENARIO, SEED);
const FULL_HAND: CardId[] = SCENARIO.cards.map((card) => card.id);

function region(state: GameState, regionId: string) {
  const found = state.regions[regionId];
  if (!found) {
    throw new Error(`test fixture is missing region ${regionId}`);
  }
  return found;
}

/** A turn-N state with both hands stocked, so no case depends on a draw. */
function fixture(turn: number, mutate?: (draft: GameState) => void): GameState {
  const draft = structuredClone(BASE);
  draft.turn = turn;
  draft.sides.BLUE.hand = [...FULL_HAND];
  draft.sides.RED.hand = [...FULL_HAND];
  mutate?.(draft);
  return draft;
}

function ops(cardId: CardId, id: string, theme: Operation["theme"] = null): Operation {
  const card = SCENARIO.cards.find((entry) => entry.id === cardId);
  return { cardId, target: { kind: card?.target ?? "REGION", id }, theme };
}

function orderSet(side: Side, turn: number, operations: Operation[]): OrderSet {
  return { side, turn, operations };
}

function kinds(events: readonly Event[], kind: Event["kind"]): Event[] {
  return events.filter((event) => event.kind === kind);
}

function cardsApplied(events: readonly Event[]): string[] {
  return kinds(events, "orderApplied").map((event) =>
    event.kind === "orderApplied" ? `${event.side}:${event.cardId}` : "",
  );
}

/**
 * Two advances in tension: one side attacks the region that supports the
 * other side's advance, so whichever side moves first invalidates the other.
 */
function contestedFixture(turn: number, attacker: Side): GameState {
  const defender: Side = attacker === "BLUE" ? "RED" : "BLUE";
  return fixture(turn, (draft) => {
    const staging = region(draft, "R-02");
    staging.control = attacker;
    staging.presence = { BLUE: attacker === "BLUE" ? 60 : 0, RED: attacker === "RED" ? 60 : 0 };

    const support = region(draft, "R-03");
    support.control = defender;
    support.presence = { BLUE: defender === "BLUE" ? 15 : 0, RED: defender === "RED" ? 15 : 0 };
  });
}

describe("initiativeFor (RD-1)", () => {
  it("alternates BLUE on odd turns and RED on even, derived from the turn", () => {
    expect([1, 2, 3, 16].map(initiativeFor)).toEqual(["BLUE", "RED", "BLUE", "RED"]);
  });
});

describe("resolveTurn turn skeleton (RD-1)", () => {
  it("opens the turn with turnStarted carrying the derived initiative", () => {
    const blueFirst = resolveTurn(SCENARIO, fixture(1), {
      BLUE: orderSet("BLUE", 1, []),
      RED: orderSet("RED", 1, []),
    });
    const redFirst = resolveTurn(SCENARIO, fixture(2), {
      BLUE: orderSet("BLUE", 2, []),
      RED: orderSet("RED", 2, []),
    });

    expect(blueFirst.events[0]).toMatchObject({ kind: "turnStarted", initiative: "BLUE", turn: 1 });
    expect(redFirst.events[0]).toMatchObject({ kind: "turnStarted", initiative: "RED", turn: 2 });
  });

  it("leaves seq 1 to the gameCreated header and starts turn 1 at 2", () => {
    const { events } = resolveTurn(SCENARIO, fixture(1), {
      BLUE: orderSet("BLUE", 1, []),
      RED: orderSet("RED", 1, []),
    });

    expect(events[0]?.seq).toBe(2);
  });

  it("chains turns into one gapless run behind that header", () => {
    const first = resolveTurn(SCENARIO, fixture(1), {
      BLUE: orderSet("BLUE", 1, []),
      RED: orderSet("RED", 1, []),
    });
    const second = resolveTurn(
      SCENARIO,
      first.state,
      { BLUE: orderSet("BLUE", 2, []), RED: orderSet("RED", 2, []) },
      (first.events.at(-1)?.seq ?? 0) + 1,
    );
    // Seq 1 stands in for the header the stream owner emits (issue #18).
    const seqs = [1, ...first.events.map((event) => event.seq), ...second.events.map((e) => e.seq)];

    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
  });

  it("numbers events from the given seq so the stream stays monotonic per game", () => {
    const { events } = resolveTurn(
      SCENARIO,
      fixture(1),
      { BLUE: orderSet("BLUE", 1, []), RED: orderSet("RED", 1, []) },
      12,
    );

    expect(events.map((event) => event.seq)).toEqual([12, 13, 14]);
  });

  it("emits ordersAccepted for both sides as the replay input", () => {
    const blue = [ops("FOCUSED_ISR_SWEEP", "R-05")];
    const { events } = resolveTurn(SCENARIO, fixture(1), {
      BLUE: orderSet("BLUE", 1, blue),
      RED: orderSet("RED", 1, []),
    });
    const accepted = kinds(events, "ordersAccepted");

    expect(accepted).toHaveLength(2);
    expect(accepted[0]).toMatchObject({ side: "BLUE", operations: blue });
  });

  it("resolves INFO operations before SURFACE ones, whatever the submitted order", () => {
    const { events } = resolveTurn(SCENARIO, fixture(1), {
      BLUE: orderSet("BLUE", 1, [
        ops("DELIBERATE_ADVANCE", "R-02"),
        ops("FOCUSED_ISR_SWEEP", "R-05"),
      ]),
      RED: orderSet("RED", 1, []),
    });

    expect(cardsApplied(events)).toEqual(["BLUE:FOCUSED_ISR_SWEEP", "BLUE:DELIBERATE_ADVANCE"]);
  });

  it("resolves the initiative side first within a phase, at both parities", () => {
    const both = {
      BLUE: orderSet("BLUE", 1, [ops("FOCUSED_ISR_SWEEP", "R-05")]),
      RED: orderSet("RED", 1, [ops("FOCUSED_ISR_SWEEP", "R-05")]),
    };
    const odd = resolveTurn(SCENARIO, fixture(1), both);
    const even = resolveTurn(SCENARIO, fixture(2), {
      BLUE: { ...both.BLUE, turn: 2 },
      RED: { ...both.RED, turn: 2 },
    });

    expect(cardsApplied(odd.events)).toEqual(["BLUE:FOCUSED_ISR_SWEEP", "RED:FOCUSED_ISR_SWEEP"]);
    expect(cardsApplied(even.events)).toEqual(["RED:FOCUSED_ISR_SWEEP", "BLUE:FOCUSED_ISR_SWEEP"]);
  });

  it("keeps submitted order within one side's phase", () => {
    const { events } = resolveTurn(SCENARIO, fixture(1), {
      BLUE: orderSet("BLUE", 1, [ops("DELIBERATE_ADVANCE", "R-02"), ops("FORTIFY_REGION", "R-01")]),
      RED: orderSet("RED", 1, []),
    });

    expect(cardsApplied(events)).toEqual(["BLUE:DELIBERATE_ADVANCE", "BLUE:FORTIFY_REGION"]);
  });

  it("increments the turn last and draws the next turn's hands", () => {
    const { state } = resolveTurn(SCENARIO, fixture(1), {
      BLUE: orderSet("BLUE", 1, []),
      RED: orderSet("RED", 1, []),
    });

    expect(state.turn).toBe(2);
    expect({ BLUE: state.sides.BLUE.hand, RED: state.sides.RED.hand }).toEqual(
      drawHands(SCENARIO, SEED, 2),
    );
  });
});

describe("resolveTurn fizzle semantics (RD-1)", () => {
  it("fizzles the trailing advance once the initiative side takes its support", () => {
    // BLUE attacks R-03, the RED-held region that is RED's only approach to
    // R-04; the contest leaves R-03 CONTESTED, so RED's advance loses its
    // support between validation and its own resolution.
    const { events, state } = resolveTurn(SCENARIO, contestedFixture(1, "BLUE"), {
      BLUE: orderSet("BLUE", 1, [ops("DELIBERATE_ADVANCE", "R-03")]),
      RED: orderSet("RED", 1, [ops("DELIBERATE_ADVANCE", "R-04")]),
    });

    expect(cardsApplied(events)).toEqual(["BLUE:DELIBERATE_ADVANCE"]);
    expect(kinds(events, "orderFizzled")[0]).toMatchObject({
      side: "RED",
      cardId: "DELIBERATE_ADVANCE",
      target: { kind: "REGION", id: "R-04" },
      visibleTo: { BLUE: false, RED: true },
    });
    expect(region(state, "R-04").presence.RED).toBe(0);
    expect(region(state, "R-03").control).toBe("CONTESTED");
  });

  it("mirrors at RED initiative: the same tension fizzles BLUE instead", () => {
    const { events, state } = resolveTurn(SCENARIO, contestedFixture(2, "RED"), {
      BLUE: orderSet("BLUE", 2, [ops("DELIBERATE_ADVANCE", "R-04")]),
      RED: orderSet("RED", 2, [ops("DELIBERATE_ADVANCE", "R-03")]),
    });

    expect(cardsApplied(events)).toEqual(["RED:DELIBERATE_ADVANCE"]);
    expect(kinds(events, "orderFizzled")[0]).toMatchObject({ side: "BLUE" });
    expect(region(state, "R-04").presence.BLUE).toBe(0);
  });

  it("lets the same order pair through when initiative runs the other way", () => {
    // Identical position and identical orders, one turn later: RED moves first
    // and both operations apply. Initiative, not legality, is the difference.
    const { events } = resolveTurn(SCENARIO, contestedFixture(2, "BLUE"), {
      BLUE: orderSet("BLUE", 2, [ops("DELIBERATE_ADVANCE", "R-03")]),
      RED: orderSet("RED", 2, [ops("DELIBERATE_ADVANCE", "R-04")]),
    });

    expect(cardsApplied(events)).toEqual(["RED:DELIBERATE_ADVANCE", "BLUE:DELIBERATE_ADVANCE"]);
    expect(kinds(events, "orderFizzled")).toEqual([]);
  });

  it("fizzles the second fortify of one region in a turn (RD-2a cap)", () => {
    const { events, state } = resolveTurn(SCENARIO, fixture(1), {
      BLUE: orderSet("BLUE", 1, [ops("FORTIFY_REGION", "R-01"), ops("FORTIFY_REGION", "R-01")]),
      RED: orderSet("RED", 1, []),
    });

    expect(cardsApplied(events)).toEqual(["BLUE:FORTIFY_REGION"]);
    expect(kinds(events, "orderFizzled")[0]).toMatchObject({ side: "BLUE" });
    expect(region(state, "R-01").fort).toBe(1);
  });

  it("rejects the whole set before resolving, distinct from fizzling", () => {
    // FR-005 validation is a whole-set outcome against pre-turn state; nothing
    // resolves and no event is produced.
    const invalid = orderSet("RED", 1, [ops("FORTIFY_REGION", "R-05")]);

    expect(() =>
      resolveTurn(SCENARIO, fixture(1), { BLUE: orderSet("BLUE", 1, []), RED: invalid }),
    ).toThrow(OrderValidationError);
    try {
      resolveTurn(SCENARIO, fixture(1), { BLUE: orderSet("BLUE", 1, []), RED: invalid });
    } catch (error) {
      expect((error as OrderValidationError).side).toBe("RED");
      expect((error as OrderValidationError).rejection.violations[0]?.code).toBe("TARGET_ILLEGAL");
    }
  });
});

describe("resolveTurn order routing", () => {
  it("refuses a set filed under a key that disagrees with its own side", () => {
    // Otherwise validation reads one side's hand and budgets while resolution
    // applies the other side's legality and effects.
    const blue = orderSet("BLUE", 1, []);
    const red = orderSet("RED", 1, []);

    expect(() => resolveTurn(SCENARIO, fixture(1), { BLUE: red, RED: red })).toThrow(
      OrderSideMismatchError,
    );
    expect(() => resolveTurn(SCENARIO, fixture(1), { BLUE: blue, RED: blue })).toThrow(
      OrderSideMismatchError,
    );
    try {
      resolveTurn(SCENARIO, fixture(1), { BLUE: red, RED: red });
    } catch (error) {
      expect(error).toMatchObject({ key: "BLUE", declared: "RED" });
    }
  });
});

describe("resolveTurn event stream", () => {
  it("emits board facts alongside orderApplied and stamps control changes to all", () => {
    const { events } = resolveTurn(SCENARIO, fixture(1), {
      BLUE: orderSet("BLUE", 1, [
        ops("DELIBERATE_ADVANCE", "R-02"),
        ops("INTERDICT_LINK", "L-01-02"),
      ]),
      RED: orderSet("RED", 1, [ops("SPOOF_CONTACTS", "R-05", "armour-massing")]),
    });

    expect(kinds(events, "controlChanged")[0]).toMatchObject({
      regionId: "R-02",
      from: "NEUTRAL",
      to: "BLUE",
      visibleTo: { BLUE: true, RED: true },
    });
    expect(kinds(events, "linkEffectAdded")[0]).toMatchObject({ linkId: "L-01-02" });
    expect(kinds(events, "contactCreated")[0]).toMatchObject({
      visibleTo: { BLUE: false, RED: true },
    });
  });

  it("surfaces operation-driven removals as their own board facts", () => {
    const contested = fixture(1, (draft) => {
      const link = draft.links["L-01-02"];
      link?.effects.push(
        { kind: "INTERDICT", side: "RED", expiresTurn: 3 },
        { kind: "JAM", side: "RED", expiresTurn: 3 },
      );
      draft.contacts.push({
        id: "contact-deadbeef",
        side: "RED",
        regionId: "R-01",
        kind: "recon-activity",
        expiresTurn: 3,
      });
    });
    const { events } = resolveTurn(SCENARIO, contested, {
      BLUE: orderSet("BLUE", 1, [
        ops("SECURE_CORRIDOR", "L-01-02"),
        ops("COUNTERINTEL_SWEEP", "R-01"),
      ]),
      RED: orderSet("RED", 1, []),
    });

    expect(kinds(events, "linkEffectRemoved")).toMatchObject([
      {
        linkId: "L-01-02",
        effect: { kind: "INTERDICT", side: "RED" },
        visibleTo: { BLUE: true, RED: false },
      },
      { linkId: "L-01-02", effect: { kind: "JAM", side: "RED" } },
    ]);
    expect(kinds(events, "contactRemoved")).toMatchObject([
      { contact: { id: "contact-deadbeef" }, visibleTo: { BLUE: true, RED: false } },
    ]);
    // The timers-phase kinds stay with T020 (issue #15).
    expect(kinds(events, "linkEffectExpired")).toEqual([]);
    expect(kinds(events, "contactExpired")).toEqual([]);
  });

  it("emits no removal event when an operation finds nothing to strip", () => {
    const { events } = resolveTurn(SCENARIO, fixture(1), {
      BLUE: orderSet("BLUE", 1, [
        ops("SECURE_CORRIDOR", "L-01-02"),
        ops("COUNTERINTEL_SWEEP", "R-01"),
      ]),
      RED: orderSet("RED", 1, []),
    });

    expect(cardsApplied(events)).toEqual(["BLUE:COUNTERINTEL_SWEEP", "BLUE:SECURE_CORRIDOR"]);
    expect(kinds(events, "linkEffectRemoved")).toEqual([]);
    expect(kinds(events, "contactRemoved")).toEqual([]);
  });

  it("keeps card identities to the acting side (RD-9)", () => {
    const { events } = resolveTurn(SCENARIO, fixture(1), {
      BLUE: orderSet("BLUE", 1, [ops("DELIBERATE_ADVANCE", "R-02")]),
      RED: orderSet("RED", 1, []),
    });

    for (const event of events) {
      if (event.kind === "orderApplied" || event.kind === "ordersAccepted") {
        expect(event.visibleTo).toEqual({ BLUE: event.side === "BLUE", RED: event.side === "RED" });
      }
    }
  });

  it("emits events that satisfy the wire schema", () => {
    const seeded = fixture(1, (draft) => {
      draft.links["L-01-02"]?.effects.push({ kind: "JAM", side: "RED", expiresTurn: 3 });
      draft.contacts.push({
        id: "contact-deadbeef",
        side: "RED",
        regionId: "R-01",
        kind: "supply-buildup",
        expiresTurn: 3,
      });
    });
    const { events } = resolveTurn(SCENARIO, seeded, {
      BLUE: orderSet("BLUE", 1, [
        ops("SPOOF_CONTACTS", "R-05"),
        ops("COUNTERINTEL_SWEEP", "R-01"),
        ops("SECURE_CORRIDOR", "L-01-02"),
      ]),
      RED: orderSet("RED", 1, [ops("JAMMING_CORRIDOR", "L-11-12")]),
    });

    expect(events.map((event) => event.kind)).toContain("linkEffectRemoved");
    expect(events.map((event) => event.kind)).toContain("contactRemoved");

    for (const event of events) {
      expect(EventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("emits copies, so freezing history never freezes live state", () => {
    const { events, state } = resolveTurn(SCENARIO, fixture(1), {
      BLUE: orderSet("BLUE", 1, [ops("SPOOF_CONTACTS", "R-05")]),
      RED: orderSet("RED", 1, []),
    });
    const created = kinds(events, "contactCreated")[0];

    expect(created?.kind === "contactCreated" && Object.isFrozen(created.contact)).toBe(true);
    expect(Object.isFrozen(state.contacts[0])).toBe(false);
  });
});

describe("resolveTurn dispatch", () => {
  it("routes every card in the catalogue to its effect", () => {
    const first = resolveTurn(SCENARIO, fixture(1), {
      BLUE: orderSet("BLUE", 1, [
        ops("DELIBERATE_ADVANCE", "R-02"),
        ops("RAPID_REDEPLOY", "L-01-02"),
        ops("FORTIFY_REGION", "R-01"),
      ]),
      RED: orderSet("RED", 1, [
        ops("JAMMING_CORRIDOR", "L-11-12"),
        ops("SPOOF_CONTACTS", "R-01"),
        ops("COUNTERINTEL_SWEEP", "R-12"),
      ]),
    });
    const second = resolveTurn(SCENARIO, fixture(2), {
      BLUE: orderSet("BLUE", 2, [
        ops("INTERDICT_LINK", "L-01-02"),
        ops("SECURE_CORRIDOR", "L-01-02"),
        ops("FOCUSED_ISR_SWEEP", "R-05"),
      ]),
      RED: orderSet("RED", 2, []),
    });
    const played = [...cardsApplied(first.events), ...cardsApplied(second.events)].map(
      (entry) => entry.split(":")[1],
    );

    expect(new Set(played)).toEqual(new Set(FULL_HAND));
    expect(kinds(first.events, "orderFizzled")).toEqual([]);
    expect(kinds(second.events, "orderFizzled")).toEqual([]);
  });
});

describe("resolveTurn purity", () => {
  it("threads one rumor substream per side, so repeat spoofs differ", () => {
    const { state } = resolveTurn(SCENARIO, fixture(1), {
      BLUE: orderSet("BLUE", 1, [ops("SPOOF_CONTACTS", "R-05"), ops("SPOOF_CONTACTS", "R-06")]),
      RED: orderSet("RED", 1, [ops("SPOOF_CONTACTS", "R-05")]),
    });
    const ids = state.contacts.map((contact) => contact.id);

    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it("is deterministic and never mutates the state it is given", () => {
    const frozen = deepFreeze(fixture(1));
    const before = JSON.stringify(frozen);
    const orders = {
      BLUE: orderSet("BLUE", 1, [ops("DELIBERATE_ADVANCE", "R-02"), ops("SPOOF_CONTACTS", "R-05")]),
      RED: orderSet("RED", 1, [ops("INTERDICT_LINK", "L-11-12")]),
    };

    const first = resolveTurn(SCENARIO, frozen, orders);
    const second = resolveTurn(SCENARIO, frozen, orders);

    expect(JSON.stringify(frozen)).toBe(before);
    expect(JSON.stringify(first.state)).toBe(JSON.stringify(second.state));
    expect(JSON.stringify(first.events)).toBe(JSON.stringify(second.events));
  });
});
