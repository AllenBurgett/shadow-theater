/**
 * Deep structural freezing, shared by the scenario loader and the event log.
 *
 * Both own an immutability invariant that a shallow `Object.freeze` does not
 * deliver. A loaded `Scenario` is a frozen input to every engine function
 * (engine-api: "inputs are never mutated"), and an emitted `Event` is
 * append-only history whose `visibleTo` is stamped at emission and can never
 * change later (RD-9) — neither holds if the nested objects stay writable.
 */

/** Recursively freezes `value` and everything reachable from it, in place. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    deepFreeze(entry);
  }
  return Object.freeze(value);
}
