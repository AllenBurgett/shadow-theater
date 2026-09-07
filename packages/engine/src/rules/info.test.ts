import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Contact, Effect, GameState, Scenario } from "../contract/index.ts";
import { deepFreeze } from "../freeze.ts";
import { createRng } from "../rng.ts";
import { loadScenario } from "../scenario.ts";
import { counterintelSweep, focusedIsrSweep, jammingCorridor, spoofContacts } from "./info.ts";
import { effectiveCapacity } from "./legality.ts";
import { createGame } from "./state.ts";

const RAW = readFileSync(new URL("../scenarios/vespera-01.json", import.meta.url), "utf8");
const SCENARIO: Scenario = loadScenario(JSON.parse(RAW) as unknown);
const SEED = "vespera-01";
const BASE = createGame(SCENARIO, SEED);

function stateWith(mutate: (draft: GameState) => void): GameState {
  const draft = structuredClone(BASE);
  mutate(draft);
  return draft;
}

function applied(outcome: ReturnType<typeof focusedIsrSweep>) {
  if (!outcome.applied) {
    throw new Error(`expected the operation to apply: ${outcome.reason}`);
  }
  return outcome;
}

/** The per-turn rumor substream the resolver forks once per side (RD-9). */
function rumorRng(side: "BLUE" | "RED", turn: number) {
  return createRng(SEED).fork(`rumor:${side}:${turn}`);
}

function contactIn(state: GameState, regionId: string): Contact | undefined {
  return state.contacts.find((contact) => contact.regionId === regionId);
}

describe("focusedIsrSweep (RD-2a, RD-9)", () => {
  it("sets the acting side's intel age for the region to 0", () => {
    const outcome = applied(focusedIsrSweep(BASE, "BLUE", "R-05"));

    expect(BASE.sides.BLUE.intelAge["R-05"]).toBe(3);
    expect(outcome.state.sides.BLUE.intelAge["R-05"]).toBe(0);
    expect(outcome.effects).toEqual<Effect[]>([
      { kind: "intelRefreshed", regionId: "R-05", side: "BLUE" },
    ]);
  });

  it("leaves the other side's intel and every other region alone", () => {
    const outcome = applied(focusedIsrSweep(BASE, "BLUE", "R-05"));

    expect(outcome.state.sides.RED.intelAge).toEqual(BASE.sides.RED.intelAge);
    expect(outcome.state.sides.BLUE.intelAge["R-06"]).toBe(3);
  });
});

describe("jammingCorridor (RD-2a, RD-7)", () => {
  it("adds a side-owned JAM expiring two turns out", () => {
    const outcome = applied(jammingCorridor(BASE, "RED", "L-01-02"));

    expect(outcome.effects).toEqual<Effect[]>([
      {
        kind: "linkEffectAdded",
        linkId: "L-01-02",
        effect: { kind: "JAM", side: "RED", expiresTurn: 3 },
      },
    ]);
  });

  it("does not reduce effective capacity — JAM masks intel only", () => {
    const outcome = applied(jammingCorridor(BASE, "RED", "L-01-02"));

    expect(effectiveCapacity(SCENARIO, outcome.state, "L-01-02")).toBe(2);
  });
});

describe("spoofContacts (RD-2a, RD-9)", () => {
  it("creates a contact carrying the operation's theme", () => {
    const outcome = applied(
      spoofContacts(BASE, "BLUE", "R-11", "armour-massing", rumorRng("BLUE", 1)),
    );
    const contact = contactIn(outcome.state, "R-11");

    expect(contact).toMatchObject({
      side: "BLUE",
      regionId: "R-11",
      kind: "armour-massing",
      expiresTurn: 3,
    });
    expect(outcome.effects).toEqual<Effect[]>([
      { kind: "contactCreated", contact: contact as Contact },
    ]);
  });

  it("defaults an absent theme to recon-activity", () => {
    const outcome = applied(spoofContacts(BASE, "BLUE", "R-11", null, rumorRng("BLUE", 1)));

    expect(contactIn(outcome.state, "R-11")?.kind).toBe("recon-activity");
  });

  it("derives the id from the rumor substream, reproducibly", () => {
    const first = applied(spoofContacts(BASE, "BLUE", "R-11", null, rumorRng("BLUE", 1)));
    const again = applied(spoofContacts(BASE, "BLUE", "R-11", null, rumorRng("BLUE", 1)));

    expect(contactIn(first.state, "R-11")?.id).toBe(contactIn(again.state, "R-11")?.id);
  });

  it("gives every contact its own id, including repeat plays in one turn", () => {
    // A hand is a permission set, so SPOOF_CONTACTS can be played twice in the
    // same turn: the resolver forks the substream once and each play consumes
    // exactly one draw from it.
    const rng = rumorRng("BLUE", 1);
    const once = applied(spoofContacts(BASE, "BLUE", "R-11", null, rng));
    const twice = applied(spoofContacts(once.state, "BLUE", "R-10", null, rng));

    expect(twice.state.contacts).toHaveLength(2);
    expect(contactIn(twice.state, "R-11")?.id).not.toBe(contactIn(twice.state, "R-10")?.id);

    const red = applied(spoofContacts(BASE, "RED", "R-11", null, rumorRng("RED", 1)));
    const laterTurn = applied(spoofContacts(BASE, "BLUE", "R-11", null, rumorRng("BLUE", 2)));
    expect(contactIn(red.state, "R-11")?.id).not.toBe(contactIn(once.state, "R-11")?.id);
    expect(contactIn(laterTurn.state, "R-11")?.id).not.toBe(contactIn(once.state, "R-11")?.id);
  });

  it("keeps the id opaque, since ContactView exposes it verbatim", () => {
    // RD-9: a contact never discloses its author, but the view carries the id
    // as-is — so the id itself must not spell out the side or the turn.
    const id = contactIn(
      applied(spoofContacts(BASE, "RED", "R-11", null, rumorRng("RED", 4))).state,
      "R-11",
    )?.id;

    expect(id).toMatch(/^contact-[0-9a-f]{8}$/);
    expect(id).not.toContain("RED");
    expect(id).not.toContain("rumor");
  });
});

describe("counterintelSweep (RD-2a)", () => {
  const seeded = stateWith((draft) => {
    draft.contacts.push(
      {
        id: "contact-aaaaaaa1",
        side: "RED",
        regionId: "R-01",
        kind: "recon-activity",
        expiresTurn: 3,
      },
      {
        id: "contact-aaaaaaa2",
        side: "RED",
        regionId: "R-01",
        kind: "supply-buildup",
        expiresTurn: 4,
      },
      {
        id: "contact-aaaaaaa3",
        side: "RED",
        regionId: "R-03",
        kind: "recon-activity",
        expiresTurn: 3,
      },
      {
        id: "contact-aaaaaaa4",
        side: "BLUE",
        regionId: "R-01",
        kind: "armour-massing",
        expiresTurn: 3,
      },
    );
  });

  it("removes every enemy contact in the region and nothing else", () => {
    const outcome = applied(counterintelSweep(seeded, "BLUE", "R-01"));

    expect(outcome.state.contacts.map((contact) => contact.id)).toEqual([
      "contact-aaaaaaa3",
      "contact-aaaaaaa4",
    ]);
    expect(outcome.effects).toHaveLength(2);
    expect(outcome.effects[0]).toMatchObject({ kind: "contactRemoved" });
  });

  it("applies with no effects when the region is clean", () => {
    const outcome = applied(counterintelSweep(seeded, "BLUE", "R-05"));

    expect(outcome.effects).toEqual([]);
    expect(outcome.state.contacts).toEqual(seeded.contacts);
  });
});

describe("info op invariants", () => {
  it("reports a target that is not on the map instead of throwing", () => {
    const outcomes = [
      focusedIsrSweep(BASE, "BLUE", "R-99"),
      jammingCorridor(BASE, "BLUE", "L-99-99"),
      spoofContacts(BASE, "BLUE", "R-99", null, rumorRng("BLUE", 1)),
      counterintelSweep(BASE, "BLUE", "R-99"),
    ];

    for (const outcome of outcomes) {
      expect(outcome.applied).toBe(false);
    }
  });

  it("never mutates the state it is given", () => {
    const frozen = deepFreeze(structuredClone(BASE));
    const before = JSON.stringify(frozen);

    focusedIsrSweep(frozen, "BLUE", "R-05");
    jammingCorridor(frozen, "BLUE", "L-01-02");
    spoofContacts(frozen, "BLUE", "R-11", null, rumorRng("BLUE", 1));
    counterintelSweep(frozen, "BLUE", "R-01");

    expect(JSON.stringify(frozen)).toBe(before);
  });
});
