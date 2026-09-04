import { describe, expect, it } from "vitest";
import { App } from "./app.tsx";

describe("web scaffold", () => {
  it("has a jsdom environment", () => {
    expect(typeof document).toBe("object");
  });

  it("exports the app shell", () => {
    expect(typeof App).toBe("function");
  });
});
