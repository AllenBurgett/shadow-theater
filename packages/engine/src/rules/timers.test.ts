import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Contact, Control, GameState, Scenario, Side } from "../contract/index.ts";
import { deepFreeze } from "../freeze.ts";
import { loadScenario } from "../scenario.ts";
import { effectiveCapacity } from "./legality.ts";
import { createGame, UNOBSERVED_INTEL_AGE } from "./state.ts";
import {
  ageIntel,
  evaluateUnrest,
  expireContacts,
  expireLinkEffects,
  recomputeAllControl,
} from "./timers.ts";

const RAW = readFileSync(new URL("../scenarios/vespera-01.json", import.meta.url), "utf8");
const SCENARIO: Scenario = loadScenario(JSON.parse(RAW) as unknown);
const BASE = createGame(SCENARIO, "vespera-01");

/** Nothing was advanced into and nothing was swept. */
const OBSERVED_NONE: Record<Side, ReadonlySet<string>> = {
  BLUE: new Set<string>(),
  RED: new Set<string>(),
};

function stateWith(turn: number, mutate?: (draft: GameState) => void): GameState {
  const draft = structuredClone(BASE);
  draft.turn = turn;
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

function linkOf(state: GameState, linkId: string) {
  const link = state.links[linkId];
  if (!link) {
    throw new Error(`test fixture is missing link ${linkId}`);
  }
  return link;
}

function ageOf(state: GameState, side: Side, regionId: string): number {
  const age = state.sides[side].intelAge[regionId];
  if (age === undefined) {
    throw new Error(`test fixture is missing intel age for ${side}/${regionId}`);
  }
  return age;
}

function contact(id: string, expiresTurn: number, side: Side = "BLUE"): Contact {
  return { id, side, regionId: "R-05", kind: "recon-activity", expiresTurn };
}

describe("expireLinkEffects (RD-7)", () => {
  it("keeps an effect while turn < expiresTurn and drops it on the expiry turn", () => {
    const board = (turn: number) =>
      stateWith(turn, (draft) => {
        linkOf(draft, "L-11-12").effects = [{ kind: "INTERDICT", side: "BLUE", expiresTurn: 3 }];
      });

    expect(expireLinkEffects(board(2)).expired).toEqual([]);
    expect(expireLinkEffects(board(3)).expired).toEqual([
      { linkId: "L-11-12", effect: { kind: "INTERDICT", side: "BLUE", expiresTurn: 3 } },
    ]);
  });

  it("restores effective capacity by removing the effect, not by editing a base", () => {
    const stacked = (turn: number) =>
      stateWith(turn, (draft) => {
        linkOf(draft, "L-11-12").effects = [
          { kind: "INTERDICT", side: "BLUE", expiresTurn: 4 },
          { kind: "INTERDICT", side: "BLUE", expiresTurn: 9 },
        ];
      });

    const { state } = expireLinkEffects(stacked(4));

    expect(linkOf(state, "L-11-12").effects).toEqual([
      { kind: "INTERDICT", side: "BLUE", expiresTurn: 9 },
    ]);
    // Base 2, two stacked interdictions on turn 3: nothing crosses. On turn 4
    // one has expired and the corridor is open again at 1. The base capacity
    // is never touched, unlike the prototype's permanent `capacity -= 1`.
    expect(effectiveCapacity(SCENARIO, stacked(3), "L-11-12")).toBe(0);
    expect(effectiveCapacity(SCENARIO, state, "L-11-12")).toBe(1);
  });

  it("sweeps every link in one pass and leaves untouched links identical", () => {
    const board = stateWith(4, (draft) => {
      linkOf(draft, "L-01-02").effects = [{ kind: "JAM", side: "RED", expiresTurn: 4 }];
      linkOf(draft, "L-11-12").effects = [{ kind: "INTERDICT", side: "BLUE", expiresTurn: 4 }];
    });

    const { state, expired } = expireLinkEffects(board);

    expect(expired.map((entry) => entry.linkId)).toEqual(["L-01-02", "L-11-12"]);
    expect(state.links["L-05-11"]).toBe(board.links["L-05-11"]);
  });

  it("returns the same state when nothing expired", () => {
    const board = stateWith(2);

    expect(expireLinkEffects(board).state).toBe(board);
  });
});

describe("expireContacts (RD-7, RD-9)", () => {
  it("uses the link-effect predicate, not the prototype's looser expiresTurn >= turn", () => {
    // mechanics-inventory §9: the prototype kept a contact through its own
    // expiry turn (`expiresTurn >= turn`) and purged it a turn late. RD-2a
    // states one timing rule for link and contact effects alike, so a contact
    // created on turn t (expiresTurn t+2) is active at t and t+1 and gone in
    // the timers phase of t+2.
    const board = (turn: number) =>
      stateWith(turn, (draft) => {
        draft.contacts = [contact("c", 3)];
      });

    expect(expireContacts(board(2)).expired).toEqual([]);
    expect(expireContacts(board(3)).expired).toEqual([contact("c", 3)]);
  });

  it("keeps the survivors in order and returns the same state when none expired", () => {
    const mixed = stateWith(3, (draft) => {
      draft.contacts = [contact("gone", 3), contact("stays", 5, "RED"), contact("also-gone", 2)];
    });

    const { state, expired } = expireContacts(mixed);

    expect(expired.map((entry) => entry.id)).toEqual(["gone", "also-gone"]);
    expect(state.contacts).toEqual([contact("stays", 5, "RED")]);
    expect(expireContacts(state).state).toBe(state);
  });
});

describe("ageIntel (RD-9)", () => {
  it("increments an unobserved region and zeroes an observed one in one atomic step", () => {
    // R-05 is empty for BLUE at creation, so it starts at UNOBSERVED_INTEL_AGE.
    const aged = ageIntel(stateWith(2), OBSERVED_NONE);

    expect(ageOf(aged, "BLUE", "R-05")).toBe(UNOBSERVED_INTEL_AGE + 1);
    // R-01 carries BLUE presence 60, which is observation in its own right.
    expect(ageOf(aged, "BLUE", "R-01")).toBe(0);
  });

  it("reads a turn-N sweep as age 0, not 1 — the increment never outruns it", () => {
    // Review M8/N3: the sweep sets the age to 0 during the ops phase, and a
    // naive "increment everything, then zero what was observed" implemented as
    // two passes over live state would leave a swept region at 1 and render
    // LIKELY where the card promises CONFIRMED.
    const swept = stateWith(2, (draft) => {
      draft.sides.BLUE.intelAge["R-05"] = 0;
    });

    const aged = ageIntel(swept, { BLUE: new Set(["R-05"]), RED: new Set<string>() });

    expect(ageOf(aged, "BLUE", "R-05")).toBe(0);
  });

  it("counts a region advanced into this turn as observed", () => {
    const aged = ageIntel(stateWith(2), { BLUE: new Set(["R-02"]), RED: new Set<string>() });

    expect(ageOf(aged, "BLUE", "R-02")).toBe(0);
    expect(ageOf(aged, "RED", "R-02")).toBe(UNOBSERVED_INTEL_AGE + 1);
  });

  it("reads presence as it stands when aging runs, not as the turn began", () => {
    const withdrawn = stateWith(2, (draft) => {
      regionOf(draft, "R-01").presence = { BLUE: 0, RED: 0 };
      draft.sides.BLUE.intelAge["R-01"] = 0;
    });

    expect(ageOf(ageIntel(withdrawn, OBSERVED_NONE), "BLUE", "R-01")).toBe(1);
  });

  it("ages each side independently", () => {
    const aged = ageIntel(stateWith(2), OBSERVED_NONE);

    expect(ageOf(aged, "RED", "R-12")).toBe(0);
    expect(ageOf(aged, "BLUE", "R-12")).toBe(UNOBSERVED_INTEL_AGE + 1);
  });

  it("treats a region the record has never heard of as unobserved", () => {
    // Defensive: `createGame` fills every region, so this is a state/scenario
    // mismatch rather than a reachable game position — it must read UNKNOWN
    // rather than crash or silently report CONFIRMED.
    const gap = stateWith(2, (draft) => {
      delete draft.sides.BLUE.intelAge["R-05"];
    });

    expect(ageOf(ageIntel(gap, OBSERVED_NONE), "BLUE", "R-05")).toBe(UNOBSERVED_INTEL_AGE + 1);
  });

  it("never mutates the state it is given", () => {
    const frozen = deepFreeze(stateWith(2));

    expect(() => ageIntel(frozen, OBSERVED_NONE)).not.toThrow();
    expect(ageOf(frozen, "BLUE", "R-05")).toBe(UNOBSERVED_INTEL_AGE);
  });
});

describe("recomputeAllControl (RD-13)", () => {
  it("re-resolves every region and reports only the flips", () => {
    const drained = stateWith(2, (draft) => {
      // A 40/34 RED lead is CONTESTED; attrition taking RED to 44 vs 34 is not.
      const region = regionOf(draft, "R-09");
      region.control = "CONTESTED";
      region.presence = { BLUE: 34, RED: 44 };
    });

    const { state, changes } = recomputeAllControl(drained);

    expect(changes).toEqual([{ regionId: "R-09", from: "CONTESTED", to: "RED" }]);
    expect(regionOf(state, "R-09").control).toBe("RED");
  });

  it("returns the same state when the board already agrees with the margins", () => {
    const board = stateWith(2);

    expect(recomputeAllControl(board).state).toBe(board);
    expect(recomputeAllControl(board).changes).toEqual([]);
  });

  it("never mutates the state it is given", () => {
    const frozen = deepFreeze(
      stateWith(2, (draft) => {
        regionOf(draft, "R-09").presence = { BLUE: 0, RED: 0 };
      }),
    );

    expect(recomputeAllControl(frozen).changes).toEqual([
      { regionId: "R-09", from: "RED", to: "NEUTRAL" },
    ]);
    expect(regionOf(frozen, "R-09").control).toBe("RED");
  });
});

describe("evaluateUnrest (RD-5)", () => {
  /** Sets one region's turn-end control against its previous turn end. */
  function transition(control: Control, last: Control) {
    return stateWith(2, (draft) => {
      const region = regionOf(draft, "R-05");
      region.control = control;
      region.lastController = last;
      region.unrest = 1;
    });
  }

  it("adds 1 when the controller changed at turn end", () => {
    expect(evaluateUnrest(transition("RED", "BLUE")).changes).toEqual([
      { regionId: "R-05", from: 1, to: 2 },
    ]);
  });

  it("adds 1 for each turn the region ends CONTESTED", () => {
    expect(evaluateUnrest(transition("CONTESTED", "CONTESTED")).changes).toEqual([
      { regionId: "R-05", from: 1, to: 2 },
    ]);
  });

  it("adds 2 when a controller change and a contested result coincide", () => {
    // RD-5's clauses are independent per-turn terms, not a first-match ladder:
    // a held region falling into contest is both events at once, so the sum
    // is +2 and the result cannot depend on the order they are evaluated in.
    expect(evaluateUnrest(transition("CONTESTED", "BLUE")).changes).toEqual([
      { regionId: "R-05", from: 1, to: 3 },
    ]);
  });

  it("subtracts 1 while a side holds the region at both turn ends", () => {
    expect(evaluateUnrest(transition("BLUE", "BLUE")).changes).toEqual([
      { regionId: "R-05", from: 1, to: 0 },
    ]);
  });

  it("decays a NEUTRAL region even though no side is stably holding it", () => {
    expect(evaluateUnrest(transition("NEUTRAL", "NEUTRAL")).changes).toEqual([
      { regionId: "R-05", from: 1, to: 0 },
    ]);
  });

  it("nets to nothing when a region is abandoned to NEUTRAL", () => {
    // The change term and the NEUTRAL decay cancel: losing the last of a
    // garrison agitates as much as nobody holding the ground calms.
    expect(evaluateUnrest(transition("NEUTRAL", "BLUE")).changes).toEqual([]);
  });

  it("clamps to 0..3 and reports no change at the rails", () => {
    const floor = stateWith(2, (draft) => {
      const region = regionOf(draft, "R-05");
      region.control = "NEUTRAL";
      region.lastController = "NEUTRAL";
      region.unrest = 0;
    });
    const ceiling = stateWith(2, (draft) => {
      const region = regionOf(draft, "R-05");
      region.control = "CONTESTED";
      region.lastController = "BLUE";
      region.unrest = 3;
    });

    expect(evaluateUnrest(floor).changes).toEqual([]);
    expect(evaluateUnrest(floor).state).toBe(floor);
    expect(evaluateUnrest(ceiling).changes).toEqual([]);
  });

  it("clamps a +2 that would overshoot the ceiling", () => {
    const nearly = stateWith(2, (draft) => {
      const region = regionOf(draft, "R-05");
      region.control = "CONTESTED";
      region.lastController = "BLUE";
      region.unrest = 2;
    });

    expect(evaluateUnrest(nearly).changes).toEqual([{ regionId: "R-05", from: 2, to: 3 }]);
  });

  it("never writes lastController — RD-8 owns that write at the end of evaluation", () => {
    const flipped = transition("RED", "BLUE");

    expect(regionOf(evaluateUnrest(flipped).state, "R-05").lastController).toBe("BLUE");
  });

  it("never mutates the state it is given", () => {
    const frozen = deepFreeze(transition("RED", "BLUE"));

    expect(evaluateUnrest(frozen).changes).toHaveLength(1);
    expect(regionOf(frozen, "R-05").unrest).toBe(1);
  });
});
