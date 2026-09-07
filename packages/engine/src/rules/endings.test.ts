import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { GameOverRecord, GameState, Scenario, Side } from "../contract/index.ts";
import { deepFreeze } from "../freeze.ts";
import { loadScenario } from "../scenario.ts";
import { evaluateEnding, totalPresence } from "./endings.ts";
import { createGame } from "./state.ts";

const RAW = readFileSync(new URL("../scenarios/vespera-01.json", import.meta.url), "utf8");
const SCENARIO: Scenario = loadScenario(JSON.parse(RAW) as unknown);
const BASE = createGame(SCENARIO, "vespera-01");

/** BLUE's two 6-point public objectives — 12 together, exactly `winPoints`. */
const BLUE_SIX = ["blue-control-south-relay", "blue-hold-port"] as const;
/** RED's two 6-point public objectives. */
const RED_SIX = ["red-suppress-kestrel-port", "red-contest-habitat"] as const;

interface Board {
  turn?: number;
  wipe?: Side[];
  political?: Partial<Record<Side, number>>;
  scored?: Partial<Record<Side, readonly string[]>>;
}

/** Builds a turn-end board, leaving everything the case does not name at BASE. */
function board({ turn = 2, wipe = [], political = {}, scored = {} }: Board): GameState {
  const draft = structuredClone(BASE);
  draft.turn = turn;
  for (const region of Object.values(draft.regions)) {
    for (const side of wipe) {
      region.presence[side] = 0;
    }
  }
  for (const side of ["BLUE", "RED"] as const) {
    const value = political[side];
    if (value !== undefined) {
      draft.sides[side].political = value;
    }
    for (const objectiveId of scored[side] ?? []) {
      draft.objectiveHistory.push({ objectiveId, side, turn: 1 });
    }
  }
  return draft;
}

describe("totalPresence (RD-11)", () => {
  it("sums a side's presence across every region", () => {
    expect(totalPresence(BASE, "BLUE")).toBe(100);
    expect(totalPresence(BASE, "RED")).toBe(140);
    expect(totalPresence(board({ wipe: ["RED"] }), "RED")).toBe(0);
  });
});

describe("evaluateEnding (RD-11, FR-012)", () => {
  it("returns null while the match is still live", () => {
    expect(evaluateEnding(SCENARIO, board({ turn: 2 }))).toBeNull();
  });

  it("ends on WIPEOUT when a side has no presence anywhere", () => {
    expect(evaluateEnding(SCENARIO, board({ turn: 4, wipe: ["RED"] }))).toEqual<GameOverRecord>({
      reason: "WIPEOUT",
      winner: "BLUE",
      endedOnTurn: 4,
      points: { BLUE: 0, RED: 0 },
    });
  });

  it("calls a double wipeout a DRAW", () => {
    expect(evaluateEnding(SCENARIO, board({ wipe: ["BLUE", "RED"] }))).toMatchObject({
      reason: "WIPEOUT",
      winner: "DRAW",
    });
  });

  it("ends on COLLAPSE when a side's political capital reaches zero", () => {
    expect(evaluateEnding(SCENARIO, board({ turn: 9, political: { BLUE: 0 } }))).toMatchObject({
      reason: "COLLAPSE",
      winner: "RED",
      endedOnTurn: 9,
    });
  });

  it("reads collapse past zero, which slice B deliberately does not clamp", () => {
    expect(evaluateEnding(SCENARIO, board({ political: { RED: -4 } }))).toMatchObject({
      reason: "COLLAPSE",
      winner: "BLUE",
    });
  });

  it("calls a simultaneous collapse a DRAW", () => {
    expect(evaluateEnding(SCENARIO, board({ political: { BLUE: 0, RED: -2 } }))).toMatchObject({
      reason: "COLLAPSE",
      winner: "DRAW",
    });
  });

  it("ends on POINTS when a side reaches winPoints", () => {
    expect(
      evaluateEnding(SCENARIO, board({ turn: 5, scored: { BLUE: BLUE_SIX } })),
    ).toEqual<GameOverRecord>({
      reason: "POINTS",
      winner: "BLUE",
      endedOnTurn: 5,
      points: { BLUE: 12, RED: 0 },
    });
  });

  it("gives a simultaneous points win to the higher total", () => {
    expect(
      evaluateEnding(
        SCENARIO,
        board({
          scored: { BLUE: BLUE_SIX, RED: [...RED_SIX, "red-sustain-jam"] },
        }),
      ),
    ).toMatchObject({ reason: "POINTS", winner: "RED", points: { BLUE: 12, RED: 16 } });
  });

  it("calls an equal points finish a DRAW", () => {
    expect(
      evaluateEnding(SCENARIO, board({ scored: { BLUE: BLUE_SIX, RED: RED_SIX } })),
    ).toMatchObject({ reason: "POINTS", winner: "DRAW", points: { BLUE: 12, RED: 12 } });
  });

  it("ends ON the turn limit, not one turn past it", () => {
    expect(evaluateEnding(SCENARIO, board({ turn: SCENARIO.turnLimit - 1 }))).toBeNull();
    expect(evaluateEnding(SCENARIO, board({ turn: SCENARIO.turnLimit }))).toMatchObject({
      reason: "TURN_LIMIT",
      endedOnTurn: SCENARIO.turnLimit,
    });
  });

  it("gives the turn limit to the higher score and a tie to DRAW", () => {
    expect(
      evaluateEnding(
        SCENARIO,
        board({ turn: SCENARIO.turnLimit, scored: { RED: ["red-sustain-jam"] } }),
      ),
    ).toMatchObject({ reason: "TURN_LIMIT", winner: "RED", points: { BLUE: 0, RED: 4 } });
    expect(evaluateEnding(SCENARIO, board({ turn: SCENARIO.turnLimit }))).toMatchObject({
      winner: "DRAW",
    });
  });
});

describe("evaluateEnding ladder order (RD-11)", () => {
  it("puts wipeout above collapse", () => {
    const both = board({ wipe: ["RED"], political: { RED: -1 } });

    expect(evaluateEnding(SCENARIO, both)).toMatchObject({ reason: "WIPEOUT", winner: "BLUE" });
  });

  it("puts collapse above points", () => {
    const both = board({ political: { RED: 0 }, scored: { RED: [...RED_SIX] } });

    // RED is at winPoints and collapsed in the same evaluation; collapse wins,
    // so the side that ran out of capital loses despite leading on points.
    expect(evaluateEnding(SCENARIO, both)).toMatchObject({ reason: "COLLAPSE", winner: "BLUE" });
  });

  it("puts collapse above the turn limit, which is the no-op game's ending", () => {
    // The 16-turn symmetric no-op game reaches mutual collapse on the turn
    // limit itself (slice B's RD-12 attrition finding), so the ladder's order
    // is what decides between COLLAPSE/DRAW and TURN_LIMIT on the very first
    // end-to-end run.
    const both = board({
      turn: SCENARIO.turnLimit,
      political: { BLUE: -2, RED: -2 },
      scored: { BLUE: ["blue-hold-port"] },
    });

    expect(evaluateEnding(SCENARIO, both)).toMatchObject({
      reason: "COLLAPSE",
      winner: "DRAW",
      endedOnTurn: SCENARIO.turnLimit,
      points: { BLUE: 6, RED: 0 },
    });
  });

  it("puts points above the turn limit", () => {
    const both = board({ turn: SCENARIO.turnLimit, scored: { BLUE: BLUE_SIX } });

    expect(evaluateEnding(SCENARIO, both)).toMatchObject({ reason: "POINTS", winner: "BLUE" });
  });
});

describe("evaluateEnding purity (FR-012)", () => {
  it("records the points standing at the ending, whatever the reason", () => {
    const record = evaluateEnding(
      SCENARIO,
      board({ turn: 6, wipe: ["BLUE"], scored: { RED: ["red-sustain-jam"] } }),
    );

    expect(record?.points).toEqual({ BLUE: 0, RED: 4 });
  });

  it("is a pure read: the same state answers identically and is never touched", () => {
    const frozen = deepFreeze(board({ turn: 9, political: { BLUE: 0 } }));

    expect(evaluateEnding(SCENARIO, frozen)).toEqual(evaluateEnding(SCENARIO, frozen));
    expect(frozen.gameOver).toBeNull();
  });
});
