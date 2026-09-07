import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Control, Scenario, Side } from "../contract/index.ts";
import { GameStateSchema } from "../contract/index.ts";
import { loadScenario } from "../scenario.ts";
import { resolveControl } from "./control.ts";
import { drawHands } from "./hands.ts";
import { createGame, UNOBSERVED_INTEL_AGE } from "./state.ts";

const RAW = readFileSync(new URL("../scenarios/vespera-01.json", import.meta.url), "utf8");
const SCENARIO = loadScenario(JSON.parse(RAW) as unknown);
const SEED = "vespera-01";
const SIDES: readonly Side[] = ["BLUE", "RED"];

/** The control the scenario *declares* for a region, per side setup list. */
function declaredControl(scenario: Scenario, regionId: string): Control {
  for (const side of SIDES) {
    if (scenario.setup.sides[side].control.includes(regionId)) {
      return side;
    }
  }
  return "NEUTRAL";
}

/** Loads a variant of the shipped scenario for a start position it does not author. */
function variantScenario(mutate: (json: Record<string, unknown>) => void): Scenario {
  const json = JSON.parse(RAW) as Record<string, unknown>;
  mutate(json);
  return loadScenario(json);
}

describe("createGame", () => {
  it("produces a state that satisfies the wire contract", () => {
    const state = createGame(SCENARIO, SEED);

    expect(GameStateSchema.safeParse(state).success).toBe(true);
    expect(state.scenarioId).toBe(SCENARIO.id);
    expect(state.seed).toBe(SEED);
    expect(state.turn).toBe(1);
  });

  it("applies the scenario's declared control, which agrees with RD-13", () => {
    // Initial control is declarative (the prototype set it explicitly and the
    // scenario authors it), so this invariant is what stops a scenario from
    // declaring a control its own presence numbers contradict.
    const state = createGame(SCENARIO, SEED);

    for (const region of SCENARIO.map.regions) {
      const declared = declaredControl(SCENARIO, region.id);
      const regionState = state.regions[region.id];

      expect(regionState?.control).toBe(declared);
      expect(resolveControl(regionState?.presence ?? { BLUE: 0, RED: 0 })).toBe(declared);
    }
  });

  it("seeds lastController with the initial control", () => {
    const state = createGame(SCENARIO, SEED);

    for (const regionState of Object.values(state.regions)) {
      expect(regionState.lastController).toBe(regionState.control);
    }
  });

  it("applies setup presence exactly and starts fort and unrest at 0", () => {
    const state = createGame(SCENARIO, SEED);

    for (const region of SCENARIO.map.regions) {
      const regionState = state.regions[region.id];

      for (const side of SIDES) {
        expect(regionState?.presence[side]).toBe(
          SCENARIO.setup.sides[side].presence[region.id] ?? 0,
        );
      }
      expect(regionState?.fort).toBe(0);
      expect(regionState?.unrest).toBe(0);
    }
    expect(state.regions["R-01"]?.presence).toEqual({ BLUE: 60, RED: 0 });
    expect(state.regions["R-09"]?.presence).toEqual({ BLUE: 0, RED: 40 });
  });

  it("starts intel age at 0 where the side has setup presence and UNKNOWN elsewhere", () => {
    const state = createGame(SCENARIO, SEED);

    for (const side of SIDES) {
      for (const region of SCENARIO.map.regions) {
        const observed = (SCENARIO.setup.sides[side].presence[region.id] ?? 0) > 0;

        expect(state.sides[side].intelAge[region.id]).toBe(observed ? 0 : UNOBSERVED_INTEL_AGE);
      }
    }
    // RD-9 renders ≤ 2 as LIKELY, so 3 is the smallest value that reads
    // UNKNOWN — a side has observed nothing but its own starting regions.
    expect(UNOBSERVED_INTEL_AGE).toBe(3);
    expect(state.sides.BLUE.intelAge["R-01"]).toBe(0);
    expect(state.sides.BLUE.intelAge["R-12"]).toBe(3);
    expect(state.sides.RED.intelAge["R-12"]).toBe(0);
    expect(state.sides.RED.intelAge["R-01"]).toBe(3);
  });

  it("starts both sides at the scenario's political capital", () => {
    const state = createGame(SCENARIO, SEED);

    expect(state.sides.BLUE.political).toBe(SCENARIO.resources.politicalStart);
    expect(state.sides.RED.political).toBe(SCENARIO.resources.politicalStart);
  });

  it("draws both sides' turn-1 hands", () => {
    const state = createGame(SCENARIO, SEED);
    const expected = drawHands(SCENARIO, SEED, 1);

    expect(state.sides.BLUE.hand).toEqual(expected.BLUE);
    expect(state.sides.RED.hand).toEqual(expected.RED);
    expect(state.sides.BLUE.hand).toHaveLength(SCENARIO.handSize);
  });

  it("starts controlled regions THIN and unheld regions NONE", () => {
    const state = createGame(SCENARIO, SEED);

    expect(state.regions["R-01"]?.supply).toEqual({ BLUE: "THIN", RED: "NONE" });
    expect(state.regions["R-12"]?.supply).toEqual({ BLUE: "NONE", RED: "THIN" });
    expect(state.regions["R-05"]?.supply).toEqual({ BLUE: "NONE", RED: "NONE" });
    // No region starts IN_SUPPLY: that tier needs the port-reachability BFS,
    // which is T019 (issue #15) and supersedes this initialisation.
    for (const regionState of Object.values(state.regions)) {
      for (const side of SIDES) {
        expect(regionState.supply[side]).not.toBe("IN_SUPPLY");
      }
    }
  });

  it("starts an uncontrolled region where the side is present CUT", () => {
    const scenario = variantScenario((json) => {
      const setup = json.setup as { sides: { BLUE: { presence: Record<string, number> } } };
      setup.sides.BLUE.presence["R-02"] = 20;
    });
    const state = createGame(scenario, SEED);

    expect(state.regions["R-02"]?.supply).toEqual({ BLUE: "CUT", RED: "NONE" });
  });

  it("starts every link with no effects", () => {
    const state = createGame(SCENARIO, SEED);

    expect(Object.keys(state.links)).toEqual(SCENARIO.map.links.map((link) => link.id));
    for (const linkState of Object.values(state.links)) {
      expect(linkState.effects).toEqual([]);
    }
  });

  it("starts with no contacts, no objective records, and no ending", () => {
    const state = createGame(SCENARIO, SEED);

    expect(state.contacts).toEqual([]);
    expect(state.objectiveHistory).toEqual([]);
    expect(state.objectiveProgress).toEqual([]);
    expect(state.gameOver).toBeNull();
  });

  it("does not mutate the frozen scenario", () => {
    expect(Object.isFrozen(SCENARIO)).toBe(true);
    const before = JSON.stringify(SCENARIO);

    createGame(SCENARIO, SEED);

    expect(JSON.stringify(SCENARIO)).toBe(before);
  });
});
