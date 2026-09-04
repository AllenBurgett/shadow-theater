import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CardDomain, RegionType, Side, TargetKind } from "./contract/index.ts";
import { loadScenario, ScenarioLoadError } from "./scenario.ts";

/**
 * The scenario is read as text and parsed here rather than imported as a JSON
 * module: `loadScenario` takes `unknown` by contract, and this keeps the
 * typecheck gate free of JSON-module resolution settings.
 */
const RAW = readFileSync(new URL("./scenarios/vespera-01.json", import.meta.url), "utf8");

function freshJson(): Record<string, unknown> {
  return JSON.parse(RAW) as Record<string, unknown>;
}

function issuePaths(error: unknown): string[] {
  expect(error).toBeInstanceOf(ScenarioLoadError);
  return (error as ScenarioLoadError).issues.map((issue) => issue.path);
}

function loadFailure(mutate: (json: Record<string, unknown>) => void): unknown {
  const json = freshJson();
  mutate(json);
  try {
    loadScenario(json);
  } catch (error) {
    return error;
  }
  throw new Error("expected loadScenario to reject");
}

// biome-ignore lint/suspicious/noExplicitAny: test helpers walk untyped JSON.
type Json = any;

describe("loadScenario field-level errors", () => {
  it("rejects an unknown constraint type at the constraint's own path", () => {
    const error = loadFailure((json) => {
      (json as Json).constraints = [{ type: "orbitalCommNoise", amount: 5 }];
    });
    expect(issuePaths(error)).toContain("constraints.0.type");
  });

  it("rejects an unknown objective condition type under objectives", () => {
    const error = loadFailure((json) => {
      (json as Json).objectives.BLUE[0].condition = { type: "captureEverything", regionId: "R-10" };
    });
    expect(issuePaths(error).some((path) => path.startsWith("objectives.BLUE.0.condition"))).toBe(
      true,
    );
  });

  it("rejects a dangling link endpoint under map.links", () => {
    const error = loadFailure((json) => {
      (json as Json).map.links[3].b = "R-99";
    });
    expect(issuePaths(error)).toContain("map.links.3.b");
  });

  it("rejects an objective condition naming an unknown region", () => {
    const error = loadFailure((json) => {
      (json as Json).objectives.BLUE[0].condition.regionId = "R-42";
    });
    expect(issuePaths(error)).toContain("objectives.BLUE.0.condition.regionId");
  });

  it("rejects handSize larger than the card catalogue", () => {
    const error = loadFailure((json) => {
      (json as Json).handSize = 12;
    });
    expect(issuePaths(error)).toContain("handSize");
  });

  it("rejects a duplicate region id", () => {
    const error = loadFailure((json) => {
      (json as Json).map.regions[5].id = "R-01";
    });
    expect(issuePaths(error)).toContain("map.regions.5.id");
  });

  it("rejects setup control of an unknown region", () => {
    const error = loadFailure((json) => {
      (json as Json).setup.sides.RED.control[0] = "R-77";
    });
    expect(issuePaths(error)).toContain("setup.sides.RED.control.0");
  });

  it("rejects an unsupported schemaVersion", () => {
    const error = loadFailure((json) => {
      (json as Json).schemaVersion = 2;
    });
    expect(issuePaths(error)).toContain("schemaVersion");
  });

  it("carries a prettified message naming the failing paths", () => {
    const error = loadFailure((json) => {
      (json as Json).handSize = 12;
    }) as ScenarioLoadError;
    expect(error.message).toContain("handSize");
    expect(error.name).toBe("ScenarioLoadError");
  });

  it("rejects a non-object input", () => {
    expect(() => loadScenario(null)).toThrow(ScenarioLoadError);
    expect(() => loadScenario("vespera")).toThrow(ScenarioLoadError);
  });
});

describe("loadScenario hashing", () => {
  it("is stable across repeated loads of the same document", () => {
    expect(loadScenario(freshJson()).hash).toBe(loadScenario(freshJson()).hash);
  });

  it("is an 8-character lowercase hex digest", () => {
    expect(loadScenario(freshJson()).hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("changes when any authored value changes", () => {
    const baseline = loadScenario(freshJson()).hash;
    const edited = freshJson();
    (edited as Json).setup.sides.BLUE.presence["R-03"] = 41;
    expect(loadScenario(edited).hash).not.toBe(baseline);
  });

  it("ignores JSON key order", () => {
    const baseline = loadScenario(freshJson()).hash;
    const reordered = JSON.parse(RAW) as Json;
    const shuffled: Record<string, unknown> = {};
    for (const key of Object.keys(reordered).reverse()) {
      shuffled[key] = reordered[key];
    }
    shuffled.setup = {
      sides: {
        RED: (reordered as Json).setup.sides.RED,
        BLUE: (reordered as Json).setup.sides.BLUE,
      },
    };
    expect(loadScenario(shuffled).hash).toBe(baseline);
  });

  it("returns a frozen scenario", () => {
    const scenario = loadScenario(freshJson());
    expect(Object.isFrozen(scenario)).toBe(true);
  });
});

describe("vespera-01 scenario invariants", () => {
  const scenario = loadScenario(freshJson());

  it("loads with the authored headline numbers", () => {
    expect(scenario.schemaVersion).toBe(1);
    expect(scenario.id).toBe("vespera-01");
    expect(scenario.name).toBe("Vespera");
    expect(scenario.turnLimit).toBe(16);
    expect(scenario.winPoints).toBe(12);
    expect(scenario.handSize).toBe(6);
    expect(scenario.resources).toEqual({ cpPerTurn: 10, isrPerTurn: 6, politicalStart: 20 });
    expect(scenario.constraints).toEqual([{ type: "habitatLossPoliticalPenalty", amount: 5 }]);
  });

  it("carries the 12-region, 13-link map", () => {
    expect(scenario.map.regions).toHaveLength(12);
    expect(scenario.map.links).toHaveLength(13);
    for (const link of scenario.map.links) {
      expect(link.capacity).toBeGreaterThanOrEqual(1);
      expect(link.capacity).toBeLessThanOrEqual(3);
    }
  });

  it("has exactly two HABITAT regions", () => {
    const habitats = scenario.map.regions.filter((region) => region.type === "HABITAT");
    expect(habitats.map((region) => region.id)).toEqual(["R-03", "R-09"]);
  });

  it("gives each side at least one starting PORT and one starting HABITAT", () => {
    const typeOf = new Map<string, RegionType>(
      scenario.map.regions.map((region) => [region.id, region.type]),
    );
    for (const side of ["BLUE", "RED"] as const) {
      const controlled = scenario.setup.sides[side].control.map((id) => typeOf.get(id));
      expect(controlled).toContain("PORT");
      expect(controlled).toContain("HABITAT");
    }
  });

  it("arms BLUE's reduceEnemyPresence objective from the start position", () => {
    const objective = scenario.objectives.BLUE.find(
      (candidate) => candidate.condition.type === "reduceEnemyPresence",
    );
    expect(objective).toBeDefined();
    const condition = objective?.condition;
    if (condition?.type !== "reduceEnemyPresence") {
      throw new Error("expected a reduceEnemyPresence condition");
    }

    const industry = new Set(
      scenario.map.regions
        .filter((region) => region.type === condition.regionType)
        .map((region) => region.id),
    );
    const armable = Object.entries(scenario.setup.sides.RED.presence).filter(
      ([regionId, presence]) => industry.has(regionId) && presence >= condition.armAt,
    );
    expect(armable).toEqual([["R-11", 40]]);
  });

  it("keeps handSize within the card catalogue", () => {
    expect(scenario.handSize).toBeLessThanOrEqual(scenario.cards.length);
  });

  it("resolves every setup and objective region reference", () => {
    const regionIds = new Set(scenario.map.regions.map((region) => region.id));
    for (const side of ["BLUE", "RED"] as const) {
      for (const regionId of scenario.setup.sides[side].control) {
        expect(regionIds.has(regionId)).toBe(true);
      }
      for (const regionId of Object.keys(scenario.setup.sides[side].presence)) {
        expect(regionIds.has(regionId)).toBe(true);
      }
      for (const objective of scenario.objectives[side]) {
        if ("regionId" in objective.condition) {
          expect(regionIds.has(objective.condition.regionId)).toBe(true);
        }
      }
    }
    for (const link of scenario.map.links) {
      expect(regionIds.has(link.a)).toBe(true);
      expect(regionIds.has(link.b)).toBe(true);
    }
  });

  it("weights objectives 6 public / 4 secret with 20 points a side", () => {
    for (const side of ["BLUE", "RED"] as const) {
      const objectives = scenario.objectives[side];
      const publics = objectives.filter((objective) => objective.visibility === "public");
      const secrets = objectives.filter((objective) => objective.visibility === "secret");
      expect(publics).toHaveLength(2);
      expect(secrets).toHaveLength(2);
      for (const objective of publics) {
        expect(objective.points).toBe(6);
      }
      for (const objective of secrets) {
        expect(objective.points).toBe(4);
      }
      expect(objectives.reduce((total, objective) => total + objective.points, 0)).toBe(20);
    }
    const allIds = (["BLUE", "RED"] as Side[]).flatMap((side) =>
      scenario.objectives[side].map((objective) => objective.id),
    );
    expect(new Set(allIds).size).toBe(8);
  });

  it("encodes the RD-11 objective picks", () => {
    const byId = new Map(
      (["BLUE", "RED"] as Side[]).flatMap((side) =>
        scenario.objectives[side].map((objective) => [objective.id, objective.condition] as const),
      ),
    );
    expect(byId.get("blue-control-south-relay")).toEqual({
      type: "controlRegion",
      regionId: "R-10",
      byTurn: 6,
    });
    expect(byId.get("blue-hold-port")).toEqual({
      type: "holdRegionType",
      regionType: "PORT",
      count: 1,
      throughTurn: 8,
    });
    expect(byId.get("red-suppress-kestrel-port")).toEqual({
      type: "suppressLinkAdjacent",
      regionId: "R-01",
      byTurn: 6,
      consecutiveTurns: 2,
    });
    expect(byId.get("red-contest-habitat")).toEqual({
      type: "contestRegionType",
      regionType: "HABITAT",
      consecutiveTurns: 3,
      byTurn: 8,
    });
    expect(byId.get("blue-fortify-habitat")).toEqual({
      type: "fortifyRegionType",
      regionType: "HABITAT",
      level: 3,
    });
    expect(byId.get("blue-reduce-industry-presence")).toEqual({
      type: "reduceEnemyPresence",
      regionType: "INDUSTRY",
      below: 30,
      armAt: 30,
    });
    expect(byId.get("red-sustain-jam")).toEqual({ type: "sustainOwnJam", turns: 3 });
    expect(byId.get("red-rumors-in-blue-regions")).toEqual({
      type: "activeRumorsInEnemyControlled",
      count: 2,
      consecutiveTurns: 3,
    });
  });

  it("carries the RD-2a card catalogue verbatim", () => {
    const expected: ReadonlyArray<readonly [string, number, number, TargetKind, CardDomain]> = [
      ["DELIBERATE_ADVANCE", 3, 0, "REGION", "SURFACE"],
      ["RAPID_REDEPLOY", 3, 0, "LINK", "SURFACE"],
      ["FORTIFY_REGION", 2, 0, "REGION", "SURFACE"],
      ["INTERDICT_LINK", 3, 0, "LINK", "SURFACE"],
      ["SECURE_CORRIDOR", 3, 0, "LINK", "SURFACE"],
      ["FOCUSED_ISR_SWEEP", 2, 4, "REGION", "INFO"],
      ["JAMMING_CORRIDOR", 3, 2, "LINK", "INFO"],
      ["SPOOF_CONTACTS", 3, 2, "REGION", "INFO"],
      ["COUNTERINTEL_SWEEP", 2, 2, "REGION", "INFO"],
    ];

    expect(scenario.cards).toHaveLength(expected.length);
    for (const [id, cp, isr, target, domain] of expected) {
      const card = scenario.cards.find((candidate) => candidate.id === id);
      expect(card, `missing card ${id}`).toBeDefined();
      expect([card?.cp, card?.isr, card?.target, card?.domain]).toEqual([cp, isr, target, domain]);
      expect(card?.text.length).toBeGreaterThan(0);
    }
  });

  it("makes the ISR pool binding independently of CP (RD-6)", () => {
    const isrOnly = ["FOCUSED_ISR_SWEEP", "SPOOF_CONTACTS", "COUNTERINTEL_SWEEP"];
    const chosen = scenario.cards.filter((card) => isrOnly.includes(card.id));
    const cp = chosen.reduce((total, card) => total + card.cp, 0);
    const isr = chosen.reduce((total, card) => total + card.isr, 0);
    expect(cp).toBeLessThanOrEqual(scenario.resources.cpPerTurn);
    expect(isr).toBeGreaterThan(scenario.resources.isrPerTurn);
  });
});
