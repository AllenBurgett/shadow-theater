import { z } from "zod";
import {
  CardDomainSchema,
  CardIdSchema,
  ObjectiveVisibilitySchema,
  RegionTypeSchema,
  SideSchema,
  TargetKindSchema,
} from "./enums.ts";

/**
 * Scenario schema — the versioned, committed game definition (data-model
 * "Scenario"). `loadScenario` parses raw JSON with `ScenarioInputSchema` and
 * then derives `hash`, which is deliberately NOT part of the JSON.
 */

export const RegionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: RegionTypeSchema,
  x: z.int(),
  y: z.int(),
});
export type Region = z.infer<typeof RegionSchema>;

export const LinkSchema = z.object({
  id: z.string().min(1),
  a: z.string().min(1),
  b: z.string().min(1),
  capacity: z.int().min(1).max(3),
});
export type Link = z.infer<typeof LinkSchema>;

export const CardSchema = z.object({
  id: CardIdSchema,
  name: z.string().min(1),
  cp: z.int().min(0),
  isr: z.int().min(0),
  target: TargetKindSchema,
  domain: CardDomainSchema,
  text: z.string().min(1),
});
export type Card = z.infer<typeof CardSchema>;

export const MapSchema = z.object({
  regions: z.array(RegionSchema).min(1),
  links: z.array(LinkSchema).min(1),
});
export type ScenarioMap = z.infer<typeof MapSchema>;

export const SideSetupSchema = z.object({
  presence: z.record(z.string().min(1), z.int().min(0).max(100)),
  control: z.array(z.string().min(1)),
});
export type SideSetup = z.infer<typeof SideSetupSchema>;

export const ScenarioResourcesSchema = z.object({
  cpPerTurn: z.int().min(0),
  isrPerTurn: z.int().min(0),
  politicalStart: z.int().min(1),
});
export type ScenarioResources = z.infer<typeof ScenarioResourcesSchema>;

/**
 * Structured objective conditions (RD-11). Field names are normative: the
 * region-quantified conditions carry `regionId`, the type-quantified ones
 * carry `regionType`. An unknown `type` is a field-level load error.
 */
export const ObjectiveConditionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("controlRegion"),
    regionId: z.string().min(1),
    byTurn: z.int().min(1),
  }),
  z.object({
    type: z.literal("holdRegionType"),
    regionType: RegionTypeSchema,
    count: z.int().min(1),
    throughTurn: z.int().min(1),
  }),
  z.object({
    type: z.literal("suppressLinkAdjacent"),
    regionId: z.string().min(1),
    byTurn: z.int().min(1),
    consecutiveTurns: z.int().min(1),
  }),
  z.object({
    type: z.literal("contestRegionType"),
    regionType: RegionTypeSchema,
    consecutiveTurns: z.int().min(1),
    byTurn: z.int().min(1),
  }),
  z.object({
    type: z.literal("fortifyRegionType"),
    regionType: RegionTypeSchema,
    level: z.int().min(1).max(3),
  }),
  z.object({
    type: z.literal("reduceEnemyPresence"),
    regionType: RegionTypeSchema,
    below: z.int().min(0).max(100),
    armAt: z.int().min(0).max(100),
  }),
  z.object({
    type: z.literal("sustainOwnJam"),
    turns: z.int().min(1),
  }),
  z.object({
    type: z.literal("activeRumorsInEnemyControlled"),
    count: z.int().min(1),
    consecutiveTurns: z.int().min(1),
  }),
]);
export type ObjectiveCondition = z.infer<typeof ObjectiveConditionSchema>;

export const ObjectiveDefSchema = z.object({
  id: z.string().min(1),
  visibility: ObjectiveVisibilitySchema,
  points: z.int().min(1),
  condition: ObjectiveConditionSchema,
});
export type ObjectiveDef = z.infer<typeof ObjectiveDefSchema>;

/**
 * Scenario constraints (RD-8). M1 implements exactly one; the union keeps the
 * shape open for later milestones and makes an unknown `type` fail load.
 */
export const TypedConstraintSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("habitatLossPoliticalPenalty"),
    amount: z.int().min(0),
  }),
]);
export type TypedConstraint = z.infer<typeof TypedConstraintSchema>;

export const SetupSchema = z.object({
  sides: z.object({
    BLUE: SideSetupSchema,
    RED: SideSetupSchema,
  }),
});
export type ScenarioSetup = z.infer<typeof SetupSchema>;

export const ObjectivesSchema = z.object({
  BLUE: z.array(ObjectiveDefSchema),
  RED: z.array(ObjectiveDefSchema),
});
export type ScenarioObjectives = z.infer<typeof ObjectivesSchema>;

const ScenarioShapeSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  turnLimit: z.int().min(1),
  winPoints: z.int().min(1),
  resources: ScenarioResourcesSchema,
  handSize: z.int().min(1),
  map: MapSchema,
  cards: z.array(CardSchema).min(1),
  setup: SetupSchema,
  objectives: ObjectivesSchema,
  constraints: z.array(TypedConstraintSchema),
});

type ScenarioShape = z.infer<typeof ScenarioShapeSchema>;

const SIDES = SideSchema.options;

function reportDuplicates(
  ctx: z.RefinementCtx,
  ids: readonly string[],
  basePath: readonly (string | number)[],
  label: string,
): void {
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (seen.has(id)) {
      ctx.addIssue({
        code: "custom",
        message: `Duplicate ${label} id "${id}"`,
        path: [...basePath, index, "id"],
      });
    }
    seen.add(id);
  });
}

/** Cross-field invariants that a per-field schema cannot express. */
function checkScenarioInvariants(scenario: ScenarioShape, ctx: z.RefinementCtx): void {
  const regionIds = new Set(scenario.map.regions.map((region) => region.id));

  reportDuplicates(
    ctx,
    scenario.map.regions.map((region) => region.id),
    ["map", "regions"],
    "region",
  );
  reportDuplicates(
    ctx,
    scenario.map.links.map((link) => link.id),
    ["map", "links"],
    "link",
  );
  reportDuplicates(
    ctx,
    scenario.cards.map((card) => card.id),
    ["cards"],
    "card",
  );

  for (const [index, link] of scenario.map.links.entries()) {
    for (const endpoint of ["a", "b"] as const) {
      if (!regionIds.has(link[endpoint])) {
        ctx.addIssue({
          code: "custom",
          message: `Link "${link.id}" references unknown region "${link[endpoint]}"`,
          path: ["map", "links", index, endpoint],
        });
      }
    }
  }

  if (scenario.handSize > scenario.cards.length) {
    ctx.addIssue({
      code: "custom",
      message: `handSize ${scenario.handSize} exceeds the ${scenario.cards.length}-card catalogue`,
      path: ["handSize"],
    });
  }

  for (const side of SIDES) {
    const setup = scenario.setup.sides[side];
    for (const regionId of Object.keys(setup.presence)) {
      if (!regionIds.has(regionId)) {
        ctx.addIssue({
          code: "custom",
          message: `Setup presence references unknown region "${regionId}"`,
          path: ["setup", "sides", side, "presence", regionId],
        });
      }
    }
    for (const [index, regionId] of setup.control.entries()) {
      if (!regionIds.has(regionId)) {
        ctx.addIssue({
          code: "custom",
          message: `Setup control references unknown region "${regionId}"`,
          path: ["setup", "sides", side, "control", index],
        });
      }
    }
  }

  const objectiveIds = new Set<string>();
  for (const side of SIDES) {
    for (const [index, objective] of scenario.objectives[side].entries()) {
      if (objectiveIds.has(objective.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate objective id "${objective.id}"`,
          path: ["objectives", side, index, "id"],
        });
      }
      objectiveIds.add(objective.id);

      const { condition } = objective;
      if ("regionId" in condition && !regionIds.has(condition.regionId)) {
        ctx.addIssue({
          code: "custom",
          message: `Objective "${objective.id}" references unknown region "${condition.regionId}"`,
          path: ["objectives", side, index, "condition", "regionId"],
        });
      }
    }
  }
}

/**
 * The JSON-facing scenario schema: exactly what a `vespera-01.json` file
 * contains. `hash` is absent by construction — it is derived by the loader.
 */
export const ScenarioInputSchema = ScenarioShapeSchema.superRefine(checkScenarioInvariants);

/** The parsed scenario as it exists on disk, before the loader adds `hash`. */
export type ScenarioInput = z.infer<typeof ScenarioInputSchema>;

/**
 * A loaded scenario: the validated document plus the content hash
 * `loadScenario` derives from it (vendored FNV-1a over canonical JSON,
 * analysis A03). `createGame` copies `hash` into the `gameCreated` header so
 * an edited scenario cannot silently reinterpret an old replay (review N15).
 */
export type Scenario = ScenarioInput & { readonly hash: string };

/** One field-level load failure; `path` is dotted, e.g. `map.links.3.b`. */
export interface ScenarioIssue {
  path: string;
  message: string;
}

export type ScenarioParseResult =
  | { ok: true; value: ScenarioInput }
  | { ok: false; issues: ScenarioIssue[]; message: string };

/**
 * Validates raw scenario JSON at the contract boundary.
 *
 * Returned rather than thrown so the loader — which lives outside `contract/`
 * and must stay Zod-free — can shape the error without importing Zod.
 */
export function parseScenario(json: unknown): ScenarioParseResult {
  const result = ScenarioInputSchema.safeParse(json);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map((segment) => String(segment)).join("."),
      message: issue.message,
    })),
    message: z.prettifyError(result.error),
  };
}
