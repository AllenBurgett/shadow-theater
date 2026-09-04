import { z } from "zod";
import { RedOrdersSourceSchema } from "./enums.ts";

/**
 * Feasibility-gate record (data-model "Feasibility record", slice 2 output).
 * `hardware` is required by Constitution III: a spike result is only evidence
 * if it can be reproduced on named hardware.
 */

export const SeedResultSchema = z.object({
  seed: z.string().min(1),
  outcome: RedOrdersSourceSchema,
  parseOk: z.boolean(),
  legalOk: z.boolean(),
  repairUsed: z.boolean(),
  fallbackReason: z.string().min(1).optional(),
  timings: z.object({
    totalMs: z.int().min(0),
    firstAttemptMs: z.int().min(0),
  }),
});
export type SeedResult = z.infer<typeof SeedResultSchema>;

export const SpikeReportSchema = z.object({
  model: z.string().min(1),
  sampling: z.object({
    temperature: z.number().min(0),
    seed: z.int(),
    num_ctx: z.int().min(1),
  }),
  scenarioId: z.string().min(1),
  scenarioHash: z.string().min(1),
  hardware: z.object({
    description: z.string().min(1),
    ollamaVersion: z.string().min(1),
  }),
  startedAt: z.string().min(1),
  seeds: z.array(SeedResultSchema),
});
export type SpikeReport = z.infer<typeof SpikeReportSchema>;
