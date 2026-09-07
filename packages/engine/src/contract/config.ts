import { z } from "zod";

/**
 * Server configuration (data-model "Server config").
 *
 * Every field has a default, so the whole document is optional in the input:
 * `ConfigSchema.parse({})` yields the shipped defaults. `.prefault({})` (Zod 4:
 * `.default()` takes the *output* type, `.prefault()` the input) lets each
 * nested block fill itself in.
 *
 * `logging.diagnostics: false` is the least-disclosure default of FR-018: no
 * raw model text, no prompts, no rationale in the JSONL stream.
 */

export const ServerConfigSchema = z
  .object({
    port: z.int().min(1).max(65_535).default(3000),
    /** Loopback-only by construction; not configurable (plan Constraints). */
    host: z.literal("127.0.0.1").default("127.0.0.1"),
  })
  .prefault({});

export const LlmConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    baseUrl: z.url().default("http://127.0.0.1:11434"),
    model: z.string().min(1).default("qwen3.6"),
    timeoutMs: z.int().min(1).default(60_000),
    keepAlive: z.string().min(1).default("30m"),
  })
  .prefault({});

export const LoggingConfigSchema = z
  .object({
    dir: z.string().min(1).default("./logs"),
    diagnostics: z.boolean().default(false),
  })
  .prefault({});

/**
 * Resolved types for the nested blocks, so a consumer can name one without
 * indexing into `Config` (`createApp(config: ServerConfig)`).
 *
 * Output types only, deliberately: R6 requires the input/output split at a
 * *boundary* using `.default()`, and the boundary is the whole document —
 * `ConfigSchema.parse(...)` — which exports both below. No block is ever
 * parsed on its own, so a nested input type would name a shape nothing
 * receives.
 */
export type ServerConfig = z.output<typeof ServerConfigSchema>;
export type LlmConfig = z.output<typeof LlmConfigSchema>;
export type LoggingConfig = z.output<typeof LoggingConfigSchema>;

export const ConfigSchema = z
  .object({
    server: ServerConfigSchema,
    llm: LlmConfigSchema,
    logging: LoggingConfigSchema,
  })
  .prefault({});

/** What a caller may supply (every key optional). */
export type ConfigInput = z.input<typeof ConfigSchema>;
/** What the parser returns (every default resolved). */
export type Config = z.output<typeof ConfigSchema>;
