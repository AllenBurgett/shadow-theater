/**
 * `@shadow/engine` — the pure, deterministic rules core.
 *
 * No I/O, no ambient randomness, no wall-clock, no module-level scenario
 * state: the scenario is an explicit parameter to every function that needs
 * rules data (engine-api, review B1). Zod lives only behind `./contract`.
 *
 * This entry point exposes the foundation landed by issue #13 (contract
 * schemas, RNG, scenario loading, event emission), issue #14's first rules
 * slices (`createGame`, control resolution, hand drawing, `legalTargets`,
 * `validateOrders`, the operation effects, and `resolveTurn`), and issue #15's
 * consequence phases (supply and attrition, timers/decay, the whole-board
 * control recompute, unrest, political upkeep, objectives, and the endings
 * ladder). `project`, `renderAar`, `staffPlan`, and `replay` follow in issues
 * #16–#17.
 */

export * from "./contract/index.ts";
export { canonicalJson, fnv1a32, fnv1a32Hex } from "./hash.ts";
export type { Rng } from "./rng.ts";
export { createRng } from "./rng.ts";
export { CONTROL_MARGIN, resolveControl } from "./rules/control.ts";
export { evaluateEnding, totalPresence } from "./rules/endings.ts";
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
export type { ObjectiveResult } from "./rules/objectives.ts";
export { evaluateObjectives, pointsFor } from "./rules/objectives.ts";
export type { PoliticalCause, PoliticalDrain, PostureChange } from "./rules/political.ts";
export {
  HABITAT_DRAIN,
  politicalUpkeep,
  postureBand,
  UNREST_DRAIN_LEVEL,
  writeLastController,
} from "./rules/political.ts";
/**
 * `resolveTurn` runs RD-1's **complete** phase list as of issue #15:
 * validation, info ops, surface ops, supply, timers/decay, the whole-board
 * control recompute, unrest, political upkeep with the RD-8 constraint,
 * objectives, the endings ladder, the `lastController` snapshot, and the turn
 * increment (skipped once the game has ended). The ending is stored in
 * `GameState.gameOver` and must never be recomputed by a caller (FR-012).
 */
export type { TurnOrders, TurnResult } from "./rules/resolve.ts";
export {
  initiativeFor,
  OrderSideMismatchError,
  OrderValidationError,
  resolveTurn,
} from "./rules/resolve.ts";
export { createGame, OBSERVED_INTEL_AGE, UNOBSERVED_INTEL_AGE } from "./rules/state.ts";
export type { AttritionLoss, SupplyChange } from "./rules/supply.ts";
export { ATTRITION_PER_TURN, applyAttrition, recomputeSupply } from "./rules/supply.ts";
export type { UnrestChange } from "./rules/timers.ts";
export {
  ageIntel,
  evaluateUnrest,
  expireContacts,
  expireLinkEffects,
  recomputeAllControl,
} from "./rules/timers.ts";
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
