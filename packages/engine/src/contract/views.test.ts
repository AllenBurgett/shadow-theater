import { describe, expect, it } from "vitest";
import { CardIdSchema, type IntelConfidence, type ObjectiveVisibility } from "./enums.ts";
import { RegionViewSchema, SideViewSchema } from "./views.ts";

/**
 * RD-9's enemy-disclosure clauses are contract invariants, not projection
 * formatting: "enemy presence estimates round to nearest 10; UNKNOWN → null
 * estimate". Exact enemy presence is an SC-003 forbidden field, so a schema
 * that accepts an unrounded or UNKNOWN-but-populated estimate would let the
 * leak through the wire edge unchallenged.
 */
function regionView(confidence: IntelConfidence, estimate: number | null): unknown {
  return {
    id: "R-05",
    control: "CONTESTED",
    fort: 1,
    unrest: 0,
    ownPresence: 40,
    enemy: { confidence, estimate },
    ownSupply: "THIN",
    intelAge: 2,
  };
}

function issuePathsOf(confidence: IntelConfidence, estimate: number | null): string[] {
  const result = RegionViewSchema.safeParse(regionView(confidence, estimate));
  expect(result.success).toBe(false);
  return (result.error?.issues ?? []).map((issue) => issue.path.join("."));
}

describe("RegionView enemy estimate (RD-9)", () => {
  it("rejects an UNKNOWN confidence that still carries an estimate", () => {
    expect(issuePathsOf("UNKNOWN", 40)).toContain("enemy.estimate");
  });

  it("accepts UNKNOWN with a null estimate", () => {
    expect(RegionViewSchema.safeParse(regionView("UNKNOWN", null)).success).toBe(true);
  });

  it("accepts CONFIRMED and LIKELY estimates rounded to the nearest 10", () => {
    expect(RegionViewSchema.safeParse(regionView("CONFIRMED", 0)).success).toBe(true);
    expect(RegionViewSchema.safeParse(regionView("CONFIRMED", 100)).success).toBe(true);
    expect(RegionViewSchema.safeParse(regionView("LIKELY", 40)).success).toBe(true);
  });

  it("rejects an unrounded estimate, which would disclose exact presence", () => {
    expect(issuePathsOf("CONFIRMED", 43)).toContain("enemy.estimate");
    expect(issuePathsOf("LIKELY", 35)).toContain("enemy.estimate");
  });

  it("reports both failures field-level at enemy.estimate", () => {
    for (const paths of [issuePathsOf("UNKNOWN", 40), issuePathsOf("CONFIRMED", 43)]) {
      expect(paths).toEqual(["enemy.estimate"]);
    }
  });
});

/**
 * "Enemy secret objectives" is the first entry in the SC-003 forbidden-field
 * list this file's header enumerates, so the enemy-facing slot pins
 * `visibility` to `"public"` — a projection bug can no longer put one on the
 * wire and still validate.
 */
function objectiveView(id: string, visibility: ObjectiveVisibility): unknown {
  return {
    id,
    visibility,
    points: visibility === "public" ? 6 : 4,
    condition: { type: "controlRegion", regionId: "R-10", byTurn: 6 },
    completedTurn: null,
  };
}

function sideView(own: unknown[], enemyPublic: unknown[]): unknown {
  return {
    side: "BLUE",
    turn: 1,
    initiative: "BLUE",
    resources: { cp: 10, isr: 6, political: 20 },
    posture: { own: "STABLE", enemy: "STABLE" },
    hand: ["SPOOF_CONTACTS"],
    // `legalTargets` is exhaustive over the catalogue (engine-api:
    // `Record<CardId, TargetId[]>`), so every card id must be present.
    legalTargets: Object.fromEntries(CardIdSchema.options.map((cardId) => [cardId, []])),
    regions: [],
    links: [],
    contacts: [],
    objectives: { own, enemyPublic },
    completions: { own: [], enemyPublic: [] },
    points: { own: 0, enemyPublic: 0 },
    aar: [],
    gameOver: null,
  };
}

describe("SideView enemy objectives (SC-003)", () => {
  it("rejects a secret objective in the enemy-facing slot", () => {
    const result = SideViewSchema.safeParse(
      sideView([], [objectiveView("red-sustain-jam", "secret")]),
    );
    expect(result.success).toBe(false);
    expect((result.error?.issues ?? []).map((issue) => issue.path.join("."))).toEqual([
      "objectives.enemyPublic.0.visibility",
    ]);
  });

  it("accepts the same secret objective among the viewer's own", () => {
    expect(
      SideViewSchema.safeParse(sideView([objectiveView("blue-fortify-habitat", "secret")], []))
        .success,
    ).toBe(true);
  });

  it("accepts an all-public enemy slot", () => {
    expect(
      SideViewSchema.safeParse(sideView([], [objectiveView("red-contest-habitat", "public")]))
        .success,
    ).toBe(true);
  });
});
