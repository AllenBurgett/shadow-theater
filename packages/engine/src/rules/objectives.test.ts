import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { GameState, ProgressRecord, Scenario, Side } from "../contract/index.ts";
import { deepFreeze } from "../freeze.ts";
import { loadScenario } from "../scenario.ts";
import { evaluateObjectives, pointsFor } from "./objectives.ts";
import { createGame } from "./state.ts";

const RAW = readFileSync(new URL("../scenarios/vespera-01.json", import.meta.url), "utf8");
const SCENARIO: Scenario = loadScenario(JSON.parse(RAW) as unknown);
const BASE = createGame(SCENARIO, "vespera-01");

/** Objective ids, so a scenario rename fails loudly instead of silently. */
const CONTROL_RELAY = "blue-control-south-relay";
const HOLD_PORT = "blue-hold-port";
const FORTIFY_HABITAT = "blue-fortify-habitat";
const REDUCE_INDUSTRY = "blue-reduce-industry-presence";
const SUPPRESS_PORT = "red-suppress-kestrel-port";
const CONTEST_HABITAT = "red-contest-habitat";
const SUSTAIN_JAM = "red-sustain-jam";
const RUMORS = "red-rumors-in-blue-regions";

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
 * One turn end: clones `state`, sets the turn, applies the board change, and
 * evaluates. Threading the returned state is what carries counters, arming,
 * and permanent failure from one turn end to the next.
 */
function turnEnd(state: GameState, turn: number, mutate?: (draft: GameState) => void): GameState {
  const draft = structuredClone(state);
  draft.turn = turn;
  mutate?.(draft);
  return evaluateObjectives(SCENARIO, draft).state;
}

function completedTurn(state: GameState, objectiveId: string): number | null {
  return state.objectiveHistory.find((record) => record.objectiveId === objectiveId)?.turn ?? null;
}

function rowsFor(state: GameState, objectiveId: string): ProgressRecord[] {
  return state.objectiveProgress.filter((row) => row.objectiveId === objectiveId);
}

function points(state: GameState): Record<Side, number> {
  return {
    BLUE: pointsFor(SCENARIO, state, "BLUE"),
    RED: pointsFor(SCENARIO, state, "RED"),
  };
}

describe("evaluateObjectives at game start (RD-11, review B4)", () => {
  it("scores nothing on turn 1 from the opening position", () => {
    const { state, completions } = evaluateObjectives(SCENARIO, BASE);

    expect(completions).toEqual([]);
    expect(state.objectiveHistory).toEqual([]);
    expect(points(state)).toEqual({ BLUE: 0, RED: 0 });
  });

  it("arms reduceEnemyPresence without completing it in the same turn end", () => {
    // R-11 is INDUSTRY with RED presence 40, at and above armAt 30 — so it
    // arms on turn 1. R-07 is INDUSTRY and empty: below `below` from the
    // start, and it must not complete on that alone.
    const { state } = evaluateObjectives(SCENARIO, BASE);

    expect(rowsFor(state, REDUCE_INDUSTRY)).toEqual<ProgressRecord[]>([
      { objectiveId: REDUCE_INDUSTRY, key: "R-07", counter: 0, armed: false, failed: false },
      { objectiveId: REDUCE_INDUSTRY, key: "R-11", counter: 0, armed: true, failed: false },
    ]);
    expect(completedTurn(state, REDUCE_INDUSTRY)).toBeNull();
  });
});

describe("controlRegion (RD-11)", () => {
  it("completes at a turn end within byTurn", () => {
    const held = turnEnd(BASE, 3, (draft) => {
      regionOf(draft, "R-10").control = "BLUE";
    });

    expect(completedTurn(held, CONTROL_RELAY)).toBe(3);
    expect(points(held).BLUE).toBe(6);
  });

  it("is dead once byTurn has passed", () => {
    const late = turnEnd(BASE, 7, (draft) => {
      regionOf(draft, "R-10").control = "BLUE";
    });

    expect(completedTurn(late, CONTROL_RELAY)).toBeNull();
  });

  it("ignores a region the side merely contests", () => {
    const contested = turnEnd(BASE, 3, (draft) => {
      regionOf(draft, "R-10").control = "CONTESTED";
    });

    expect(completedTurn(contested, CONTROL_RELAY)).toBeNull();
  });
});

describe("holdRegionType (RD-11)", () => {
  it("completes at throughTurn when the count never lapsed", () => {
    let state = BASE;
    for (let turn = 1; turn <= 8; turn += 1) {
      state = turnEnd(state, turn);
    }

    expect(completedTurn(state, HOLD_PORT)).toBe(8);
  });

  it("fails permanently on one turn end below the count, even after recovery", () => {
    let state = turnEnd(BASE, 1);
    state = turnEnd(state, 2);
    // One turn end with BLUE's only PORT out of its hands.
    state = turnEnd(state, 3, (draft) => {
      regionOf(draft, "R-01").control = "CONTESTED";
    });

    expect(rowsFor(state, HOLD_PORT)).toEqual<ProgressRecord[]>([
      { objectiveId: HOLD_PORT, key: null, counter: 0, armed: false, failed: true },
    ]);

    for (let turn = 4; turn <= 8; turn += 1) {
      state = turnEnd(state, turn);
    }

    expect(completedTurn(state, HOLD_PORT)).toBeNull();
  });

  it("does not complete before throughTurn", () => {
    expect(completedTurn(turnEnd(BASE, 7), HOLD_PORT)).toBeNull();
  });
});

describe("suppressLinkAdjacent (RD-11, review M5)", () => {
  /** Closes L-01-02 (base capacity 2) with `count` RED interdictions. */
  function suppress(draft: GameState, count: number, side: Side = "RED"): void {
    linkOf(draft, "L-01-02").effects = Array.from({ length: count }, () => ({
      kind: "INTERDICT" as const,
      side,
      expiresTurn: 99,
    }));
  }

  it("counts consecutive turn ends and completes at consecutiveTurns", () => {
    let state = turnEnd(BASE, 1, (draft) => suppress(draft, 2));
    expect(completedTurn(state, SUPPRESS_PORT)).toBeNull();

    state = turnEnd(state, 2, (draft) => suppress(draft, 2));
    expect(completedTurn(state, SUPPRESS_PORT)).toBe(2);
  });

  it("requires the side's own INTERDICT, not merely a closed link", () => {
    // BLUE closes its own corridor: capacity is 0 but no RED interdiction is
    // active on it, so RED's objective sees nothing (review M5).
    let state = turnEnd(BASE, 1, (draft) => suppress(draft, 2, "BLUE"));
    state = turnEnd(state, 2, (draft) => suppress(draft, 2, "BLUE"));

    expect(completedTurn(state, SUPPRESS_PORT)).toBeNull();
  });

  it("requires effective capacity 0, not merely an interdiction", () => {
    // One interdiction on a capacity-2 link leaves it passable at 1.
    let state = turnEnd(BASE, 1, (draft) => suppress(draft, 1));
    state = turnEnd(state, 2, (draft) => suppress(draft, 1));

    expect(completedTurn(state, SUPPRESS_PORT)).toBeNull();
  });

  it("resets the link's counter on a break rather than pausing it", () => {
    let state = turnEnd(BASE, 1, (draft) => suppress(draft, 2));
    state = turnEnd(state, 2, (draft) => suppress(draft, 0));
    expect(rowsFor(state, SUPPRESS_PORT).map((row) => row.counter)).toEqual([0, 0]);

    state = turnEnd(state, 3, (draft) => suppress(draft, 2));

    expect(completedTurn(state, SUPPRESS_PORT)).toBeNull();
  });

  it("keeps a counter per adjacent link, not one for the region", () => {
    // R-01 has two links: L-01-02 and L-01-07. Alternating between them must
    // never accumulate into a completion.
    let state = turnEnd(BASE, 1, (draft) => suppress(draft, 2));
    state = turnEnd(state, 2, (draft) => {
      suppress(draft, 0);
      linkOf(draft, "L-01-07").effects = Array.from({ length: 3 }, () => ({
        kind: "INTERDICT" as const,
        side: "RED" as const,
        expiresTurn: 99,
      }));
    });

    expect(completedTurn(state, SUPPRESS_PORT)).toBeNull();
  });

  it("is dead once byTurn has passed", () => {
    let state = turnEnd(BASE, 6, (draft) => suppress(draft, 2));
    state = turnEnd(state, 7, (draft) => suppress(draft, 2));

    expect(completedTurn(state, SUPPRESS_PORT)).toBeNull();
  });
});

describe("contestRegionType (RD-11)", () => {
  function contest(draft: GameState, regionId: string): void {
    regionOf(draft, regionId).control = "CONTESTED";
  }

  /** Hands a habitat back to its opening owner, ending that region's run. */
  function calm(draft: GameState, regionId: string): void {
    regionOf(draft, regionId).control = regionId === "R-03" ? "BLUE" : "RED";
  }

  it("needs the same region CONTESTED at consecutiveTurns turn ends", () => {
    let state = BASE;
    for (let turn = 1; turn <= 3; turn += 1) {
      state = turnEnd(state, turn, (draft) => contest(draft, "R-03"));
    }

    expect(completedTurn(state, CONTEST_HABITAT)).toBe(3);
  });

  it("resets that region's counter on a break rather than pausing it", () => {
    let state = turnEnd(BASE, 1, (draft) => contest(draft, "R-03"));
    state = turnEnd(state, 2, (draft) => contest(draft, "R-03"));
    state = turnEnd(state, 3, (draft) => calm(draft, "R-03"));
    expect(rowsFor(state, CONTEST_HABITAT).map((row) => row.counter)).toEqual([0, 0]);

    state = turnEnd(state, 4, (draft) => contest(draft, "R-03"));
    state = turnEnd(state, 5, (draft) => contest(draft, "R-03"));

    expect(completedTurn(state, CONTEST_HABITAT)).toBeNull();
  });

  it("never sums two different regions into one run", () => {
    let state = turnEnd(BASE, 1, (draft) => contest(draft, "R-03"));
    state = turnEnd(state, 2, (draft) => {
      calm(draft, "R-03");
      contest(draft, "R-09");
    });
    state = turnEnd(state, 3, (draft) => {
      calm(draft, "R-09");
      contest(draft, "R-03");
    });

    expect(completedTurn(state, CONTEST_HABITAT)).toBeNull();
  });
});

describe("fortifyRegionType (RD-11)", () => {
  it("completes on an own-controlled region of the type at the level", () => {
    const fortified = turnEnd(BASE, 3, (draft) => {
      regionOf(draft, "R-03").fort = 3;
    });

    expect(completedTurn(fortified, FORTIFY_HABITAT)).toBe(3);
  });

  it("ignores the level on a region the side does not control", () => {
    const enemyFort = turnEnd(BASE, 3, (draft) => {
      regionOf(draft, "R-09").fort = 3;
    });

    expect(completedTurn(enemyFort, FORTIFY_HABITAT)).toBeNull();
  });

  it("ignores a fort below the level", () => {
    const low = turnEnd(BASE, 3, (draft) => {
      regionOf(draft, "R-03").fort = 2;
    });

    expect(completedTurn(low, FORTIFY_HABITAT)).toBeNull();
  });
});

describe("reduceEnemyPresence (RD-11, review B4)", () => {
  it("completes only at a turn end after the region armed", () => {
    // R-11 armed on turn 1 at RED 40; turn 2 drops it under 30.
    let state = turnEnd(BASE, 1);
    state = turnEnd(state, 2, (draft) => {
      regionOf(draft, "R-11").presence = { BLUE: 0, RED: 29 };
    });

    expect(completedTurn(state, REDUCE_INDUSTRY)).toBe(2);
  });

  it("does not complete on a region that armed in the same turn end", () => {
    // Arming and falling below cannot both be read from one turn end: the
    // arming test runs against the value the row already carried.
    const sameTurn = turnEnd(BASE, 1, (draft) => {
      regionOf(draft, "R-07").presence = { BLUE: 0, RED: 0 };
    });

    expect(completedTurn(sameTurn, REDUCE_INDUSTRY)).toBeNull();
  });

  it("never completes on an unarmed region that was always below", () => {
    // R-07 is INDUSTRY and empty throughout; only R-11 ever arms.
    let state = BASE;
    for (let turn = 1; turn <= 4; turn += 1) {
      state = turnEnd(state, turn);
    }

    expect(completedTurn(state, REDUCE_INDUSTRY)).toBeNull();
    expect(rowsFor(state, REDUCE_INDUSTRY).find((row) => row.key === "R-07")?.armed).toBe(false);
  });

  it("keeps a region armed once it has armed", () => {
    let state = turnEnd(BASE, 1);
    state = turnEnd(state, 2, (draft) => {
      regionOf(draft, "R-11").presence = { BLUE: 0, RED: 40 };
    });

    expect(rowsFor(state, REDUCE_INDUSTRY).find((row) => row.key === "R-11")?.armed).toBe(true);
  });
});

describe("sustainOwnJam (RD-11)", () => {
  function jam(draft: GameState, side: Side): void {
    linkOf(draft, "L-01-02").effects = [{ kind: "JAM", side, expiresTurn: 99 }];
  }

  it("completes after the required consecutive turn ends", () => {
    let state = BASE;
    for (let turn = 1; turn <= 3; turn += 1) {
      state = turnEnd(state, turn, (draft) => jam(draft, "RED"));
    }

    expect(completedTurn(state, SUSTAIN_JAM)).toBe(3);
  });

  it("counts only the side's own jams", () => {
    let state = BASE;
    for (let turn = 1; turn <= 4; turn += 1) {
      state = turnEnd(state, turn, (draft) => jam(draft, "BLUE"));
    }

    expect(completedTurn(state, SUSTAIN_JAM)).toBeNull();
  });

  it("resets on a break, so a single 2-turn card cannot carry it", () => {
    let state = turnEnd(BASE, 1, (draft) => jam(draft, "RED"));
    state = turnEnd(state, 2, (draft) => jam(draft, "RED"));
    state = turnEnd(state, 3, (draft) => {
      linkOf(draft, "L-01-02").effects = [];
    });
    state = turnEnd(state, 4, (draft) => jam(draft, "RED"));

    expect(completedTurn(state, SUSTAIN_JAM)).toBeNull();
  });

  it("ignores a jam whose expiry turn has arrived", () => {
    let state = BASE;
    for (let turn = 1; turn <= 4; turn += 1) {
      state = turnEnd(state, turn, (draft) => {
        linkOf(draft, "L-01-02").effects = [{ kind: "JAM", side: "RED", expiresTurn: turn }];
      });
    }

    expect(completedTurn(state, SUSTAIN_JAM)).toBeNull();
  });
});

describe("activeRumorsInEnemyControlled (RD-11)", () => {
  function rumors(draft: GameState, regionIds: readonly string[]): void {
    draft.contacts = regionIds.map((regionId, index) => ({
      id: `contact-${index}`,
      side: "RED" as const,
      regionId,
      kind: "recon-activity" as const,
      expiresTurn: 99,
    }));
  }

  it("completes after the required consecutive turn ends at or above count", () => {
    let state = BASE;
    for (let turn = 1; turn <= 3; turn += 1) {
      state = turnEnd(state, turn, (draft) => rumors(draft, ["R-01", "R-03"]));
    }

    expect(completedTurn(state, RUMORS)).toBe(3);
  });

  it("counts only contacts sitting in enemy-controlled regions", () => {
    // R-05 is NEUTRAL: not enemy-controlled, so it does not count.
    let state = BASE;
    for (let turn = 1; turn <= 4; turn += 1) {
      state = turnEnd(state, turn, (draft) => rumors(draft, ["R-01", "R-05"]));
    }

    expect(completedTurn(state, RUMORS)).toBeNull();
  });

  it("counts only the side's own contacts", () => {
    let state = BASE;
    for (let turn = 1; turn <= 4; turn += 1) {
      state = turnEnd(state, turn, (draft) => {
        rumors(draft, ["R-01", "R-03"]);
        for (const contact of draft.contacts) {
          contact.side = "BLUE";
        }
      });
    }

    expect(completedTurn(state, RUMORS)).toBeNull();
  });

  it("resets on a break", () => {
    let state = turnEnd(BASE, 1, (draft) => rumors(draft, ["R-01", "R-03"]));
    state = turnEnd(state, 2, (draft) => rumors(draft, ["R-01", "R-03"]));
    state = turnEnd(state, 3, (draft) => rumors(draft, []));
    state = turnEnd(state, 4, (draft) => rumors(draft, ["R-01", "R-03"]));

    expect(completedTurn(state, RUMORS)).toBeNull();
  });
});

describe("evaluateObjectives bookkeeping (RD-11)", () => {
  it("scores an objective once and keeps the completion sticky", () => {
    const first = turnEnd(BASE, 3, (draft) => {
      regionOf(draft, "R-10").control = "BLUE";
    });
    const second = turnEnd(first, 4, (draft) => {
      regionOf(draft, "R-10").control = "BLUE";
    });

    expect(
      second.objectiveHistory.filter((record) => record.objectiveId === CONTROL_RELAY),
    ).toEqual([{ objectiveId: CONTROL_RELAY, side: "BLUE", turn: 3 }]);
    expect(points(second).BLUE).toBe(6);
  });

  it("stops evaluating a completed objective and carries its rows through", () => {
    let state = BASE;
    for (let turn = 1; turn <= 8; turn += 1) {
      state = turnEnd(state, turn);
    }
    // Once complete, a lapse below the count can no longer fail it.
    const after = turnEnd(state, 9, (draft) => {
      regionOf(draft, "R-01").control = "CONTESTED";
    });

    expect(completedTurn(after, HOLD_PORT)).toBe(8);
    expect(rowsFor(after, HOLD_PORT)).toEqual(rowsFor(state, HOLD_PORT));
  });

  it("hands the resolver each completion's score, so nothing looks it back up", () => {
    const state = structuredClone(BASE);
    state.turn = 3;
    regionOf(state, "R-10").control = "BLUE";
    regionOf(state, "R-03").fort = 3;

    const { completions } = evaluateObjectives(SCENARIO, state);

    expect(completions).toEqual([
      { record: { objectiveId: CONTROL_RELAY, side: "BLUE", turn: 3 }, points: 6 },
      { record: { objectiveId: FORTIFY_HABITAT, side: "BLUE", turn: 3 }, points: 4 },
    ]);
    // The score rides alongside the record; `objectiveHistory` keeps the
    // data-model's three fields and gains no `points` of its own.
    expect(evaluateObjectives(SCENARIO, state).state.objectiveHistory).toEqual([
      { objectiveId: CONTROL_RELAY, side: "BLUE", turn: 3 },
      { objectiveId: FORTIFY_HABITAT, side: "BLUE", turn: 3 },
    ]);
  });

  it("attributes each completion to the side whose objective it is", () => {
    const state = turnEnd(BASE, 3, (draft) => {
      regionOf(draft, "R-10").control = "BLUE";
      regionOf(draft, "R-03").fort = 3;
    });

    expect(state.objectiveHistory.map((record) => record.side)).toEqual(["BLUE", "BLUE"]);
    expect(points(state)).toEqual({ BLUE: 10, RED: 0 });
  });

  it("never mutates the state it is given", () => {
    const frozen = deepFreeze(structuredClone(BASE));

    expect(evaluateObjectives(SCENARIO, frozen).state.objectiveProgress.length).toBeGreaterThan(0);
    expect(frozen.objectiveProgress).toEqual([]);
  });

  it("reads a link the state does not track as carrying no effects", () => {
    // Defensive, matching the region case: a scenario link with no `LinkState`
    // must count as neither suppressed nor jammed rather than crash.
    const gap = structuredClone(BASE);
    gap.turn = 1;
    delete gap.links["L-01-02"];

    const { state } = evaluateObjectives(SCENARIO, gap);

    expect(rowsFor(state, SUPPRESS_PORT).map((row) => row.counter)).toEqual([0, 0]);
    expect(rowsFor(state, SUSTAIN_JAM).every((row) => row.counter === 0)).toBe(true);
  });

  it("skips a region of the right type the state does not track", () => {
    // Defensive: a scenario region with no `RegionState` is a state/scenario
    // mismatch, and must not arm, contest, or complete anything.
    const gap = structuredClone(BASE);
    gap.turn = 1;
    delete gap.regions["R-11"];

    const { state } = evaluateObjectives(SCENARIO, gap);

    expect(rowsFor(state, REDUCE_INDUSTRY).map((row) => row.key)).toEqual(["R-07"]);
  });
});

describe("pointsFor (RD-11)", () => {
  it("sums a side's completed objectives and ignores the other side's", () => {
    const state = structuredClone(BASE);
    state.objectiveHistory = [
      { objectiveId: CONTROL_RELAY, side: "BLUE", turn: 3 },
      { objectiveId: SUSTAIN_JAM, side: "RED", turn: 4 },
    ];

    expect(points(state)).toEqual({ BLUE: 6, RED: 4 });
  });

  it("ignores a completion whose objective the scenario no longer declares", () => {
    // A stored game replayed against an edited scenario: the record survives
    // but scores nothing, rather than crashing or inventing a value.
    const state = structuredClone(BASE);
    state.objectiveHistory = [{ objectiveId: "retired-objective", side: "BLUE", turn: 2 }];

    expect(points(state).BLUE).toBe(0);
  });
});
