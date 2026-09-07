import type { Control, RegionState } from "../contract/index.ts";

/**
 * Control resolution (RD-13, analysis A01).
 *
 * Retained unchanged from the prototype's `resolveControl`
 * (mechanics-inventory §6): control is a pure function of the two presence
 * values alone — fort, unrest, supply, region type, and history play no part.
 * The turn phase calls it for every region once per turn after attrition, and
 * a handful of operations re-resolve it inline (RD-1/RD-2a); its result is the
 * "turn-end control" that RD-5 (unrest), RD-8 (lastController), and RD-11
 * (objective conditions) read.
 */

/** ⚙ Inclusive presence margin that converts a lead into control (RD-13). */
export const CONTROL_MARGIN = 10;

/**
 * NEUTRAL is reachable again from BLUE/RED only when both presences fall away,
 * which is why the first predicate is `<= 0` and not `=== 0`: the wire schema
 * clamps presence to 0..100, but resolution subtracts before it clamps, so an
 * intermediate value can be negative.
 */
export function resolveControl(presence: RegionState["presence"]): Control {
  const { BLUE, RED } = presence;
  if (BLUE <= 0 && RED <= 0) {
    return "NEUTRAL";
  }
  if (BLUE >= RED + CONTROL_MARGIN) {
    return "BLUE";
  }
  if (RED >= BLUE + CONTROL_MARGIN) {
    return "RED";
  }
  return "CONTESTED";
}
