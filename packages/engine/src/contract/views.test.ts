import { describe, expect, it } from "vitest";
import type { IntelConfidence } from "./enums.ts";
import { RegionViewSchema } from "./views.ts";

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
