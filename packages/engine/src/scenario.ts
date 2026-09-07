import type { Control, Scenario, ScenarioInput, ScenarioIssue, Side } from "./contract/index.ts";
import { parseScenario } from "./contract/index.ts";
import { deepFreeze } from "./freeze.ts";
import { canonicalJson, fnv1a32Hex } from "./hash.ts";
import { resolveControl } from "./rules/control.ts";

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
  const incoherent = controlCoherenceIssues(result.value);
  if (incoherent.length > 0) {
    throw new ScenarioLoadError(
      [
        "Setup control does not agree with setup presence (RD-13):",
        ...incoherent.map((issue) => `  ${issue.path}: ${issue.message}`),
      ].join("\n"),
      incoherent,
    );
  }
  const hash = fnv1a32Hex(canonicalJson(result.value));
  return deepFreeze({ ...result.value, hash }) as Scenario;
}

const SIDES: readonly Side[] = ["BLUE", "RED"];

function setupPresence(scenario: ScenarioInput, side: Side, regionId: string): number {
  return scenario.setup.sides[side].presence[regionId] ?? 0;
}

/**
 * The field to blame for an incoherent region: the control entry that declares
 * it, or — when nothing declares it — the presence that should have been
 * declared. Either way the path names an authored field.
 */
function issuePath(scenario: ScenarioInput, regionId: string): string {
  for (const side of SIDES) {
    const index = scenario.setup.sides[side].control.indexOf(regionId);
    if (index >= 0) {
      return `setup.sides.${side}.control.${index}`;
    }
  }
  const louder =
    setupPresence(scenario, "RED", regionId) > setupPresence(scenario, "BLUE", regionId)
      ? "RED"
      : "BLUE";
  return `setup.sides.${louder}.presence.${regionId}`;
}

/**
 * Every region's declared control must be what RD-13 resolves from its own
 * setup presence.
 *
 * This lives in the loader rather than in `contract/scenario.ts` so the Zod
 * boundary keeps no dependency on a rules module, and so the ±10 comparison
 * has exactly one definition — `resolveControl` — instead of a copy that can
 * drift from it. Without the check, an incoherent declaration would sit in the
 * board until the turn-end control recompute (RD-13, issue #15) silently
 * flipped it on turn 1.
 *
 * Known limitation: a per-side `control` list can name only BLUE or RED, so a
 * CONTESTED start position is unauthorable — and this check makes that bite.
 * A region holding 1..9 presence for one side and none for the other resolves
 * CONTESTED under RD-13, which no declaration can match, so a small unopposed
 * foothold cannot be authored at all. `vespera-01` does not want one. If a
 * later scenario does, the fix is to let setup express control directly
 * (CONTESTED included) or to drop the declaration and derive control from
 * presence, since `resolveControl` is now provably the authority either way.
 */
function controlCoherenceIssues(scenario: ScenarioInput): ScenarioIssue[] {
  const declared = new Map<string, Control>();
  for (const side of SIDES) {
    for (const regionId of scenario.setup.sides[side].control) {
      declared.set(regionId, side);
    }
  }

  const issues: ScenarioIssue[] = [];
  for (const region of scenario.map.regions) {
    const claimed = declared.get(region.id) ?? "NEUTRAL";
    const resolved = resolveControl({
      BLUE: setupPresence(scenario, "BLUE", region.id),
      RED: setupPresence(scenario, "RED", region.id),
    });
    if (claimed !== resolved) {
      issues.push({
        path: issuePath(scenario, region.id),
        message: `Region "${region.id}" is declared ${claimed} but its setup presence resolves to ${resolved}`,
      });
    }
  }
  return issues;
}
