import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRng, type Rng } from "./rng.ts";

/**
 * Golden vectors for the vendored RNG (research R8). These hex digests are
 * FROZEN: the algorithm, the seeding path, and the per-helper call counts are
 * part of the replay format, so a change here is a breaking change to every
 * stored replay and must be a deliberate, versioned decision.
 */
const GOLDEN_VECTORS = {
  "vespera-golden-1": "13080bca643adde765623fef8fe5256b56b9b56562f0008b2248483d6f435b98",
  "vespera-golden-2": "4b9729747ea6b2c00f37ccf7718ebca5e202b68f1f69ac66d7ca79f5138b7ae3",
  "vespera-golden-1/hand:BLUE:1":
    "a6f4fc7b7805c0e225dc55eafb5c764a21cca84aacd1788fe42be667c40a8430",
} as const;

function drawU32(rng: Rng, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(rng.nextU32());
  }
  return out;
}

function digestOf(values: readonly number[]): string {
  return createHash("sha256").update(values.join("\n")).digest("hex");
}

describe("createRng golden vectors", () => {
  it("matches the frozen digest for seed vespera-golden-1", () => {
    expect(digestOf(drawU32(createRng("vespera-golden-1"), 1000))).toBe(
      GOLDEN_VECTORS["vespera-golden-1"],
    );
  });

  it("matches the frozen digest for seed vespera-golden-2", () => {
    expect(digestOf(drawU32(createRng("vespera-golden-2"), 1000))).toBe(
      GOLDEN_VECTORS["vespera-golden-2"],
    );
  });

  it("matches the frozen digest for the hand:BLUE:1 fork of vespera-golden-1", () => {
    const fork = createRng("vespera-golden-1").fork("hand:BLUE:1");
    expect(digestOf(drawU32(fork, 1000))).toBe(GOLDEN_VECTORS["vespera-golden-1/hand:BLUE:1"]);
  });

  it("produces uint32 values in range", () => {
    const rng = createRng("vespera-golden-1");
    for (let i = 0; i < 500; i += 1) {
      const value = rng.nextU32();
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xff_ff_ff_ff);
    }
  });

  it("produces floats in [0, 1)", () => {
    const rng = createRng("vespera-golden-2");
    for (let i = 0; i < 500; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("createRng determinism", () => {
  it("gives identical sequences for the same seed", () => {
    const a = drawU32(createRng("vespera-01"), 100);
    const b = drawU32(createRng("vespera-01"), 100);
    expect(a).toEqual(b);
  });

  it("gives different sequences for different seeds", () => {
    const a = drawU32(createRng("vespera-01"), 100);
    const b = drawU32(createRng("vespera-02"), 100);
    expect(a).not.toEqual(b);
  });

  it("exposes the seed it was created with", () => {
    expect(createRng("vespera-01").seed).toBe("vespera-01");
    expect(createRng("vespera-01").fork("hand:RED:2").seed).toBe("vespera-01/hand:RED:2");
  });
});

describe("Rng.fork substream independence", () => {
  it("is unaffected by draws on a sibling substream", () => {
    const control = drawU32(createRng("vespera-01").fork("rumor:RED:1"), 1000);

    const parent = createRng("vespera-01");
    const sibling = parent.fork("hand:BLUE:1");
    drawU32(sibling, 1000);
    const after = drawU32(parent.fork("rumor:RED:1"), 1000);

    expect(after).toEqual(control);
  });

  it("is unaffected by draws on the parent stream", () => {
    const control = drawU32(createRng("vespera-01").fork("hand:BLUE:1"), 500);

    const parent = createRng("vespera-01");
    drawU32(parent, 137);
    const after = drawU32(parent.fork("hand:BLUE:1"), 500);

    expect(after).toEqual(control);
  });

  it("derives distinct streams for distinct labels", () => {
    const root = createRng("vespera-01");
    const hand = drawU32(root.fork("hand:BLUE:1"), 100);
    const rumor = drawU32(root.fork("rumor:BLUE:1"), 100);
    const laterTurn = drawU32(root.fork("hand:BLUE:2"), 100);
    expect(hand).not.toEqual(rumor);
    expect(hand).not.toEqual(laterTurn);
  });

  it("composes nested forks by path", () => {
    const nested = createRng("vespera-01").fork("hand:BLUE:1").fork("rumor:RED:3");
    const direct = createRng("vespera-01/hand:BLUE:1").fork("rumor:RED:3");
    expect(nested.seed).toBe("vespera-01/hand:BLUE:1/rumor:RED:3");
    expect(drawU32(nested, 100)).toEqual(drawU32(direct, 100));
  });
});

describe("Rng.fork label grammar", () => {
  it("accepts the frozen label shapes", () => {
    const rng = createRng("vespera-01");
    expect(() => rng.fork("hand:BLUE:3")).not.toThrow();
    expect(() => rng.fork("rumor:RED:5")).not.toThrow();
    expect(() => rng.fork("hand:BLUE:16")).not.toThrow();
  });

  it.each([
    "hand:blue:1",
    "hand:BLUE:0",
    "hand",
    "Hand:BLUE:1",
    "hand:GREEN:1",
    "hand:BLUE:01",
    "",
  ])("rejects the malformed label %j", (label) => {
    const rng = createRng("vespera-01");
    expect(() => rng.fork(label)).toThrow(/label/i);
  });
});

describe("Rng.int", () => {
  it("stays within [0, maxExclusive)", () => {
    const rng = createRng("vespera-01");
    for (let i = 0; i < 500; i += 1) {
      const value = rng.int(7);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
    }
  });

  it("rejects a non-positive bound", () => {
    const rng = createRng("vespera-01");
    expect(() => rng.int(0)).toThrow(/maxExclusive/);
    expect(() => rng.int(-1)).toThrow(/maxExclusive/);
  });

  it("consumes exactly one draw per call", () => {
    const a = createRng("vespera-01");
    const b = createRng("vespera-01");
    a.int(5);
    b.nextU32();
    expect(drawU32(a, 10)).toEqual(drawU32(b, 10));
  });
});

describe("Rng.sample", () => {
  const cards = Object.freeze([
    "DELIBERATE_ADVANCE",
    "RAPID_REDEPLOY",
    "FORTIFY_REGION",
    "INTERDICT_LINK",
    "SECURE_CORRIDOR",
    "FOCUSED_ISR_SWEEP",
    "JAMMING_CORRIDOR",
    "SPOOF_CONTACTS",
    "COUNTERINTEL_SWEEP",
  ]);

  it("returns exactly count distinct items from the pool", () => {
    const hand = createRng("vespera-01").fork("hand:BLUE:1").sample(cards, 6);
    expect(hand).toHaveLength(6);
    expect(new Set(hand).size).toBe(6);
    for (const card of hand) {
      expect(cards).toContain(card);
    }
  });

  it("is deterministic per seed and label, and order-bearing", () => {
    const a = createRng("vespera-01").fork("hand:BLUE:1").sample(cards, 6);
    const b = createRng("vespera-01").fork("hand:BLUE:1").sample(cards, 6);
    const other = createRng("vespera-01").fork("hand:RED:1").sample(cards, 6);
    expect(a).toEqual(b);
    expect(a).not.toEqual(other);
  });

  it("does not mutate a frozen input", () => {
    const before = [...cards];
    createRng("vespera-01").sample(cards, 6);
    expect([...cards]).toEqual(before);
  });

  it("consumes exactly count int() draws", () => {
    const sampler = createRng("vespera-01");
    const probe = createRng("vespera-01");
    sampler.sample(cards, 6);
    for (let i = 0; i < 6; i += 1) {
      probe.nextU32();
    }
    expect(drawU32(sampler, 10)).toEqual(drawU32(probe, 10));
  });

  it("supports the degenerate counts", () => {
    expect(createRng("vespera-01").sample(cards, 0)).toEqual([]);
    expect(createRng("vespera-01").sample(cards, cards.length)).toHaveLength(cards.length);
  });

  it("rejects a count larger than the pool", () => {
    expect(() => createRng("vespera-01").sample(cards, cards.length + 1)).toThrow(/count/);
  });
});
