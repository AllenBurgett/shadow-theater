/**
 * `@shadow/engine` — the pure, deterministic rules core.
 *
 * No I/O, no ambient randomness, no wall-clock, no module-level scenario
 * state: the scenario is an explicit parameter to every function that needs
 * rules data (engine-api, review B1). Zod lives only behind `./contract`.
 *
 * This entry point exposes the foundation landed by issue #13 (contract
 * schemas, RNG, scenario loading, event emission) plus issue #14's first
 * rules slices (`createGame`, control resolution, hand drawing,
 * `legalTargets`, `validateOrders`, the operation effects, and `resolveTurn`).
 * `project`, `renderAar`, `staffPlan`, and `replay` follow in issues #16–#17.
 */

export * from "./contract/index.ts";
export { canonicalJson, fnv1a32, fnv1a32Hex } from "./hash.ts";
export type { Rng } from "./rng.ts";
export { createRng } from "./rng.ts";
export { CONTROL_MARGIN, resolveControl } from "./rules/control.ts";
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
export { drawHand, drawHands } from "./rules/hands.ts";
export { effectiveCapacity, legalTargets } from "./rules/legality.ts";
/**
 * `resolveTurn` is **incomplete until issue #15**. It runs RD-1's validation,
 * info-ops, surface-ops and turn-increment phases; supply recompute (T019),
 * timers/decay (T020), the whole-board control recompute and unrest (T021),
 * political upkeep (T022), and objective plus game-over evaluation (T023) are
 * not implemented, so a resolved turn moves presence, forts, link effects and
 * contacts and nothing else. Exported now because the engine's own tests need
 * it; the server (#18) must not ship against it until #15 lands.
 */
export type { TurnOrders, TurnResult } from "./rules/resolve.ts";
export {
  initiativeFor,
  OrderSideMismatchError,
  OrderValidationError,
  resolveTurn,
} from "./rules/resolve.ts";
export { createGame, UNOBSERVED_INTEL_AGE } from "./rules/state.ts";
export type { OrderValidation } from "./rules/validate.ts";
export { validateOrders } from "./rules/validate.ts";
export { loadScenario, ScenarioLoadError } from "./scenario.ts";

/**
 * Workspace link-proof retained ONLY for the `@shadow/server` scaffold
 * (`packages/server/src/main.ts` / `main.test.ts`, issue #18), which imports
 * it to prove the workspace edge resolves. Nothing in the engine uses it.
 *
 * @deprecated Delete alongside `describeScaffold` when the server slice lands.
 */
export const ENGINE_SCAFFOLD = true as const;
