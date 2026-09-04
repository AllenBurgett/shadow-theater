import { describe, expect, it } from "vitest";
import { describeScaffold } from "./main.ts";

describe("server scaffold", () => {
  it("resolves the workspace engine import", () => {
    expect(describeScaffold()).toContain("engine linked: true");
  });
});
