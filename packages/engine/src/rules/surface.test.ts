import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Effect, GameState, LinkEffect, Scenario } from "../contract/index.ts";
import { deepFreeze } from "../freeze.ts";
import { loadScenario } from "../scenario.ts";
import { effectiveCapacity } from "./legality.ts";
import { createGame } from "./state.ts";
import {
  deliberateAdvance,
  fortifyRegion,
  interdictLink,
  rapidRedeploy,
  secureCorridor,
} from "./surface.ts";

const RAW = readFileSync(new URL("../scenarios/vespera-01.json", import.meta.url), "utf8");
const SCENARIO: Scenario = loadScenario(JSON.parse(RAW) as unknown);
const BASE = createGame(SCENARIO, "vespera-01");
const NONE: ReadonlySet<string> = new Set<string>();

function stateWith(mutate: (draft: GameState) => void): GameState {
  const draft = structuredClone(BASE);
  mutate(draft);
  return draft;
}

function regionOf(state: GameState, regionId: string) {
  const region = state.regions[regionId];
  if (!region) {
    throw new Error(`test fixture is missing region ${regionId}`);
  }
  return region;
}

function linkOf(state: GameState, linkId: string) {
  const link = state.links[linkId];
  if (!link) {
    throw new Error(`test fixture is missing link ${linkId}`);
  }
  return link;
}

function applied(outcome: ReturnType<typeof deliberateAdvance>) {
  if (!outcome.applied) {
    throw new Error(`expected the operation to apply: ${outcome.reason}`);
  }
  return outcome;
}

const RED_INTERDICT: LinkEffect = { kind: "INTERDICT", side: "RED", expiresTurn: 3 };

describe("deliberateAdvance (RD-2a)", () => {
  it("bases at 10 when no supporting region is in supply, and re-resolves control", () => {
    const outcome = applied(deliberateAdvance(SCENARIO, BASE, "BLUE", "R-02"));

    expect(regionOf(outcome.state, "R-02").presence).toEqual({ BLUE: 10, RED: 0 });
    expect(outcome.effects).toEqual<Effect[]>([
      { kind: "presenceChanged", regionId: "R-02", side: "BLUE", delta: 10 },
    ]);
    expect(outcome.controlChanges).toEqual([{ regionId: "R-02", from: "NEUTRAL", to: "BLUE" }]);
  });

  it("bases at 18 when any supporting held region is IN_SUPPLY (existential)", () => {
    // No source is named in the operation and none is debited: it is enough
    // that one adjacent held region is in supply.
    const supplied = stateWith((draft) => {
      regionOf(draft, "R-01").supply.BLUE = "IN_SUPPLY";
    });

    expect(
      regionOf(applied(deliberateAdvance(SCENARIO, supplied, "BLUE", "R-02")).state, "R-02")
        .presence.BLUE,
    ).toBe(18);
  });

  it("ignores an in-supply supporter whose link is interdicted to 0", () => {
    // R-02 also touches BLUE's R-03 by L-02-03, so the advance stays legal but
    // loses the supplied source and falls back to base 10.
    const cut = stateWith((draft) => {
      regionOf(draft, "R-01").supply.BLUE = "IN_SUPPLY";
      linkOf(draft, "L-01-02").effects.push(RED_INTERDICT, RED_INTERDICT);
    });

    expect(
      regionOf(applied(deliberateAdvance(SCENARIO, cut, "BLUE", "R-02")).state, "R-02").presence
        .BLUE,
    ).toBe(10);
  });

  it("damages the defender by base - fort*4 and never heals it", () => {
    const held = stateWith((draft) => {
      const region = regionOf(draft, "R-02");
      region.presence.RED = 40;
      region.control = "RED";
      region.fort = 1;
    });

    expect(
      regionOf(applied(deliberateAdvance(SCENARIO, held, "BLUE", "R-02")).state, "R-02").presence
        .RED,
    ).toBe(34);
  });

  it("floors defender damage at 0 so a fort never hands presence back", () => {
    // Prototype defect (mechanics-inventory §2): base 10 against fort 3 gave
    // the defender +2. RD-2a floors the damage at 0.
    const fortified = stateWith((draft) => {
      const region = regionOf(draft, "R-02");
      region.presence.RED = 40;
      region.control = "RED";
      region.fort = 3;
    });
    const outcome = applied(deliberateAdvance(SCENARIO, fortified, "BLUE", "R-02"));

    expect(regionOf(outcome.state, "R-02").presence.RED).toBe(40);
    expect(outcome.effects).toEqual<Effect[]>([
      { kind: "presenceChanged", regionId: "R-02", side: "BLUE", delta: 10 },
    ]);
  });

  it("clamps both presences to 0..100 and reports the delta actually applied", () => {
    const extreme = stateWith((draft) => {
      const region = regionOf(draft, "R-02");
      region.presence.BLUE = 95;
      region.presence.RED = 5;
      region.control = "BLUE";
    });
    const outcome = applied(deliberateAdvance(SCENARIO, extreme, "BLUE", "R-02"));

    expect(regionOf(outcome.state, "R-02").presence).toEqual({ BLUE: 100, RED: 0 });
    expect(outcome.effects).toEqual<Effect[]>([
      { kind: "presenceChanged", regionId: "R-02", side: "BLUE", delta: 5 },
      { kind: "presenceChanged", regionId: "R-02", side: "RED", delta: -5 },
    ]);
  });

  it("mirrors for RED, damaging the BLUE defender", () => {
    // R-03 is BLUE-held and joined to RED's R-09 by L-03-09.
    const outcome = applied(deliberateAdvance(SCENARIO, BASE, "RED", "R-03"));

    expect(regionOf(outcome.state, "R-03").presence).toEqual({ BLUE: 30, RED: 10 });
    expect(outcome.controlChanges).toEqual([]);
  });

  it("leaves lastController alone — RD-8 writes it once at the end of evaluation", () => {
    const outcome = applied(deliberateAdvance(SCENARIO, BASE, "BLUE", "R-02"));

    expect(regionOf(outcome.state, "R-02").lastController).toBe("NEUTRAL");
  });
});

describe("rapidRedeploy (RD-2a)", () => {
  it("moves 25% of the stronger endpoint and re-resolves both ends", () => {
    const outcome = applied(rapidRedeploy(SCENARIO, BASE, "BLUE", "L-01-02"));

    expect(regionOf(outcome.state, "R-01").presence.BLUE).toBe(45);
    expect(regionOf(outcome.state, "R-02").presence.BLUE).toBe(15);
    expect(outcome.effects).toEqual<Effect[]>([
      { kind: "presenceChanged", regionId: "R-01", side: "BLUE", delta: -15 },
      { kind: "presenceChanged", regionId: "R-02", side: "BLUE", delta: 15 },
    ]);
    expect(outcome.controlChanges).toEqual([{ regionId: "R-02", from: "NEUTRAL", to: "BLUE" }]);
  });

  it("floors the move at 5, so a 10-presence source moves half of itself", () => {
    const thin = stateWith((draft) => {
      regionOf(draft, "R-01").presence.BLUE = 10;
    });
    const outcome = applied(rapidRedeploy(SCENARIO, thin, "BLUE", "L-01-02"));

    expect(regionOf(outcome.state, "R-01").presence.BLUE).toBe(5);
    expect(regionOf(outcome.state, "R-02").presence.BLUE).toBe(5);
    expect(outcome.controlChanges).toEqual([
      { regionId: "R-01", from: "BLUE", to: "CONTESTED" },
      { regionId: "R-02", from: "NEUTRAL", to: "CONTESTED" },
    ]);
  });

  it("caps the move at 20", () => {
    const massed = stateWith((draft) => {
      regionOf(draft, "R-01").presence.BLUE = 100;
    });
    const outcome = applied(rapidRedeploy(SCENARIO, massed, "BLUE", "L-01-02"));

    expect(regionOf(outcome.state, "R-01").presence.BLUE).toBe(80);
    expect(regionOf(outcome.state, "R-02").presence.BLUE).toBe(20);
  });

  it("breaks a friendly-presence tie toward link.a", () => {
    const tied = stateWith((draft) => {
      regionOf(draft, "R-01").presence.BLUE = 40;
      regionOf(draft, "R-02").presence.BLUE = 40;
    });
    const outcome = applied(rapidRedeploy(SCENARIO, tied, "BLUE", "L-01-02"));

    expect(regionOf(outcome.state, "R-01").presence.BLUE).toBe(30);
    expect(regionOf(outcome.state, "R-02").presence.BLUE).toBe(50);
  });

  it("moves from b when b is the stronger endpoint", () => {
    const reversed = stateWith((draft) => {
      regionOf(draft, "R-01").presence.BLUE = 20;
      regionOf(draft, "R-02").presence.BLUE = 60;
    });
    const outcome = applied(rapidRedeploy(SCENARIO, reversed, "BLUE", "L-01-02"));

    expect(regionOf(outcome.state, "R-02").presence.BLUE).toBe(45);
    expect(regionOf(outcome.state, "R-01").presence.BLUE).toBe(35);
  });
});

describe("fortifyRegion (RD-2a, RD-5)", () => {
  it("raises the fort by one and reports the change", () => {
    const outcome = applied(fortifyRegion(BASE, "R-01", NONE));

    expect(regionOf(outcome.state, "R-01").fort).toBe(1);
    expect(outcome.effects).toEqual<Effect[]>([
      { kind: "fortChanged", regionId: "R-01", from: 0, to: 1 },
    ]);
    expect(outcome.controlChanges).toEqual([]);
  });

  it("refuses a second raise of the same region in one turn", () => {
    // RD-2a's +1-per-region-per-turn cap. The bookkeeping is the resolver's:
    // nothing about it is stored in GameState.
    const outcome = fortifyRegion(BASE, "R-01", new Set(["R-01"]));

    expect(outcome.applied).toBe(false);
    expect(outcome.applied ? "" : outcome.reason).toMatch(/this turn/);
  });

  it("refuses to exceed the fort ceiling", () => {
    const maxed = stateWith((draft) => {
      regionOf(draft, "R-01").fort = 3;
    });

    expect(fortifyRegion(maxed, "R-01", NONE).applied).toBe(false);
  });
});

describe("interdictLink and secureCorridor (RD-2a, RD-7)", () => {
  it("stacks INTERDICT effects, each costing one capacity", () => {
    const first = applied(interdictLink(BASE, "BLUE", "L-01-02"));
    const second = applied(interdictLink(first.state, "BLUE", "L-01-02"));

    expect(first.effects).toEqual<Effect[]>([
      {
        kind: "linkEffectAdded",
        linkId: "L-01-02",
        effect: { kind: "INTERDICT", side: "BLUE", expiresTurn: 3 },
      },
    ]);
    expect(effectiveCapacity(SCENARIO, first.state, "L-01-02")).toBe(1);
    expect(effectiveCapacity(SCENARIO, second.state, "L-01-02")).toBe(0);
  });

  it("restores capacity once the effect expires", () => {
    // Added on turn 1 with expiresTurn 3: active at turn ends 1 and 2, gone
    // from turn 3 (RD-2a timing, read by effectiveCapacity as turn < expires).
    const interdicted = applied(interdictLink(BASE, "BLUE", "L-01-02")).state;

    expect(effectiveCapacity(SCENARIO, { ...interdicted, turn: 2 }, "L-01-02")).toBe(1);
    expect(effectiveCapacity(SCENARIO, { ...interdicted, turn: 3 }, "L-01-02")).toBe(2);
  });

  it("removes every enemy effect and keeps its own", () => {
    const contested = stateWith((draft) => {
      linkOf(draft, "L-01-02").effects.push(
        { kind: "INTERDICT", side: "RED", expiresTurn: 3 },
        { kind: "JAM", side: "RED", expiresTurn: 3 },
        { kind: "JAM", side: "BLUE", expiresTurn: 3 },
      );
    });
    const outcome = applied(secureCorridor(contested, "BLUE", "L-01-02"));

    expect(linkOf(outcome.state, "L-01-02").effects).toEqual([
      { kind: "JAM", side: "BLUE", expiresTurn: 3 },
    ]);
    expect(outcome.effects).toEqual<Effect[]>([
      {
        kind: "linkEffectRemoved",
        linkId: "L-01-02",
        effect: { kind: "INTERDICT", side: "RED", expiresTurn: 3 },
      },
      {
        kind: "linkEffectRemoved",
        linkId: "L-01-02",
        effect: { kind: "JAM", side: "RED", expiresTurn: 3 },
      },
    ]);
  });

  it("never inflates capacity above the map base", () => {
    // A flagged change from the prototype, which added +1 per SECURE_CORRIDOR
    // and could raise a link above its authored capacity.
    const outcome = applied(secureCorridor(BASE, "BLUE", "L-01-02"));

    expect(effectiveCapacity(SCENARIO, outcome.state, "L-01-02")).toBe(2);
    expect(outcome.effects).toEqual([]);
  });
});

describe("surface op invariants", () => {
  it("reports a target that is not on the map instead of throwing", () => {
    const outcomes = [
      deliberateAdvance(SCENARIO, BASE, "BLUE", "R-99"),
      rapidRedeploy(SCENARIO, BASE, "BLUE", "L-99-99"),
      fortifyRegion(BASE, "R-99", NONE),
      interdictLink(BASE, "BLUE", "L-99-99"),
      secureCorridor(BASE, "BLUE", "L-99-99"),
    ];

    for (const outcome of outcomes) {
      expect(outcome.applied).toBe(false);
    }
  });

  it("reports a link whose endpoint the state does not track", () => {
    const { "R-01": _a, ...withoutA } = BASE.regions;
    const { "R-02": _b, ...withoutB } = BASE.regions;

    expect(rapidRedeploy(SCENARIO, { ...BASE, regions: withoutA }, "BLUE", "L-01-02").applied).toBe(
      false,
    );
    expect(rapidRedeploy(SCENARIO, { ...BASE, regions: withoutB }, "BLUE", "L-01-02").applied).toBe(
      false,
    );
  });

  it("never mutates the state it is given", () => {
    const frozen = deepFreeze(structuredClone(BASE));
    const before = JSON.stringify(frozen);

    deliberateAdvance(SCENARIO, frozen, "BLUE", "R-02");
    rapidRedeploy(SCENARIO, frozen, "BLUE", "L-01-02");
    fortifyRegion(frozen, "R-01", NONE);
    interdictLink(frozen, "BLUE", "L-01-02");
    secureCorridor(frozen, "BLUE", "L-01-02");

    expect(JSON.stringify(frozen)).toBe(before);
  });
});
