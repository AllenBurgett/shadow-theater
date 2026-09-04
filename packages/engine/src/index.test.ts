import { describe, expect, it } from "vitest";
import { ScenarioIdSchema } from "./contract/index.ts";
import { ENGINE_SCAFFOLD } from "./index.ts";

describe("engine scaffold", () => {
  it("exposes the package entry point", () => {
    expect(ENGINE_SCAFFOLD).toBe(true);
  });

  it("owns the Zod contract boundary", () => {
    expect(ScenarioIdSchema.safeParse("vespera-01").success).toBe(true);
    expect(ScenarioIdSchema.safeParse("").success).toBe(false);
  });
});
