import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CardId, GameState, LinkEffect, Scenario } from "../contract/index.ts";
import { loadScenario } from "../scenario.ts";
import { effectiveCapacity, findCard, isLegalTarget, legalTargets, linkReach } from "./legality.ts";
import { createGame } from "./state.ts";

const RAW = readFileSync(new URL("../scenarios/vespera-01.json", import.meta.url), "utf8");
const SCENARIO: Scenario = loadScenario(JSON.parse(RAW) as unknown);
const SEED = "vespera-01";
const BASE = createGame(SCENARIO, SEED);

/** A mutable clone of the pristine turn-1 state, for hand-built positions. */
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

function cardOf(cardId: CardId) {
  const card = findCard(SCENARIO, cardId);
  if (!card) {
    throw new Error(`test fixture is missing card ${cardId}`);
  }
  return card;
}

const INTERDICT: LinkEffect = { kind: "INTERDICT", side: "RED", expiresTurn: 3 };
const JAM: LinkEffect = { kind: "JAM", side: "RED", expiresTurn: 3 };

/** BLUE holds R-01 and R-03 at setup, so these five links are within reach. */
const BLUE_REACH = ["L-01-02", "L-02-03", "L-03-04", "L-01-07", "L-03-09"];

describe("effectiveCapacity (RD-7)", () => {
  it("is the base capacity when a link carries no effects", () => {
    expect(effectiveCapacity(SCENARIO, BASE, "L-01-02")).toBe(2);
    expect(effectiveCapacity(SCENARIO, BASE, "L-03-04")).toBe(1);
  });

  it("subtracts each active INTERDICT and floors at 0", () => {
    const one = stateWith((draft) => {
      linkOf(draft, "L-01-02").effects.push(INTERDICT);
    });
    const three = stateWith((draft) => {
      linkOf(draft, "L-01-02").effects.push(INTERDICT, INTERDICT, INTERDICT);
    });

    expect(effectiveCapacity(SCENARIO, one, "L-01-02")).toBe(1);
    expect(effectiveCapacity(SCENARIO, three, "L-01-02")).toBe(0);
  });

  it("ignores JAM, which masks intel rather than capacity", () => {
    const jammed = stateWith((draft) => {
      linkOf(draft, "L-01-02").effects.push(JAM, JAM);
    });

    expect(effectiveCapacity(SCENARIO, jammed, "L-01-02")).toBe(2);
  });

  it("counts an effect as active only while turn < expiresTurn", () => {
    // RD-2a pins the timing: an effect added on turn N with duration 2 has
    // expiresTurn N+2, is active at turn ends N and N+1, and is removed in
    // the timers phase of turn expiresTurn.
    const expiring = stateWith((draft) => {
      linkOf(draft, "L-01-02").effects.push({ ...INTERDICT, expiresTurn: 2 });
      linkOf(draft, "L-02-03").effects.push({ ...INTERDICT, expiresTurn: 1 });
    });

    expect(effectiveCapacity(SCENARIO, expiring, "L-01-02")).toBe(1);
    expect(effectiveCapacity(SCENARIO, expiring, "L-02-03")).toBe(2);
  });

  it("reports 0 for a link the scenario does not define", () => {
    expect(effectiveCapacity(SCENARIO, BASE, "L-99-99")).toBe(0);
  });
});

describe("legality on a state that does not track a scenario element", () => {
  // validateOrders must answer for whatever state and id it is handed — from
  // the wire, from a model, or from a replay of an older scenario revision —
  // so a missing element reads as an empty position rather than throwing.
  it("reads a missing link as capacity 0 and a missing region as empty", () => {
    const { "L-03-04": _link, ...links } = BASE.links;
    const { "R-01": _region, ...regions } = BASE.regions;
    const partial: GameState = { ...BASE, links, regions };

    expect(effectiveCapacity(SCENARIO, partial, "L-03-04")).toBe(1);
    expect(linkReach(SCENARIO, partial, "L-01-07", "BLUE")).toBe(false);
    // R-07's only supporting region was R-01, so it drops out of the advance
    // list rather than crashing the adjacency walk.
    expect(legalTargets(SCENARIO, partial, "BLUE").DELIBERATE_ADVANCE).not.toContain("R-07");
  });
});

describe("linkReach (RD-2a)", () => {
  it("holds when either endpoint is controlled by the side", () => {
    expect(linkReach(SCENARIO, BASE, "L-01-07", "BLUE")).toBe(true);
    expect(linkReach(SCENARIO, BASE, "L-11-12", "RED")).toBe(true);
  });

  it("holds on friendly presence >= 10 at either endpoint without control", () => {
    const projected = stateWith((draft) => {
      regionOf(draft, "R-05").presence.BLUE = 10;
    });

    expect(linkReach(SCENARIO, BASE, "L-05-06", "BLUE")).toBe(false);
    expect(linkReach(SCENARIO, projected, "L-05-06", "BLUE")).toBe(true);
  });

  it("fails below the 10-presence threshold and on an unknown link", () => {
    const thin = stateWith((draft) => {
      regionOf(draft, "R-05").presence.BLUE = 9;
    });

    expect(linkReach(SCENARIO, thin, "L-05-06", "BLUE")).toBe(false);
    expect(linkReach(SCENARIO, BASE, "L-99-99", "BLUE")).toBe(false);
  });
});

describe("legalTargets per card (RD-2a)", () => {
  const targets = legalTargets(SCENARIO, BASE, "BLUE");

  it("returns an entry for every catalogue card, not just the hand", () => {
    expect(Object.keys(targets).sort()).toEqual(SCENARIO.cards.map((card) => card.id).sort());

    const handless = legalTargets(
      SCENARIO,
      stateWith((draft) => {
        draft.sides.BLUE.hand = [];
      }),
      "BLUE",
    );
    expect(Object.keys(handless)).toHaveLength(SCENARIO.cards.length);
  });

  it("offers DELIBERATE_ADVANCE every unheld region joined to a held one", () => {
    expect(targets.DELIBERATE_ADVANCE).toEqual(["R-02", "R-04", "R-07", "R-09"]);
  });

  it("drops an advance target whose only friendly link is interdicted to 0", () => {
    // R-04 hangs off BLUE R-03 by L-03-04 alone, base capacity 1.
    const cut = stateWith((draft) => {
      linkOf(draft, "L-03-04").effects.push(INTERDICT);
    });

    expect(legalTargets(SCENARIO, cut, "BLUE").DELIBERATE_ADVANCE).toEqual([
      "R-02",
      "R-07",
      "R-09",
    ]);
  });

  it("offers RAPID_REDEPLOY only reachable links with a >= 10 stronger endpoint", () => {
    expect(targets.RAPID_REDEPLOY).toEqual(BLUE_REACH);

    const thinned = stateWith((draft) => {
      regionOf(draft, "R-01").presence.BLUE = 5;
      regionOf(draft, "R-03").presence.BLUE = 5;
    });
    expect(legalTargets(SCENARIO, thinned, "BLUE").RAPID_REDEPLOY).toEqual([]);

    const cut = stateWith((draft) => {
      linkOf(draft, "L-03-04").effects.push(INTERDICT);
    });
    expect(legalTargets(SCENARIO, cut, "BLUE").RAPID_REDEPLOY).not.toContain("L-03-04");
  });

  it("offers FORTIFY_REGION held regions below unrest 2 and fort 3", () => {
    expect(targets.FORTIFY_REGION).toEqual(["R-01", "R-03"]);

    const blocked = stateWith((draft) => {
      regionOf(draft, "R-01").unrest = 2;
      regionOf(draft, "R-03").fort = 3;
    });
    expect(legalTargets(SCENARIO, blocked, "BLUE").FORTIFY_REGION).toEqual([]);

    const allowed = stateWith((draft) => {
      regionOf(draft, "R-01").unrest = 1;
      regionOf(draft, "R-03").fort = 2;
    });
    expect(legalTargets(SCENARIO, allowed, "BLUE").FORTIFY_REGION).toEqual(["R-01", "R-03"]);
  });

  it("offers the three link operations exactly the reachable links", () => {
    expect(targets.INTERDICT_LINK).toEqual(BLUE_REACH);
    expect(targets.SECURE_CORRIDOR).toEqual(BLUE_REACH);
    expect(targets.JAMMING_CORRIDOR).toEqual(BLUE_REACH);
  });

  it("offers FOCUSED_ISR_SWEEP and SPOOF_CONTACTS every region", () => {
    const everyRegion = SCENARIO.map.regions.map((region) => region.id);

    expect(targets.FOCUSED_ISR_SWEEP).toEqual(everyRegion);
    expect(targets.SPOOF_CONTACTS).toEqual(everyRegion);
  });

  it("offers COUNTERINTEL_SWEEP only held regions", () => {
    expect(targets.COUNTERINTEL_SWEEP).toEqual(["R-01", "R-03"]);
    expect(legalTargets(SCENARIO, BASE, "RED").COUNTERINTEL_SWEEP).toEqual([
      "R-09",
      "R-11",
      "R-12",
    ]);
  });

  it("returns empty lists rather than dropping keys when nothing is legal", () => {
    const routed = stateWith((draft) => {
      for (const region of Object.values(draft.regions)) {
        region.control = "NEUTRAL";
        region.presence.BLUE = 0;
      }
    });
    const empty = legalTargets(SCENARIO, routed, "BLUE");

    expect(empty.FORTIFY_REGION).toEqual([]);
    expect(empty.COUNTERINTEL_SWEEP).toEqual([]);
    expect(empty.DELIBERATE_ADVANCE).toEqual([]);
    expect(empty.INTERDICT_LINK).toEqual([]);
    expect(empty.RAPID_REDEPLOY).toEqual([]);
    expect(empty.SPOOF_CONTACTS).toHaveLength(SCENARIO.map.regions.length);
  });
});

describe("isLegalTarget", () => {
  it("agrees with legalTargets for every card and candidate target", () => {
    // The single predicate is what resolution re-checks for RD-1 fizzles, so
    // it must not be able to drift from the list planner and views read.
    const targets = legalTargets(SCENARIO, BASE, "BLUE");
    const candidates = [
      ...SCENARIO.map.regions.map((region) => region.id),
      ...SCENARIO.map.links.map((link) => link.id),
    ];

    for (const card of SCENARIO.cards) {
      for (const candidate of candidates) {
        expect(isLegalTarget(SCENARIO, BASE, "BLUE", card, candidate)).toBe(
          (targets[card.id] ?? []).includes(candidate),
        );
      }
    }
  });

  it("rejects a target id that is not on the map at all", () => {
    expect(isLegalTarget(SCENARIO, BASE, "BLUE", cardOf("FOCUSED_ISR_SWEEP"), "R-99")).toBe(false);
    expect(isLegalTarget(SCENARIO, BASE, "BLUE", cardOf("INTERDICT_LINK"), "L-99-99")).toBe(false);
  });
});

describe("findCard", () => {
  it("resolves a catalogue card and reports an absent one", () => {
    expect(findCard(SCENARIO, "SECURE_CORRIDOR")?.cp).toBe(3);

    // The loader now rejects a catalogue that does not cover the enum, so the
    // defensive path is exercised on a hand-built document rather than a
    // loaded one.
    const trimmed: Scenario = {
      ...SCENARIO,
      cards: SCENARIO.cards.filter((card) => card.id !== "SECURE_CORRIDOR"),
    };
    expect(findCard(trimmed, "SECURE_CORRIDOR")).toBeUndefined();
  });
});
