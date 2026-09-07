import { describe, expect, it } from "vitest";
import { CONTROL_MARGIN, resolveControl } from "./control.ts";

/**
 * RD-13 / analysis A01: control resolution is retained unchanged from the
 * prototype (mechanics-inventory §6), so these are the regression tests that
 * pin the retained behavior — the exact ±10 boundaries and NEUTRAL
 * reachability — rather than tests of a new rule.
 */
describe("resolveControl (RD-13)", () => {
  it("keeps the margin at its documented ⚙10", () => {
    expect(CONTROL_MARGIN).toBe(10);
  });

  it("returns NEUTRAL when neither side is present", () => {
    expect(resolveControl({ BLUE: 0, RED: 0 })).toBe("NEUTRAL");
  });

  it("holds the exact ±10 boundary in both directions", () => {
    expect(resolveControl({ BLUE: 9, RED: 0 })).toBe("CONTESTED");
    expect(resolveControl({ BLUE: 10, RED: 0 })).toBe("BLUE");
    expect(resolveControl({ BLUE: 0, RED: 9 })).toBe("CONTESTED");
    expect(resolveControl({ BLUE: 0, RED: 10 })).toBe("RED");
  });

  it("treats the margin as inclusive away from zero", () => {
    expect(resolveControl({ BLUE: 45, RED: 35 })).toBe("BLUE");
    expect(resolveControl({ BLUE: 44, RED: 35 })).toBe("CONTESTED");
    expect(resolveControl({ BLUE: 35, RED: 45 })).toBe("RED");
    expect(resolveControl({ BLUE: 35, RED: 44 })).toBe("CONTESTED");
  });

  it("returns CONTESTED for a tie above zero", () => {
    expect(resolveControl({ BLUE: 40, RED: 40 })).toBe("CONTESTED");
  });

  it("makes NEUTRAL reachable again only once both presences fall away", () => {
    expect(resolveControl({ BLUE: 60, RED: 0 })).toBe("BLUE");
    expect(resolveControl({ BLUE: 5, RED: 0 })).toBe("CONTESTED");
    expect(resolveControl({ BLUE: 0, RED: 0 })).toBe("NEUTRAL");
  });

  it("reads a negative presence as absent, like the prototype's `<= 0`", () => {
    // The wire schema clamps presence to 0..100, but resolution subtracts
    // before it clamps, so the predicate stays `<= 0` rather than `=== 0`.
    expect(resolveControl({ BLUE: -4, RED: -2 })).toBe("NEUTRAL");
  });
});
