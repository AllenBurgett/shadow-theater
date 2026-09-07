import { describe, expect, it } from "vitest";
import { deepFreeze } from "./freeze.ts";

describe("deepFreeze", () => {
  it("freezes everything reachable and returns the same reference", () => {
    const value = { list: [{ deep: true }], nested: { inner: { leaf: 1 } } };

    expect(deepFreeze(value)).toBe(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.list)).toBe(true);
    expect(Object.isFrozen(value.list[0])).toBe(true);
    expect(Object.isFrozen(value.nested.inner)).toBe(true);
  });

  it("descends into an already-frozen container whose children are mutable", () => {
    const inner = { a: 1 };
    const outer = Object.freeze({ inner });
    expect(Object.isFrozen(inner)).toBe(false);

    deepFreeze(outer);

    expect(Object.isFrozen(inner)).toBe(true);
    expect(() => {
      inner.a = 2;
    }).toThrow(TypeError);
  });

  it("terminates on a cycle and walks a shared subgraph once", () => {
    const shared: Record<string, unknown> = { value: 1 };
    const node: Record<string, unknown> = { shared, branch: { shared } };
    node.self = node;

    expect(() => deepFreeze(node)).not.toThrow();
    expect(Object.isFrozen(node)).toBe(true);
    expect(Object.isFrozen(shared)).toBe(true);
  });

  it("passes primitives and null through untouched", () => {
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(7)).toBe(7);
    expect(deepFreeze("vespera-01")).toBe("vespera-01");
  });
});
