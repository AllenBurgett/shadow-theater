/**
 * `@shadow/engine` — the pure, deterministic rules core.
 *
 * No I/O, no ambient randomness, no wall-clock, no module-level scenario
 * state: the scenario is an explicit parameter to every function that needs
 * rules data (engine-api, review B1). Zod lives only behind `./contract`.
 *
 * This entry point currently exposes the foundation landed by issue #13
 * (contract schemas, RNG, scenario loading, event emission). `createGame`,
 * `legalTargets`, `validateOrders`, `resolveTurn`, `project`, `renderAar`,
 * `staffPlan`, and `replay` land in issue #14.
 */

export * from "./contract/index.ts";
export { canonicalJson, fnv1a32, fnv1a32Hex } from "./hash.ts";
export type { Rng } from "./rng.ts";
export { createRng } from "./rng.ts";
export type {
  EventLog,
  EventLogOptions,
  EventPayload,
  VisibilityPredicate,
} from "./rules/events.ts";
export {
  createEventLog,
  isHidden,
  stampVisibility,
  visibility,
  visibleToAll,
  visibleToNone,
  visibleToOnly,
} from "./rules/events.ts";
export { loadScenario, ScenarioLoadError } from "./scenario.ts";

/**
 * Workspace link-proof retained ONLY for the `@shadow/server` scaffold
 * (`packages/server/src/main.ts` / `main.test.ts`, issue #18), which imports
 * it to prove the workspace edge resolves. Nothing in the engine uses it.
 *
 * @deprecated Delete alongside `describeScaffold` when the server slice lands.
 */
export const ENGINE_SCAFFOLD = true as const;
