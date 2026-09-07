import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  CardId,
  Contact,
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
import type { TurnOrders } from "./resolve.ts";
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

    // Pinned to the starting seq and gaplessness, not to a phase count: #15
    // adds resolution events to the same turn and must not rewrite this rule.
    expect(events[0]?.seq).toBe(12);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => 12 + index));
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

describe("resolveTurn consequence phases (RD-1 phases 4–7)", () => {
  const QUIET: TurnOrders = {
    BLUE: orderSet("BLUE", 1, []),
    RED: orderSet("RED", 1, []),
  };

  it("recomputes supply, promoting a port the placeholder could only call THIN", () => {
    const { state, events } = resolveTurn(SCENARIO, fixture(1), QUIET);

    expect(region(state, "R-01").supply.BLUE).toBe("IN_SUPPLY");
    // Own-supply only: `RegionView` exposes `ownSupply`, never the enemy's.
    expect(kinds(events, "supplyChanged")).toContainEqual(
      expect.objectContaining({
        regionId: "R-01",
        side: "BLUE",
        from: "THIN",
        to: "IN_SUPPLY",
        visibleTo: { BLUE: true, RED: false },
      }),
    );
  });

  it("attritions an out-of-supply garrison and lets phase 6 flip the margin it crosses", () => {
    // R-03 is BLUE-held and unreachable from BLUE's port past NEUTRAL R-02, so
    // it lands THIN: 11 presence drains to 9, which no longer clears RD-13's
    // margin over an empty region.
    const { state, events } = resolveTurn(
      SCENARIO,
      fixture(1, (draft) => {
        region(draft, "R-03").presence = { BLUE: 11, RED: 0 };
      }),
      QUIET,
    );

    expect(kinds(events, "attrition")).toContainEqual(
      expect.objectContaining({ regionId: "R-03", side: "BLUE", amount: 2 }),
    );
    expect(region(state, "R-03").presence.BLUE).toBe(9);
    expect(kinds(events, "controlChanged")).toContainEqual(
      expect.objectContaining({
        regionId: "R-03",
        from: "BLUE",
        to: "CONTESTED",
        // RD-9 discloses control fully in M1.
        visibleTo: { BLUE: true, RED: true },
      }),
    );
  });

  it("scores unrest against the flip phase 6 produced, change and contest together", () => {
    const { state, events } = resolveTurn(
      SCENARIO,
      fixture(1, (draft) => {
        region(draft, "R-03").presence = { BLUE: 11, RED: 0 };
      }),
      QUIET,
    );

    // Held → CONTESTED is both RD-5 terms at once: +1 change, +1 contested.
    expect(region(state, "R-03").unrest).toBe(2);
    expect(kinds(events, "unrestChanged")).toEqual([
      expect.objectContaining({ regionId: "R-03", from: 0, to: 2 }),
    ]);
    // Unrest read the previous turn end (BLUE) and RD-8's end-of-evaluation
    // write then advanced the snapshot to this one — order, not coincidence.
    expect(region(state, "R-03").lastController).toBe("CONTESTED");
  });

  it("reads a turn-N ISR sweep as age 0 through the timers phase (review M8/N3)", () => {
    const swept = resolveTurn(SCENARIO, fixture(1), {
      BLUE: orderSet("BLUE", 1, [ops("FOCUSED_ISR_SWEEP", "R-05")]),
      RED: orderSet("RED", 1, []),
    });
    const unswept = resolveTurn(SCENARIO, fixture(1), QUIET);

    expect(swept.state.sides.BLUE.intelAge["R-05"]).toBe(0);
    expect(unswept.state.sides.BLUE.intelAge["R-05"]).toBe(4);
    // The other side is untouched: intel age is stored per side.
    expect(swept.state.sides.RED.intelAge["R-05"]).toBe(4);
  });

  it("does not credit an operation that fizzled, because it observed nothing", () => {
    // The two-sided advance tension: RED's advance into R-04 fizzles once
    // BLUE has taken its support region, so RED never sets foot there and its
    // intel on R-04 ages like any other unobserved region.
    const { state, events } = resolveTurn(SCENARIO, contestedFixture(1, "BLUE"), {
      BLUE: orderSet("BLUE", 1, [ops("DELIBERATE_ADVANCE", "R-03")]),
      RED: orderSet("RED", 1, [ops("DELIBERATE_ADVANCE", "R-04")]),
    });

    expect(kinds(events, "orderFizzled")).toHaveLength(1);
    expect(state.sides.RED.intelAge["R-04"]).toBe(4);
    // BLUE's advance applied, so R-03 is observed and reads CONFIRMED.
    expect(state.sides.BLUE.intelAge["R-03"]).toBe(0);
  });

  it("retires link effects and contacts on the turn their expiry lands", () => {
    const expiring = fixture(3, (draft) => {
      draft.links["L-01-02"] = {
        effects: [{ kind: "JAM", side: "RED", expiresTurn: 3 }],
      };
      draft.contacts = [
        { id: "contact-1", side: "BLUE", regionId: "R-05", kind: "recon-activity", expiresTurn: 3 },
      ] satisfies Contact[];
    });

    const { state, events } = resolveTurn(SCENARIO, expiring, {
      BLUE: orderSet("BLUE", 3, []),
      RED: orderSet("RED", 3, []),
    });

    expect(state.links["L-01-02"]?.effects).toEqual([]);
    expect(state.contacts).toEqual([]);
    expect(kinds(events, "linkEffectExpired")).toEqual([
      expect.objectContaining({ linkId: "L-01-02", visibleTo: { BLUE: false, RED: true } }),
    ]);
    expect(kinds(events, "contactExpired")).toEqual([
      expect.objectContaining({ visibleTo: { BLUE: true, RED: false } }),
    ]);
  });

  it("orders the phases so supply is assigned from what the ops phases left", () => {
    // R-02 is NEUTRAL and empty, and it is the gap that leaves BLUE's R-03
    // unreachable from its port. Taking it on turn 1 opens the corridor within
    // the same turn: phase 4 reads post-ops control, so R-02 and R-03 are both
    // IN_SUPPLY before phase 5 could have billed either of them.
    const { state, events } = resolveTurn(SCENARIO, fixture(1), {
      BLUE: orderSet("BLUE", 1, [ops("DELIBERATE_ADVANCE", "R-02")]),
      RED: orderSet("RED", 1, []),
    });

    expect(kinds(events, "supplyChanged")).toContainEqual(
      expect.objectContaining({ regionId: "R-02", side: "BLUE", from: "NONE", to: "IN_SUPPLY" }),
    );
    expect(region(state, "R-03").supply.BLUE).toBe("IN_SUPPLY");
    // Advanced in at the unsupplied base of 10 (nothing was in supply when the
    // op resolved) and attritioned by nothing, because supply came first.
    expect(region(state, "R-02").presence.BLUE).toBe(10);
    // The only region billed is RED's R-09, still cut off behind NEUTRAL
    // ground; nothing BLUE holds pays, because the corridor opened first.
    expect(
      kinds(events, "attrition").map((event) => ("regionId" in event ? event.regionId : "")),
    ).toEqual(["R-09"]);
  });
});

describe("resolveTurn political upkeep (RD-1 phase 8)", () => {
  const QUIET_TURN_1: TurnOrders = {
    BLUE: orderSet("BLUE", 1, []),
    RED: orderSet("RED", 1, []),
  };

  /** Resolves `turns` no-op turns from `start`, returning every state in order. */
  function noOpRun(start: GameState, turns: number): GameState[] {
    const history: GameState[] = [];
    let current = start;
    let seq = 2;
    for (let index = 0; index < turns; index += 1) {
      const result = resolveTurn(
        SCENARIO,
        current,
        {
          BLUE: orderSet("BLUE", current.turn, []),
          RED: orderSet("RED", current.turn, []),
        },
        seq,
      );
      seq = (result.events.at(-1)?.seq ?? seq) + 1;
      current = result.state;
      history.push(current);
    }
    return history;
  }

  it("charges the opening 1-a-turn drain and keeps the figure to its own side", () => {
    const { state, events } = resolveTurn(SCENARIO, fixture(1), QUIET_TURN_1);

    expect(state.sides.BLUE.political).toBe(19);
    expect(state.sides.RED.political).toBe(19);
    // SC-003 forbids the exact enemy figure; the band is the shared view.
    expect(kinds(events, "politicalChanged")).toEqual([
      expect.objectContaining({
        side: "BLUE",
        from: 20,
        to: 19,
        cause: "habitatNotControlled",
        visibleTo: { BLUE: true, RED: false },
      }),
      expect.objectContaining({
        side: "RED",
        cause: "habitatNotControlled",
        visibleTo: { BLUE: false, RED: true },
      }),
    ]);
    expect(kinds(events, "postureChanged")).toEqual([]);
  });

  it("announces a posture band crossing to both sides (RD-9)", () => {
    const strained = fixture(1, (draft) => {
      draft.sides.BLUE.political = 13;
    });

    const { events } = resolveTurn(SCENARIO, strained, QUIET_TURN_1);

    expect(kinds(events, "postureChanged")).toEqual([
      expect.objectContaining({
        side: "BLUE",
        band: "STRAINED",
        visibleTo: { BLUE: true, RED: true },
      }),
    ]);
  });

  it("bills the RD-8 penalty for a habitat that attrition contested away", () => {
    // R-03 is a HABITAT: 11 presence drains to 9 in phase 5 and phase 6 takes
    // it CONTESTED, so BLUE's previous turn-end control was itself and its
    // current turn-end control is not — 2 for holding neither habitat, then 5.
    const { state, events } = resolveTurn(
      SCENARIO,
      fixture(1, (draft) => {
        region(draft, "R-03").presence = { BLUE: 11, RED: 0 };
      }),
      QUIET_TURN_1,
    );

    expect(state.sides.BLUE.political).toBe(13);
    expect(
      kinds(events, "politicalChanged").map((event) => ("cause" in event ? event.cause : "")),
    ).toEqual(["habitatNotControlled", "habitatLossPenalty", "habitatNotControlled"]);
  });

  it("writes lastController only after unrest and the penalty have read it", () => {
    const { state } = resolveTurn(
      SCENARIO,
      fixture(1, (draft) => {
        region(draft, "R-03").presence = { BLUE: 11, RED: 0 };
      }),
      QUIET_TURN_1,
    );

    // Both readers saw BLUE: unrest scored the change (+1) and the contest
    // (+1), and the penalty fired — and only then did the snapshot advance.
    expect(region(state, "R-03").unrest).toBe(2);
    expect(state.sides.BLUE.political).toBe(13);
    expect(region(state, "R-03").lastController).toBe("CONTESTED");
  });

  it("holds RD-4's floor: neither side collapses before turn 8", () => {
    const history = noOpRun(fixture(1), SCENARIO.turnLimit);

    for (const [index, state] of history.slice(0, 7).entries()) {
      expect({ turn: index + 1, political: state.sides.BLUE.political }).toEqual({
        turn: index + 1,
        political: 20 - (index + 1),
      });
      expect(state.sides.RED.political).toBeGreaterThan(0);
    }
  });

  it("shows the floor is a floor, not immunity: RD-12 attrition erodes it", () => {
    // RD-4 reasoned the no-op drain is 1/turn against 20 and so never
    // collapses. RD-12's THIN attrition, which landed after that note, drains
    // each side's unreachable habitat 40 -> 10 over 15 turns; on turn 16 it
    // falls below RD-13's margin, both sides lose a habitat, and both pay the
    // constraint penalty in the same upkeep. That is the DRAW-shaped position
    // slice C's ladder has to resolve, and it lands on the turn limit itself.
    const history = noOpRun(fixture(1), SCENARIO.turnLimit);
    const last = history.at(-1);

    expect(region(history[14] ?? fixture(1), "R-03").control).toBe("BLUE");
    // The turn does not advance past the ending (RD-1 phase 11).
    expect(last?.turn).toBe(SCENARIO.turnLimit);
    expect(region(last ?? fixture(1), "R-03").control).toBe("CONTESTED");
    expect(last?.sides.BLUE.political).toBe(-2);
    expect(last?.sides.RED.political).toBe(-2);
  });
});

describe("resolveTurn objectives and endings (RD-1 phases 9–10)", () => {
  const QUIET_TURN_1: TurnOrders = {
    BLUE: orderSet("BLUE", 1, []),
    RED: orderSet("RED", 1, []),
  };

  /**
   * Plays no-op turns from `start` until the game ends or `limit` turns have
   * passed, returning every resolved state. This is the whole turn loop under
   * test, not a phase of it.
   */
  function play(start: GameState, limit: number): GameState[] {
    const history: GameState[] = [];
    let current = start;
    let seq = 2;
    for (let index = 0; index < limit && current.gameOver === null; index += 1) {
      const result = resolveTurn(
        SCENARIO,
        current,
        {
          BLUE: orderSet("BLUE", current.turn, []),
          RED: orderSet("RED", current.turn, []),
        },
        seq,
      );
      seq = (result.events.at(-1)?.seq ?? seq) + 1;
      current = result.state;
      history.push(current);
    }
    return history;
  }

  it("banks a completed objective and tells only the side whose objective it is", () => {
    const ready = fixture(1, (draft) => {
      region(draft, "R-03").fort = 3;
    });

    const { state, events } = resolveTurn(SCENARIO, ready, QUIET_TURN_1);

    expect(state.objectiveHistory).toEqual([
      { objectiveId: "blue-fortify-habitat", side: "BLUE", turn: 1 },
    ]);
    expect(kinds(events, "objectiveCompleted")).toEqual([
      expect.objectContaining({
        objectiveId: "blue-fortify-habitat",
        side: "BLUE",
        points: 4,
        // Under-disclosed until T024 splits public from secret objectives.
        visibleTo: { BLUE: true, RED: false },
      }),
    ]);
  });

  it("stores the ending once, announces it to both sides, and stops the clock", () => {
    const doomed = fixture(1, (draft) => {
      for (const state of Object.values(draft.regions)) {
        state.presence.RED = 0;
      }
    });

    const { state, events } = resolveTurn(SCENARIO, doomed, QUIET_TURN_1);

    expect(state.gameOver).toEqual({
      reason: "WIPEOUT",
      winner: "BLUE",
      endedOnTurn: 1,
      points: { BLUE: 0, RED: 0 },
    });
    expect(kinds(events, "gameEnded")).toEqual([
      expect.objectContaining({ visibleTo: { BLUE: true, RED: true } }),
    ]);
    // RD-1 phase 11: no increment, and no hand drawn for a turn nobody plays.
    expect(state.turn).toBe(1);
    expect(state.sides.BLUE.hand).toEqual(doomed.sides.BLUE.hand);
  });

  it("never recomputes a stored ending, however often it is resolved again", () => {
    const doomed = fixture(1, (draft) => {
      for (const state of Object.values(draft.regions)) {
        state.presence.RED = 0;
      }
    });
    const finished = resolveTurn(SCENARIO, doomed, QUIET_TURN_1).state;

    const again = resolveTurn(SCENARIO, finished, {
      BLUE: orderSet("BLUE", finished.turn, []),
      RED: orderSet("RED", finished.turn, []),
    });

    // Identity, not equality: the record is the same object, so nothing has
    // re-derived it against a board that has moved on (FR-012).
    expect(again.state.gameOver).toBe(finished.gameOver);
    expect(kinds(again.events, "gameEnded")).toEqual([]);
    expect(again.state.turn).toBe(finished.turn);
  });

  it("ends the symmetric no-op game on COLLAPSE, not the turn limit it shares", () => {
    // The ladder's order is what decides this: both sides collapse on turn 16
    // (slice B's RD-12 attrition finding) and turn 16 is also the turn limit.
    const history = play(fixture(1), SCENARIO.turnLimit + 2);
    const last = history.at(-1);

    expect(history).toHaveLength(SCENARIO.turnLimit);
    expect(last?.gameOver).toEqual({
      reason: "COLLAPSE",
      winner: "DRAW",
      endedOnTurn: SCENARIO.turnLimit,
      points: { BLUE: 6, RED: 0 },
    });
    // BLUE banked its PORT objective at turn 8 and still only drew.
    expect(last?.objectiveHistory).toEqual([
      { objectiveId: "blue-hold-port", side: "BLUE", turn: 8 },
    ]);
  });

  it("plays a scripted game to a WIPEOUT, attrition doing the work", () => {
    // RED reduced to a 10-strong garrison in R-09 with no port to supply it:
    // the region falls out of supply, drains 2 a turn, and RED runs out of
    // presence on turn 5 — before its political capital runs out.
    const thin = fixture(1, (draft) => {
      for (const [regionId, state] of Object.entries(draft.regions)) {
        state.presence.RED = regionId === "R-09" ? 10 : 0;
        if (state.control === "RED" && regionId !== "R-09") {
          state.control = "NEUTRAL";
          state.lastController = "NEUTRAL";
        }
      }
    });

    const history = play(thin, SCENARIO.turnLimit);
    const last = history.at(-1);

    expect(last?.gameOver).toMatchObject({
      reason: "WIPEOUT",
      winner: "BLUE",
      endedOnTurn: 5,
    });
    expect(history).toHaveLength(5);
    expect(last?.sides.RED.political).toBeGreaterThan(0);
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
