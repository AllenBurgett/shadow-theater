import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { GameState, Scenario, Side, SupplyState } from "../contract/index.ts";
import { deepFreeze } from "../freeze.ts";
import { loadScenario } from "../scenario.ts";
import { createGame } from "./state.ts";
import type { AttritionLoss } from "./supply.ts";
import { ATTRITION_PER_TURN, applyAttrition, recomputeSupply } from "./supply.ts";

const RAW = readFileSync(new URL("../scenarios/vespera-01.json", import.meta.url), "utf8");
const SCENARIO: Scenario = loadScenario(JSON.parse(RAW) as unknown);
const BASE = createGame(SCENARIO, "vespera-01");

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

/**
 * Attrition losses in one region.
 *
 * `createGame`'s placeholder already leaves most of the opening board THIN or
 * CUT, so a whole-board loss list is never the assertion a case is about.
 */
function lossesAt(losses: AttritionLoss[], regionId: string): AttritionLoss[] {
  return losses.filter((loss) => loss.regionId === regionId);
}

/** Both sides' supply for one region, as the ladder assigned it. */
function supplyOf(state: GameState, regionId: string): Record<Side, SupplyState> {
  return regionOf(state, regionId).supply;
}

describe("recomputeSupply BFS (RD-12)", () => {
  it("supplies a side-controlled port and everything it reaches over usable links", () => {
    // Vespera's opening position: RED holds R-12 (PORT) and R-11, joined by
    // L-11-12 at capacity 2. R-09 is RED-held too, but every path to it
    // crosses a NEUTRAL region, so the BFS cannot enter it.
    const { state } = recomputeSupply(SCENARIO, BASE);

    expect(supplyOf(state, "R-12").RED).toBe("IN_SUPPLY");
    expect(supplyOf(state, "R-11").RED).toBe("IN_SUPPLY");
    expect(supplyOf(state, "R-09").RED).toBe("THIN");
  });

  it("stops at a link whose effective capacity interdiction has taken to 0", () => {
    // L-11-12's base capacity is 2, so it takes two stacked INTERDICTs (RD-7)
    // to close the only corridor out of RED's port.
    const cut = stateWith((draft) => {
      linkOf(draft, "L-11-12").effects = [
        { kind: "INTERDICT", side: "BLUE", expiresTurn: 3 },
        { kind: "INTERDICT", side: "BLUE", expiresTurn: 3 },
      ];
    });

    const { state } = recomputeSupply(SCENARIO, cut);

    expect(supplyOf(state, "R-12").RED).toBe("IN_SUPPLY");
    expect(supplyOf(state, "R-11").RED).toBe("THIN");
  });

  it("ignores a JAM, which masks intel but never costs capacity (RD-7)", () => {
    const jammed = stateWith((draft) => {
      linkOf(draft, "L-11-12").effects = [
        { kind: "JAM", side: "BLUE", expiresTurn: 3 },
        { kind: "JAM", side: "BLUE", expiresTurn: 3 },
      ];
    });

    expect(supplyOf(recomputeSupply(SCENARIO, jammed).state, "R-11").RED).toBe("IN_SUPPLY");
  });

  it("enters a CONTESTED region and supplies it for the side that reached it", () => {
    const contested = stateWith((draft) => {
      const bridge = regionOf(draft, "R-11");
      bridge.control = "CONTESTED";
      bridge.presence = { BLUE: 35, RED: 40 };
    });

    const { state } = recomputeSupply(SCENARIO, contested);

    // Reached by RED from R-12 — CONTESTED is enterable, so it is IN_SUPPLY
    // for RED even though RED does not control it. BLUE is merely present.
    expect(supplyOf(state, "R-11")).toEqual({ BLUE: "CUT", RED: "IN_SUPPLY" });
  });

  it("traverses through a CONTESTED region to reach what lies beyond it", () => {
    const corridor = stateWith((draft) => {
      const bridge = regionOf(draft, "R-11");
      bridge.control = "CONTESTED";
      bridge.presence = { BLUE: 35, RED: 40 };
      const beyond = regionOf(draft, "R-10");
      beyond.control = "RED";
      beyond.presence = { BLUE: 0, RED: 20 };
    });

    expect(supplyOf(recomputeSupply(SCENARIO, corridor).state, "R-10").RED).toBe("IN_SUPPLY");
  });

  it("reaches nothing for a side that holds no port", () => {
    const portless = stateWith((draft) => {
      const port = regionOf(draft, "R-12");
      port.control = "NEUTRAL";
      port.presence = { BLUE: 0, RED: 0 };
    });

    const { state } = recomputeSupply(SCENARIO, portless);

    expect(supplyOf(state, "R-11").RED).toBe("THIN");
    expect(supplyOf(state, "R-12").RED).toBe("NONE");
  });

  it("refuses a port the side does not control as a source", () => {
    const seized = stateWith((draft) => {
      const port = regionOf(draft, "R-12");
      port.control = "CONTESTED";
      port.presence = { BLUE: 55, RED: 60 };
    });

    // CONTESTED is enterable but never a source: RED's only port no longer
    // starts a reach set, so R-11 drops out of supply with it.
    const { state } = recomputeSupply(SCENARIO, seized);

    expect(supplyOf(state, "R-12").RED).toBe("CUT");
    expect(supplyOf(state, "R-11").RED).toBe("THIN");
  });
});

describe("recomputeSupply ordered assignment (RD-12)", () => {
  it("falls through reached, controlled, present, nothing — first match winning", () => {
    const ladder = stateWith((draft) => {
      // R-02: RED present but neither reached nor controlled → CUT.
      regionOf(draft, "R-02").presence = { BLUE: 0, RED: 5 };
    });

    const { state } = recomputeSupply(SCENARIO, ladder);

    expect(supplyOf(state, "R-12").RED).toBe("IN_SUPPLY");
    expect(supplyOf(state, "R-09").RED).toBe("THIN");
    expect(supplyOf(state, "R-02").RED).toBe("CUT");
    expect(supplyOf(state, "R-05").RED).toBe("NONE");
  });

  it("supersedes createGame's placeholder, which can never produce IN_SUPPLY", () => {
    // The placeholder starts BLUE's own port at THIN; the real ladder promotes
    // it the first time the phase runs.
    expect(supplyOf(BASE, "R-01").BLUE).toBe("THIN");
    expect(supplyOf(recomputeSupply(SCENARIO, BASE).state, "R-01").BLUE).toBe("IN_SUPPLY");
  });

  it("reports only the transitions that actually happened", () => {
    const { changes } = recomputeSupply(SCENARIO, BASE);

    expect(changes).toContainEqual({
      regionId: "R-01",
      side: "BLUE",
      from: "THIN",
      to: "IN_SUPPLY",
    });
    // R-03 is BLUE-held and unreachable: THIN before and THIN after.
    expect(changes.filter((change) => change.regionId === "R-03")).toEqual([]);
  });

  it("is a no-op on a state it has already assigned", () => {
    const once = recomputeSupply(SCENARIO, BASE);
    const twice = recomputeSupply(SCENARIO, once.state);

    expect(twice.changes).toEqual([]);
    expect(twice.state).toBe(once.state);
  });

  it("never mutates the state it is given", () => {
    const frozen = deepFreeze(structuredClone(BASE));

    expect(() => recomputeSupply(SCENARIO, frozen)).not.toThrow();
    expect(supplyOf(frozen, "R-01").BLUE).toBe("THIN");
  });
});

describe("applyAttrition (RD-12)", () => {
  it("drains presence in THIN and CUT and leaves IN_SUPPLY and NONE alone", () => {
    const board = stateWith((draft) => {
      regionOf(draft, "R-02").presence = { BLUE: 0, RED: 5 };
    });
    const supplied = recomputeSupply(SCENARIO, board).state;

    const { state, losses } = applyAttrition(supplied);

    // R-09 THIN and R-02 CUT both drain; R-12 IN_SUPPLY and R-05 NONE do not.
    expect(regionOf(state, "R-09").presence.RED).toBe(40 - ATTRITION_PER_TURN);
    expect(regionOf(state, "R-02").presence.RED).toBe(5 - ATTRITION_PER_TURN);
    expect(regionOf(state, "R-12").presence.RED).toBe(60);
    expect(losses).toContainEqual({ regionId: "R-09", side: "RED", amount: ATTRITION_PER_TURN });
    expect(losses).toContainEqual({ regionId: "R-02", side: "RED", amount: ATTRITION_PER_TURN });
  });

  it("runs the branch the prototype left dead: a controlled, unreachable region drains", () => {
    // mechanics-inventory §7: the prototype's assignment guaranteed a
    // side-controlled region was IN_SUPPLY or THIN, and its attrition only
    // fired on CUT — so no controlled region ever lost presence and THIN was
    // inert. RD-12 gives THIN a penalty, so R-03 (BLUE-held, port-unreachable
    // past NEUTRAL R-02) now drains.
    const supplied = recomputeSupply(SCENARIO, BASE).state;

    expect(supplyOf(supplied, "R-03").BLUE).toBe("THIN");
    expect(applyAttrition(supplied).losses).toContainEqual({
      regionId: "R-03",
      side: "BLUE",
      amount: ATTRITION_PER_TURN,
    });
  });

  it("clamps at 0 and reports the presence actually lost, not the nominal rate", () => {
    const remnant = stateWith((draft) => {
      const region = regionOf(draft, "R-02");
      region.presence = { BLUE: 0, RED: 1 };
      region.supply = { BLUE: "NONE", RED: "CUT" };
    });

    const { state, losses } = applyAttrition(remnant);

    expect(regionOf(state, "R-02").presence.RED).toBe(0);
    expect(lossesAt(losses, "R-02")).toEqual([{ regionId: "R-02", side: "RED", amount: 1 }]);
  });

  it("emits nothing for a side already at zero presence", () => {
    const empty = stateWith((draft) => {
      const region = regionOf(draft, "R-02");
      region.presence = { BLUE: 0, RED: 0 };
      region.supply = { BLUE: "CUT", RED: "CUT" };
    });

    const { state, losses } = applyAttrition(empty);

    expect(lossesAt(losses, "R-02")).toEqual([]);
    expect(state.regions["R-02"]).toBe(empty.regions["R-02"]);
  });

  it("returns the same state when no side is out of supply anywhere", () => {
    const fed = stateWith((draft) => {
      for (const region of Object.values(draft.regions)) {
        region.supply = { BLUE: "IN_SUPPLY", RED: "NONE" };
      }
    });

    const { state, losses } = applyAttrition(fed);

    expect(losses).toEqual([]);
    expect(state).toBe(fed);
  });

  it("drains both sides of the same region independently", () => {
    const shared = stateWith((draft) => {
      const region = regionOf(draft, "R-02");
      region.presence = { BLUE: 12, RED: 8 };
      region.supply = { BLUE: "CUT", RED: "THIN" };
    });

    const { state, losses } = applyAttrition(shared);

    expect(regionOf(state, "R-02").presence).toEqual({ BLUE: 10, RED: 6 });
    expect(lossesAt(losses, "R-02")).toHaveLength(2);
  });

  it("never mutates the state it is given", () => {
    const frozen = deepFreeze(recomputeSupply(SCENARIO, structuredClone(BASE)).state);

    expect(() => applyAttrition(frozen)).not.toThrow();
    expect(regionOf(frozen, "R-03").presence.BLUE).toBe(40);
  });
});
