import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { GameState, PostureBand, Scenario, Side } from "../contract/index.ts";
import { deepFreeze } from "../freeze.ts";
import { loadScenario } from "../scenario.ts";
import {
  HABITAT_DRAIN,
  politicalUpkeep,
  postureBand,
  UNREST_DRAIN_LEVEL,
  writeLastController,
} from "./political.ts";
import { createGame } from "./state.ts";

const RAW = readFileSync(new URL("../scenarios/vespera-01.json", import.meta.url), "utf8");
const SCENARIO: Scenario = loadScenario(JSON.parse(RAW) as unknown);

/**
 * The same scenario with its `habitatLossPoliticalPenalty` removed — the
 * anti-ghost-rule control (review M3): a constraint the scenario does not
 * declare must cost nothing at all.
 */
const NO_CONSTRAINTS: Scenario = loadScenario({
  ...(JSON.parse(RAW) as Record<string, unknown>),
  constraints: [],
});

const BASE = createGame(SCENARIO, "vespera-01");

/** The scenario's two HABITATs: BLUE opens holding R-03, RED holding R-09. */
const BLUE_HABITAT = "R-03";
const RED_HABITAT = "R-09";

function stateWith(mutate?: (draft: GameState) => void): GameState {
  const draft = structuredClone(BASE);
  mutate?.(draft);
  return draft;
}

function regionOf(state: GameState, regionId: string) {
  const region = state.regions[regionId];
  if (!region) {
    throw new Error(`test fixture is missing region ${regionId}`);
  }
  return region;
}

function political(state: GameState): Record<Side, number> {
  return { BLUE: state.sides.BLUE.political, RED: state.sides.RED.political };
}

/** Sets a side's political capital directly, to reach a band boundary cheaply. */
function withPolitical(draft: GameState, side: Side, value: number): void {
  draft.sides[side].political = value;
}

describe("postureBand (RD-4)", () => {
  it("puts the exact thresholds on the sides RD-4 names", () => {
    const bands = [20, 13, 12, 6, 5, 0, -4].map(postureBand);

    expect(bands).toEqual<PostureBand[]>([
      "STABLE",
      "STABLE",
      "STRAINED",
      "STRAINED",
      "CRITICAL",
      "CRITICAL",
      "CRITICAL",
    ]);
  });
});

describe("politicalUpkeep drains (RD-4)", () => {
  it("charges 1 per HABITAT the side does not control", () => {
    // Opening position: each side holds one habitat and not the other.
    const { state, drains } = politicalUpkeep(SCENARIO, BASE);

    expect(political(state)).toEqual({ BLUE: 19, RED: 19 });
    expect(drains).toEqual([
      { side: "BLUE", from: 20, to: 19, cause: "habitatNotControlled" },
      { side: "RED", from: 20, to: 19, cause: "habitatNotControlled" },
    ]);
  });

  it("charges 1 per controlled HABITAT at unrest >= 2", () => {
    const restive = stateWith((draft) => {
      regionOf(draft, BLUE_HABITAT).unrest = UNREST_DRAIN_LEVEL;
    });

    const { state, drains } = politicalUpkeep(SCENARIO, restive);

    expect(political(state).BLUE).toBe(18);
    expect(drains.filter((drain) => drain.side === "BLUE")).toEqual([
      { side: "BLUE", from: 20, to: 19, cause: "habitatNotControlled" },
      { side: "BLUE", from: 19, to: 18, cause: "habitatUnrest" },
    ]);
  });

  it("leaves a controlled HABITAT below the unrest level alone", () => {
    const calm = stateWith((draft) => {
      regionOf(draft, BLUE_HABITAT).unrest = UNREST_DRAIN_LEVEL - 1;
    });

    expect(political(politicalUpkeep(SCENARIO, calm).state).BLUE).toBe(19);
  });

  it("keeps the two clauses mutually exclusive per region", () => {
    // R-03 is unrest 3 but no longer BLUE's: it bills as an unheld habitat
    // once, never as both an unheld habitat and a restive one.
    const lost = stateWith((draft) => {
      const habitat = regionOf(draft, BLUE_HABITAT);
      habitat.control = "RED";
      habitat.lastController = "RED";
      habitat.unrest = 3;
    });

    const drains = politicalUpkeep(SCENARIO, lost).drains.filter((drain) => drain.side === "BLUE");

    expect(drains).toEqual([{ side: "BLUE", from: 20, to: 18, cause: "habitatNotControlled" }]);
  });

  it("caps the constraint-free drain at 2 a turn on this scenario", () => {
    // Two habitats, so two units is the ceiling however they are distributed.
    const worst = stateWith((draft) => {
      regionOf(draft, BLUE_HABITAT).unrest = 3;
      const enemyHabitat = regionOf(draft, RED_HABITAT);
      enemyHabitat.control = "BLUE";
      enemyHabitat.lastController = "BLUE";
      enemyHabitat.unrest = 3;
    });

    expect(political(politicalUpkeep(SCENARIO, worst).state).BLUE).toBe(18);
  });

  it("does not clamp at zero, so slice C can see how far past it a side went", () => {
    const spent = stateWith((draft) => {
      withPolitical(draft, "BLUE", 1);
    });

    expect(political(politicalUpkeep(SCENARIO, spent).state).BLUE).toBe(0);
    expect(
      political(
        politicalUpkeep(
          SCENARIO,
          stateWith((draft) => {
            withPolitical(draft, "BLUE", -1);
          }),
        ).state,
      ).BLUE,
    ).toBe(-2);
  });

  it("skips a HABITAT the state does not track at all", () => {
    // Defensive: `createGame` gives every scenario region a state, so a map
    // region with no `RegionState` is a state/scenario mismatch. It must cost
    // nothing rather than crash or bill a phantom loss.
    const gap = stateWith((draft) => {
      delete draft.regions[BLUE_HABITAT];
    });

    expect(political(politicalUpkeep(SCENARIO, gap).state).BLUE).toBe(19);
    expect(political(politicalUpkeep(SCENARIO, gap).state).RED).toBe(20);
  });

  it("never mutates the state it is given", () => {
    const frozen = deepFreeze(stateWith());

    expect(political(politicalUpkeep(SCENARIO, frozen).state)).toEqual({ BLUE: 19, RED: 19 });
    expect(political(frozen)).toEqual({ BLUE: 20, RED: 20 });
  });
});

describe("politicalUpkeep constraint penalty (RD-8)", () => {
  /** A board where BLUE held `regionId` at the previous turn end and no longer does. */
  function habitatLost(regionIds: readonly string[]): GameState {
    return stateWith((draft) => {
      for (const regionId of regionIds) {
        const habitat = regionOf(draft, regionId);
        habitat.lastController = "BLUE";
        habitat.control = "RED";
      }
    });
  }

  it("charges the declared amount when a side loses a HABITAT it held", () => {
    const { state, drains } = politicalUpkeep(SCENARIO, habitatLost([BLUE_HABITAT]));

    // 2 for holding neither habitat, then the scenario's 5.
    expect(political(state).BLUE).toBe(13);
    expect(drains.filter((drain) => drain.side === "BLUE")).toEqual([
      { side: "BLUE", from: 20, to: 18, cause: "habitatNotControlled" },
      { side: "BLUE", from: 18, to: 13, cause: "habitatLossPenalty" },
    ]);
  });

  it("charges nothing when the scenario declares no constraint (review M3)", () => {
    const board = habitatLost([BLUE_HABITAT]);

    const withRule = politicalUpkeep(SCENARIO, board);
    const without = politicalUpkeep(NO_CONSTRAINTS, board);

    expect(political(withRule.state).BLUE).toBe(13);
    expect(political(without.state).BLUE).toBe(18);
    expect(without.drains.map((drain) => drain.cause)).not.toContain("habitatLossPenalty");
  });

  it("charges once per HABITAT lost, not once per turn", () => {
    // Both habitats held at the previous turn end, both gone at this one.
    const both = stateWith((draft) => {
      for (const regionId of [BLUE_HABITAT, RED_HABITAT]) {
        const habitat = regionOf(draft, regionId);
        habitat.lastController = "BLUE";
        habitat.control = "RED";
      }
    });

    expect(political(politicalUpkeep(SCENARIO, both).state).BLUE).toBe(20 - 2 - 5 - 5);
  });

  it("ignores a HABITAT the side did not hold at the previous turn end", () => {
    const neverHeld = stateWith((draft) => {
      const habitat = regionOf(draft, BLUE_HABITAT);
      habitat.lastController = "CONTESTED";
      habitat.control = "RED";
    });

    expect(political(politicalUpkeep(SCENARIO, neverHeld).state).BLUE).toBe(18);
  });

  it("charges the side that lost the habitat, never the side that took it", () => {
    const { drains } = politicalUpkeep(SCENARIO, habitatLost([BLUE_HABITAT]));

    expect(drains.filter((drain) => drain.cause === "habitatLossPenalty")).toEqual([
      { side: "BLUE", from: 18, to: 13, cause: "habitatLossPenalty" },
    ]);
  });
});

describe("politicalUpkeep posture bands (RD-4)", () => {
  it("reports a band change only when the drain crosses a threshold", () => {
    const crossing = stateWith((draft) => {
      withPolitical(draft, "BLUE", 13);
      withPolitical(draft, "RED", 20);
    });

    const { postures } = politicalUpkeep(SCENARIO, crossing);

    expect(postures).toEqual([{ side: "BLUE", band: "STRAINED" }]);
  });

  it("reports the CRITICAL crossing at the 6/5 boundary", () => {
    const crossing = stateWith((draft) => {
      withPolitical(draft, "BLUE", 6);
    });

    expect(politicalUpkeep(SCENARIO, crossing).postures).toEqual([
      { side: "BLUE", band: "CRITICAL" },
    ]);
  });

  it("stays silent while a drain leaves the band unchanged", () => {
    const inside = stateWith((draft) => {
      withPolitical(draft, "BLUE", 12);
      withPolitical(draft, "RED", 12);
    });

    expect(politicalUpkeep(SCENARIO, inside).postures).toEqual([]);
  });

  it("reports both sides when both cross in the same upkeep", () => {
    const both = stateWith((draft) => {
      withPolitical(draft, "BLUE", 13);
      withPolitical(draft, "RED", 6);
    });

    expect(politicalUpkeep(SCENARIO, both).postures).toEqual([
      { side: "BLUE", band: "STRAINED" },
      { side: "RED", band: "CRITICAL" },
    ]);
  });
});

describe("politicalUpkeep collapse reachability (RD-4, review N6)", () => {
  /** Runs `turns` upkeeps against a fixed board, returning each turn's values. */
  function run(scenario: Scenario, start: GameState, turns: number): Record<Side, number>[] {
    const history: Record<Side, number>[] = [];
    let current = start;
    for (let turn = 1; turn <= turns; turn += 1) {
      current = politicalUpkeep(scenario, current).state;
      history.push(political(current));
    }
    return history;
  }

  it("holds the floor under symmetric no-op play: nobody collapses in 16 turns", () => {
    // Each side holds one habitat and neither goes restive, so the drain is
    // 1/turn against a start of 20 — RD-4's stated reason the floor holds.
    const history = run(SCENARIO, BASE, SCENARIO.turnLimit);

    expect(history[7]).toEqual({ BLUE: 12, RED: 12 });
    expect(history.every((turn) => turn.BLUE > 0 && turn.RED > 0)).toBe(true);
  });

  it("collapses a side that loses its HABITAT mid-game, inside the turn limit", () => {
    // Turns 1-5 at the opening 1/turn, then BLUE loses R-03 on turn 6: the
    // 5-point constraint penalty plus a drain that doubles to 2/turn.
    const opening = run(SCENARIO, BASE, 5);
    const lost = stateWith((draft) => {
      withPolitical(draft, "BLUE", opening[4]?.BLUE ?? 0);
      withPolitical(draft, "RED", opening[4]?.RED ?? 0);
      const habitat = regionOf(draft, BLUE_HABITAT);
      habitat.lastController = "BLUE";
      habitat.control = "RED";
    });

    // The penalty is a one-turn event; afterwards `lastController` has caught
    // up and only the doubled drain continues.
    const shock = politicalUpkeep(SCENARIO, lost).state;
    const after = run(SCENARIO, writeLastController(shock), SCENARIO.turnLimit - 6);
    const collapseTurn = 6 + after.findIndex((turn) => turn.BLUE <= 0) + 1;

    expect(political(shock).BLUE).toBe(8);
    expect(collapseTurn).toBeGreaterThan(8);
    expect(collapseTurn).toBeLessThanOrEqual(SCENARIO.turnLimit);
    // Pinned: 15 entering turn 6, minus 7 that turn, then 2/turn reaches 0 on
    // turn 10. RD-4's "around turn 12" is a tunable estimate, not a constant.
    expect(collapseTurn).toBe(10);
    // RED, still holding its habitat, is nowhere near collapse.
    expect(after.at(-1)?.RED).toBeGreaterThan(0);
  });

  it("leaves both sides at or below zero in one upkeep as a detectable DRAW", () => {
    // Slice C's endings ladder reads `<= 0` per side; this module's only job
    // is to make a simultaneous collapse visible in one state.
    const brink = stateWith((draft) => {
      withPolitical(draft, "BLUE", 1);
      withPolitical(draft, "RED", 1);
    });

    const { state } = politicalUpkeep(SCENARIO, brink);

    expect(political(state)).toEqual({ BLUE: 0, RED: 0 });
    expect(state.sides.BLUE.political <= 0 && state.sides.RED.political <= 0).toBe(true);
  });
});

describe("writeLastController (RD-8, review N7)", () => {
  it("snapshots every region's control, not only the ones that changed", () => {
    const board = stateWith((draft) => {
      const habitat = regionOf(draft, BLUE_HABITAT);
      habitat.control = "CONTESTED";
      habitat.lastController = "BLUE";
    });

    const next = writeLastController(board);

    for (const [regionId, region] of Object.entries(next.regions)) {
      expect(region.lastController).toBe(regionOf(board, regionId).control);
    }
    expect(regionOf(next, BLUE_HABITAT).lastController).toBe("CONTESTED");
  });

  it("returns the same state when every region already agrees", () => {
    expect(writeLastController(BASE)).toBe(BASE);
  });

  it("never mutates the state it is given", () => {
    const frozen = deepFreeze(
      stateWith((draft) => {
        regionOf(draft, BLUE_HABITAT).control = "CONTESTED";
      }),
    );

    expect(regionOf(writeLastController(frozen), BLUE_HABITAT).lastController).toBe("CONTESTED");
    expect(regionOf(frozen, BLUE_HABITAT).lastController).toBe("BLUE");
  });
});

describe("HABITAT_DRAIN (RD-4)", () => {
  it("is the pinned per-habitat rate both clauses charge", () => {
    expect(HABITAT_DRAIN).toBe(1);
    expect(UNREST_DRAIN_LEVEL).toBe(2);
  });
});
