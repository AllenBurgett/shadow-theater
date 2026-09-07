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
  freezeReachable(value, new WeakSet<object>());
  return value;
}

/**
 * `Object.isFrozen` is deliberately NOT used as a short circuit: it reports
 * only that a node's own properties are sealed, so a shallow-frozen container
 * — `Object.freeze([op])` handed to `emit`, say — would hide fully writable
 * children behind it and defeat the "everything reachable" guarantee above.
 * The visited set is what terminates instead, so a cycle is safe and a shared
 * subgraph is walked once.
 */
function freezeReachable(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);
  for (const entry of Object.values(value as Record<string, unknown>)) {
    freezeReachable(entry, seen);
  }
  Object.freeze(value);
}
