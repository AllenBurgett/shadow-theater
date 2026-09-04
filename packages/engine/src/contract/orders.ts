import { z } from "zod";
import {
  CardIdSchema,
  ContactKindSchema,
  SideSchema,
  TargetKindSchema,
  ViolationCodeSchema,
} from "./enums.ts";

/**
 * Order contract (data-model "OrderSet").
 *
 * One schema drives engine validation, the server boundary, and the Ollama
 * `format` schema (RD-10 / research R6) — hence `theme` is `.nullable()`
 * rather than `.optional()`: grammar decoders want every key present.
 */

export const OperationTargetSchema = z.object({
  kind: TargetKindSchema,
  id: z.string().min(1),
});
export type OperationTarget = z.infer<typeof OperationTargetSchema>;

export const OperationSchema = z.object({
  cardId: CardIdSchema,
  target: OperationTargetSchema,
  /** SPOOF_CONTACTS only; non-null on any other card is THEME_NOT_APPLICABLE. */
  theme: ContactKindSchema.nullable(),
});
export type Operation = z.infer<typeof OperationSchema>;

export const OrderSetSchema = z.object({
  side: SideSchema,
  turn: z.int().min(1),
  operations: z.array(OperationSchema),
});
export type OrderSet = z.infer<typeof OrderSetSchema>;

export const ViolationSchema = z.object({
  code: ViolationCodeSchema,
  cardId: CardIdSchema.optional(),
  targetId: z.string().min(1).optional(),
  detail: z.string().min(1),
});
export type Violation = z.infer<typeof ViolationSchema>;

/** Whole-set rejection: no state change, every violation named (RD-2). */
export const OrderRejectionSchema = z.object({
  violations: z.array(ViolationSchema),
});
export type OrderRejection = z.infer<typeof OrderRejectionSchema>;
