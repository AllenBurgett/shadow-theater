/**
 * Vendored, dependency-free hashing helpers.
 *
 * The engine may not import `node:` builtins (no `node:crypto`), so both the
 * RNG's seed derivation and `loadScenario`'s content hash use this 32-bit
 * FNV-1a. It is a *content* hash for change detection and stream derivation,
 * never a security primitive.
 */

const FNV_OFFSET_BASIS = 0x81_1c_9d_c5;
const FNV_PRIME = 0x01_00_01_93;

/**
 * FNV-1a, 32-bit, over the UTF-16 code units of `input`.
 *
 * Code units (not code points) are hashed deliberately: it keeps the function
 * a two-line loop and the inputs we hash (seeds, canonical scenario JSON) are
 * stable strings. The result is an unsigned 32-bit integer.
 */
export function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** `fnv1a32` rendered as a zero-padded 8-character lowercase hex string. */
export function fnv1a32Hex(input: string): string {
  return fnv1a32(input).toString(16).padStart(8, "0");
}

/**
 * `JSON.stringify` with every object's keys sorted recursively, so two
 * semantically identical documents that differ only in key order serialise
 * identically. Arrays keep their order (it is meaningful). `undefined` values
 * are dropped exactly as `JSON.stringify` drops them.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalise);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    if (entry !== undefined) {
      sorted[key] = canonicalise(entry);
    }
  }
  return sorted;
}
