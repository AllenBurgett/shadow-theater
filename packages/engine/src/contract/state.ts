import { z } from "zod";
import {
  CardIdSchema,
  ContactKindSchema,
  ControlSchema,
  GameOverReasonSchema,
  LinkEffectKindSchema,
  SideSchema,
  SupplyStateSchema,
  WinnerSchema,
} from "./enums.ts";

/**
 * Engine-owned canonical state (data-model "GameState").
 *
 * `GameState` references its scenario by id only — the scenario itself is
 * always an explicit parameter to engine functions, never module state
 * (engine-api / review B1).
 */

const PRESENCE = z.int().min(0).max(100);

export const RegionStateSchema = z.object({
  control: ControlSchema,
  /** Previous turn-end control, written once at the end of evaluation (RD-8). */
  lastController: ControlSchema,
  presence: z.object({ BLUE: PRESENCE, RED: PRESENCE }),
  fort: z.int().min(0).max(3),
  unrest: z.int().min(0).max(3),
  supply: z.object({ BLUE: SupplyStateSchema, RED: SupplyStateSchema }),
});
export type RegionState = z.infer<typeof RegionStateSchema>;

export const LinkEffectSchema = z.object({
  kind: LinkEffectKindSchema,
  side: SideSchema,
  expiresTurn: z.int().min(1),
});
export type LinkEffect = z.infer<typeof LinkEffectSchema>;

/** Effective capacity is derived (RD-7), never stored. */
export const LinkStateSchema = z.object({
  effects: z.array(LinkEffectSchema),
});
export type LinkState = z.infer<typeof LinkStateSchema>;

export const SideStateSchema = z.object({
  political: z.int(),
  /** Drawn per turn from substream `hand:<SIDE>:<turn>` (RD-3). */
  hand: z.array(CardIdSchema),
  /** 0 = observed at the last resolution; incremented in timers (RD-9). */
  intelAge: z.record(z.string().min(1), z.int().min(0)),
});
export type SideState = z.infer<typeof SideStateSchema>;

/** Rumor contact; id is seeded from substream `rumor:<SIDE>:<turn>` (RD-9). */
export const ContactSchema = z.object({
  id: z.string().min(1),
  side: SideSchema,
  regionId: z.string().min(1),
  kind: ContactKindSchema,
  expiresTurn: z.int().min(1),
});
export type Contact = z.infer<typeof ContactSchema>;

/** Completion is sticky; each objective scores once (RD-11). */
export const CompletionRecordSchema = z.object({
  objectiveId: z.string().min(1),
  side: SideSchema,
  turn: z.int().min(1),
});
export type CompletionRecord = z.infer<typeof CompletionRecordSchema>;

/** Per-objective progress, keyed per region/link where the condition quantifies. */
export const ProgressRecordSchema = z.object({
  objectiveId: z.string().min(1),
  key: z.string().min(1).nullable(),
  counter: z.int().min(0),
  armed: z.boolean(),
  failed: z.boolean(),
});
export type ProgressRecord = z.infer<typeof ProgressRecordSchema>;

/** Computed once at game-over evaluation and stored; views never recompute it. */
export const GameOverRecordSchema = z.object({
  reason: GameOverReasonSchema,
  winner: WinnerSchema,
  endedOnTurn: z.int().min(1),
  points: z.object({ BLUE: z.int().min(0), RED: z.int().min(0) }),
});
export type GameOverRecord = z.infer<typeof GameOverRecordSchema>;

export const GameStateSchema = z.object({
  scenarioId: z.string().min(1),
  seed: z.string().min(1),
  /** 1-based; initiative is derived (BLUE on odd turns), never stored (RD-1). */
  turn: z.int().min(1),
  regions: z.record(z.string().min(1), RegionStateSchema),
  links: z.record(z.string().min(1), LinkStateSchema),
  sides: z.object({ BLUE: SideStateSchema, RED: SideStateSchema }),
  contacts: z.array(ContactSchema),
  objectiveHistory: z.array(CompletionRecordSchema),
  objectiveProgress: z.array(ProgressRecordSchema),
  gameOver: GameOverRecordSchema.nullable(),
});
export type GameState = z.infer<typeof GameStateSchema>;
