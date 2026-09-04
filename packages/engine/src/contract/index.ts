import { z } from "zod";

/**
 * The contract boundary is the only part of the engine allowed to import Zod
 * (research R6). Rules and planner modules stay Zod-free.
 *
 * The full scenario / order / event / view schema set lands in issue #13.
 */
export const ScenarioIdSchema = z.string().min(1);

export type ScenarioId = z.infer<typeof ScenarioIdSchema>;
