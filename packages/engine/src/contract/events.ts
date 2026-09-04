import { z } from "zod";
import {
  CardIdSchema,
  ControlSchema,
  PostureBandSchema,
  RedOrdersSourceSchema,
  SideSchema,
  SupplyStateSchema,
} from "./enums.ts";
import { OperationSchema, OperationTargetSchema } from "./orders.ts";
import { ContactSchema, GameOverRecordSchema, LinkEffectSchema } from "./state.ts";

/**
 * Append-only, versioned event stream (data-model "Events").
 *
 * `seq` is monotonic per game starting at 1 with the `gameCreated` header, and
 * every event carries `visibleTo`, stamped at emission from that turn's
 * observability (RD-9) — historical visibility never changes.
 */

export const VisibilitySchema = z.object({
  BLUE: z.boolean(),
  RED: z.boolean(),
});
export type Visibility = z.infer<typeof VisibilitySchema>;

/**
 * Observable board effects attached to `orderApplied`.
 *
 * Deliberately minimal and deliberately NOT card identities: RD-9 requires
 * that an enemy operation surface to the observer as what changed on the board
 * ("enemy forces advanced into R-05"), never as which card was played. Effects
 * are the renderable payload `renderAar` turns into per-side AAR lines.
 */
export const EffectSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("presenceChanged"),
    regionId: z.string().min(1),
    side: SideSchema,
    delta: z.int(),
  }),
  z.object({
    kind: z.literal("fortChanged"),
    regionId: z.string().min(1),
    from: z.int().min(0).max(3),
    to: z.int().min(0).max(3),
  }),
  z.object({
    kind: z.literal("linkEffectAdded"),
    linkId: z.string().min(1),
    effect: LinkEffectSchema,
  }),
  z.object({
    kind: z.literal("linkEffectRemoved"),
    linkId: z.string().min(1),
    effect: LinkEffectSchema,
  }),
  z.object({
    kind: z.literal("contactCreated"),
    contact: ContactSchema,
  }),
  z.object({
    kind: z.literal("contactRemoved"),
    contact: ContactSchema,
  }),
  z.object({
    kind: z.literal("intelRefreshed"),
    regionId: z.string().min(1),
    side: SideSchema,
  }),
]);
export type Effect = z.infer<typeof EffectSchema>;

/**
 * The envelope every event carries. Spread into each variant rather than
 * intersected, so the union stays a true discriminated union on `kind` and
 * validation errors stay field-level.
 */
const envelope = {
  v: z.literal(1),
  seq: z.int().min(1),
  turn: z.int().min(1),
  visibleTo: VisibilitySchema,
};

export const EventSchema = z.discriminatedUnion("kind", [
  z.object({
    ...envelope,
    kind: z.literal("gameCreated"),
    schemaVersion: z.literal(1),
    scenarioId: z.string().min(1),
    scenarioHash: z.string().min(1),
    seed: z.string().min(1),
  }),
  z.object({ ...envelope, kind: z.literal("turnStarted"), initiative: SideSchema }),
  z.object({
    ...envelope,
    kind: z.literal("ordersAccepted"),
    side: SideSchema,
    operations: z.array(OperationSchema),
  }),
  z.object({
    ...envelope,
    kind: z.literal("orderApplied"),
    side: SideSchema,
    cardId: CardIdSchema,
    target: OperationTargetSchema,
    effects: z.array(EffectSchema),
  }),
  z.object({
    ...envelope,
    kind: z.literal("orderFizzled"),
    side: SideSchema,
    cardId: CardIdSchema,
    target: OperationTargetSchema,
    reason: z.string().min(1),
  }),
  z.object({
    ...envelope,
    kind: z.literal("controlChanged"),
    regionId: z.string().min(1),
    from: ControlSchema,
    to: ControlSchema,
  }),
  z.object({
    ...envelope,
    kind: z.literal("unrestChanged"),
    regionId: z.string().min(1),
    from: z.int().min(0).max(3),
    to: z.int().min(0).max(3),
  }),
  z.object({
    ...envelope,
    kind: z.literal("supplyChanged"),
    regionId: z.string().min(1),
    side: SideSchema,
    from: SupplyStateSchema,
    to: SupplyStateSchema,
  }),
  z.object({
    ...envelope,
    kind: z.literal("attrition"),
    regionId: z.string().min(1),
    side: SideSchema,
    amount: z.int(),
  }),
  z.object({
    ...envelope,
    kind: z.literal("linkEffectAdded"),
    linkId: z.string().min(1),
    effect: LinkEffectSchema,
  }),
  z.object({
    ...envelope,
    kind: z.literal("linkEffectExpired"),
    linkId: z.string().min(1),
    effect: LinkEffectSchema,
  }),
  z.object({
    ...envelope,
    kind: z.literal("linkEffectRemoved"),
    linkId: z.string().min(1),
    effect: LinkEffectSchema,
  }),
  z.object({ ...envelope, kind: z.literal("contactCreated"), contact: ContactSchema }),
  z.object({ ...envelope, kind: z.literal("contactExpired"), contact: ContactSchema }),
  z.object({ ...envelope, kind: z.literal("contactRemoved"), contact: ContactSchema }),
  z.object({
    ...envelope,
    kind: z.literal("politicalChanged"),
    side: SideSchema,
    from: z.int(),
    to: z.int(),
    cause: z.string().min(1),
  }),
  z.object({
    ...envelope,
    kind: z.literal("postureChanged"),
    side: SideSchema,
    band: PostureBandSchema,
  }),
  z.object({
    ...envelope,
    kind: z.literal("objectiveCompleted"),
    objectiveId: z.string().min(1),
    side: SideSchema,
    points: z.int().min(0),
  }),
  z.object({
    ...envelope,
    kind: z.literal("redOrdersSource"),
    source: RedOrdersSourceSchema,
    reason: z.string().min(1).optional(),
  }),
  z.object({ ...envelope, kind: z.literal("gameEnded"), record: GameOverRecordSchema }),
]);
export type Event = z.infer<typeof EventSchema>;

export type EventKind = Event["kind"];
