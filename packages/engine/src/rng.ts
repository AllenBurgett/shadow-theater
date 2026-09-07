import { fnv1a32 } from "./hash.ts";

/**
 * Vendored deterministic RNG (research R8).
 *
 * sfc32 seeded through splitmix32, behind hash-derived substreams. The
 * algorithm, the seeding path, the label grammar AND the number of draws each
 * helper consumes are all part of the frozen replay format: changing any of
 * them invalidates every stored replay, so changes must be deliberate and
 * versioned. Golden vectors in `rng.test.ts` guard exactly that.
 *
 * No `Math.random`, no `Date.now`, no `node:` builtins.
 */

/** Frozen substream label grammar, e.g. `hand:BLUE:3`, `rumor:RED:5`. */
const LABEL_PATTERN = /^[a-z][a-z0-9]*:(BLUE|RED):[1-9][0-9]*$/;

/** Separator between a parent seed and a fork label; forks compose by path. */
const FORK_SEPARATOR = "/";

const TWO_POW_32 = 4_294_967_296;

export interface Rng {
  /** The full seed path of this stream, e.g. `vespera-01/hand:BLUE:3`. */
  readonly seed: string;
  /** Next raw draw as an unsigned 32-bit integer. */
  nextU32(): number;
  /** Next draw as a float in [0, 1) — exactly one `nextU32` call. */
  next(): number;
  /**
   * Uniform-ish integer in [0, maxExclusive) — exactly one `nextU32` call.
   *
   * Deliberately rejection-free (`Math.floor(next() * maxExclusive)`): the
   * modulo bias is negligible at game scale (bounds below ~100) and a
   * rejection loop would make the draw count input-dependent, which the
   * replay format forbids.
   */
  int(maxExclusive: number): number;
  /**
   * `count` items drawn without replacement, in draw order, via a partial
   * Fisher-Yates shuffle over a copy. Consumes exactly `count` `int()` calls.
   * The input array is never mutated.
   */
  sample<T>(items: readonly T[], count: number): T[];
  /**
   * A child stream derived from `(this.seed, label)` alone — never from this
   * stream's draw count. Extra draws here or on a sibling can therefore never
   * shift the child's sequence (the property that keeps replays stable as
   * rules evolve).
   */
  fork(label: string): Rng;
}

/** splitmix32 — expands one 32-bit seed into the four sfc32 state words. */
function splitmix32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x9e_37_79_b9) | 0;
    let t = state ^ (state >>> 16);
    t = Math.imul(t, 0x21_f0_aa_ad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x73_5a_2d_97);
    t ^= t >>> 15;
    return t >>> 0;
  };
}

/** sfc32 — small, fast, 128-bit-state 32-bit generator. */
function sfc32(seedA: number, seedB: number, seedC: number, seedD: number): () => number {
  let a = seedA | 0;
  let b = seedB | 0;
  let c = seedC | 0;
  let d = seedD | 0;
  return () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
}

/** Creates a deterministic stream rooted at `seed`. */
export function createRng(seed: string): Rng {
  const expand = splitmix32(fnv1a32(seed));
  const nextU32 = sfc32(expand(), expand(), expand(), expand());

  const rng: Rng = {
    seed,
    nextU32,
    next(): number {
      return nextU32() / TWO_POW_32;
    },
    int(maxExclusive: number): number {
      if (!Number.isInteger(maxExclusive) || maxExclusive < 1) {
        throw new Error(
          `Rng.int: maxExclusive must be a positive integer, received ${String(maxExclusive)}`,
        );
      }
      return Math.floor(rng.next() * maxExclusive);
    },
    sample<T>(items: readonly T[], count: number): T[] {
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(`Rng.sample: count must be a non-negative integer, received ${count}`);
      }
      if (count > items.length) {
        throw new Error(`Rng.sample: count ${count} exceeds the pool size ${items.length}`);
      }
      const pool = [...items];
      for (let i = 0; i < count; i += 1) {
        const j = i + rng.int(pool.length - i);
        const held = pool[i] as T;
        pool[i] = pool[j] as T;
        pool[j] = held;
      }
      return pool.slice(0, count);
    },
    fork(label: string): Rng {
      if (!LABEL_PATTERN.test(label)) {
        throw new Error(
          `Rng.fork: invalid substream label ${JSON.stringify(label)}; ` +
            'expected <name>:<BLUE|RED>:<turn>, e.g. "hand:BLUE:3"',
        );
      }
      return createRng(`${seed}${FORK_SEPARATOR}${label}`);
    },
  };

  return rng;
}
