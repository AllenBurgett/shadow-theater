import type { Scenario, ScenarioIssue } from "./contract/index.ts";
import { parseScenario } from "./contract/index.ts";
import { canonicalJson, fnv1a32Hex } from "./hash.ts";

/**
 * Scenario loading (engine-api `loadScenario`).
 *
 * Zod-free by design: validation happens behind `parseScenario` in the
 * contract boundary, so this module — like the rest of the rules layer — has
 * no schema dependency and no `node:` imports.
 */

/**
 * A scenario document that failed validation. `issues` are field-level with
 * dotted paths (`map.links.3.b`); `message` is the prettified report.
 */
export class ScenarioLoadError extends Error {
  readonly issues: readonly ScenarioIssue[];

  constructor(message: string, issues: readonly ScenarioIssue[]) {
    super(message);
    this.name = "ScenarioLoadError";
    this.issues = issues;
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    deepFreeze(entry);
  }
  return Object.freeze(value);
}

/**
 * Validates raw JSON and returns a frozen `Scenario` carrying its content
 * hash.
 *
 * The hash is an 8-hex vendored FNV-1a-32 over a canonical (recursively
 * key-sorted) serialisation of the *validated* document, so it depends on the
 * scenario's content and never on JSON key order or whitespace. It travels in
 * the `gameCreated` header: an edited scenario can no longer silently
 * reinterpret an old replay (review N15, analysis A03).
 */
export function loadScenario(json: unknown): Scenario {
  const result = parseScenario(json);
  if (!result.ok) {
    throw new ScenarioLoadError(result.message, result.issues);
  }
  const hash = fnv1a32Hex(canonicalJson(result.value));
  return deepFreeze({ ...result.value, hash }) as Scenario;
}
