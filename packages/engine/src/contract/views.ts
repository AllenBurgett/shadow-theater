import { z } from "zod";
import {
  CardIdSchema,
  ContactKindSchema,
  ControlSchema,
  GameOverReasonSchema,
  IntelConfidenceSchema,
  LinkEffectKindSchema,
  ObjectiveVisibilitySchema,
  PostureBandSchema,
  SideSchema,
  SupplyStateSchema,
  WinnerSchema,
} from "./enums.ts";
import { ObjectiveConditionSchema } from "./scenario.ts";
import { CompletionRecordSchema, LinkEffectSchema } from "./state.ts";

/**
 * Side-safe projection (data-model "Projection").
 *
 * Static scenario data (names, coordinates, base capacities, the card
 * catalogue) is served once by `GET /api/scenario` and is deliberately absent
 * here (review M14). Forbidden-field tests (SC-003) enumerate what must never
 * appear: enemy secret objectives, enemy hand, exact enemy political value,
 * exact enemy presence, enemy-side supply, own contacts echoed back.
 */

/** RD-9's disclosure granularity for enemy presence estimates. */
const ESTIMATE_STEP = 10;

/**
 * Enemy presence disclosure, with both of RD-9's clauses enforced by the
 * contract rather than trusted to the projection: "enemy presence estimates
 * round to nearest 10; UNKNOWN → null estimate". Both are information
 * boundaries, not formatting — exact enemy presence is an SC-003 forbidden
 * field, so an unrounded estimate is itself the leak, and an estimate carried
 * alongside UNKNOWN discloses what the viewer has not observed. Each failure
 * reports at `estimate`, so it lands field-level like a scenario load error.
 */
export const EnemyEstimateSchema = z
  .object({
    confidence: IntelConfidenceSchema,
    /** Rounded to the nearest 10; null when confidence is UNKNOWN. */
    estimate: z.int().min(0).max(100).multipleOf(ESTIMATE_STEP).nullable(),
  })
  .refine((enemy) => enemy.confidence !== "UNKNOWN" || enemy.estimate === null, {
    message: "UNKNOWN confidence must carry a null estimate (RD-9)",
    path: ["estimate"],
  });
export type EnemyEstimate = z.infer<typeof EnemyEstimateSchema>;

export const RegionViewSchema = z.object({
  id: z.string().min(1),
  /** Control is fully disclosed in M1 (RD-9; fogging deferred to M2). */
  control: ControlSchema,
  fort: z.int().min(0).max(3),
  unrest: z.int().min(0).max(3),
  ownPresence: z.int().min(0).max(100),
  enemy: EnemyEstimateSchema,
  ownSupply: SupplyStateSchema,
  intelAge: z.int().min(0),
});
export type RegionView = z.infer<typeof RegionViewSchema>;

export const ObservedLinkEffectSchema = z.object({
  kind: LinkEffectKindSchema,
  expiresTurn: z.int().min(1),
});
export type ObservedLinkEffect = z.infer<typeof ObservedLinkEffectSchema>;

export const LinkViewSchema = z.object({
  id: z.string().min(1),
  /** null when jam-masked for this viewer (RD-9). */
  effectiveCapacity: z.int().min(0).nullable(),
  ownEffects: z.array(LinkEffectSchema),
  /** Enemy effects: kind + expiry only, owner implicit. */
  observedEnemyEffects: z.array(ObservedLinkEffectSchema),
});
export type LinkView = z.infer<typeof LinkViewSchema>;

/** Enemy-created contacts only; authorship is never exposed. */
export const ContactViewSchema = z.object({
  id: z.string().min(1),
  regionId: z.string().min(1),
  kind: ContactKindSchema,
  expiresTurn: z.int().min(1),
});
export type ContactView = z.infer<typeof ContactViewSchema>;

export const ObjectiveViewSchema = z.object({
  id: z.string().min(1),
  visibility: ObjectiveVisibilitySchema,
  points: z.int().min(0),
  condition: ObjectiveConditionSchema,
  completedTurn: z.int().min(1).nullable(),
});
export type ObjectiveView = z.infer<typeof ObjectiveViewSchema>;

/** A rendered observed effect, produced by `renderAar` (review N4). */
export const AarEntrySchema = z.object({
  seq: z.int().min(1),
  kind: z.string().min(1),
  text: z.string().min(1),
  regionId: z.string().min(1).optional(),
  linkId: z.string().min(1).optional(),
});
export type AarEntry = z.infer<typeof AarEntrySchema>;

export const GameOverViewSchema = z.object({
  winner: WinnerSchema,
  reason: GameOverReasonSchema,
  endedOnTurn: z.int().min(1),
  ownPoints: z.int().min(0),
  enemyPublicPoints: z.int().min(0),
  ownCompletions: z.array(CompletionRecordSchema),
});
export type GameOverView = z.infer<typeof GameOverViewSchema>;

export const SideViewSchema = z.object({
  side: SideSchema,
  turn: z.int().min(1),
  initiative: SideSchema,
  /** Own exact values only. */
  resources: z.object({
    cp: z.int().min(0),
    isr: z.int().min(0),
    political: z.int(),
  }),
  /** Coarse bands both ways — the enemy's exact political value never leaks. */
  posture: z.object({ own: PostureBandSchema, enemy: PostureBandSchema }),
  hand: z.array(CardIdSchema),
  legalTargets: z.record(CardIdSchema, z.array(z.string().min(1))),
  regions: z.array(RegionViewSchema),
  links: z.array(LinkViewSchema),
  contacts: z.array(ContactViewSchema),
  objectives: z.object({
    own: z.array(ObjectiveViewSchema),
    enemyPublic: z.array(ObjectiveViewSchema),
  }),
  completions: z.object({
    own: z.array(CompletionRecordSchema),
    enemyPublic: z.array(CompletionRecordSchema),
  }),
  points: z.object({ own: z.int().min(0), enemyPublic: z.int().min(0) }),
  aar: z.array(AarEntrySchema),
  gameOver: GameOverViewSchema.nullable(),
});
export type SideView = z.infer<typeof SideViewSchema>;
