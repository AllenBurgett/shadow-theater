import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AutoLoadSchema = z
  .object({
    enabled: z.boolean().default(false),
    modelName: z.string().min(1).optional(),
    args: z.record(z.string(), z.any()).optional(),
    settings: z.record(z.string(), z.any()).optional(),
    waitForLoadMs: z.number().int().min(1000).max(600000).default(300000)
  })
  .prefault({});

const LlmProfileSchema = z
  .object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().min(1).default("http://127.0.0.1:5000"),
    apiKey: z.string().default(""),
    adminKey: z.string().default(""),
    model: z.string().min(1).default("local-model"),
    autoLoad: AutoLoadSchema,
    ooba: z
      .object({
        mode: z.string().default(""),
        instructionTemplate: z.string().default("")
      })
      .prefault({}),
    sampling: z
      .object({
        temperature: z.number().min(0).max(2).default(0.2),
        maxTokens: z.number().int().min(1).max(8192).default(700),
        topP: z.number().min(0).max(1).optional(),
        topK: z.number().int().min(0).optional(),
        stop: z.array(z.string()).optional()
      })
      .prefault({}),
    timeoutMs: z.number().int().min(1000).max(300000).default(30000)
  })
  .prefault({});

const LoggingSchema = z
  .object({
    enabled: z.boolean().default(false),
    dir: z.string().default("./logs"),
    keepInMemory: z.number().int().min(0).max(5000).default(500),
    includeRawLlmText: z.boolean().default(true),
    includeRedView: z.boolean().default(true)
  })
  .prefault({});

const ConfigSchema = z
  .object({
    server: z
      .object({
        port: z.number().int().min(1).max(65535).default(3000),
        seed: z.string().min(1).default("VESPERA-01")
      })
      .prefault({}),
    logging: LoggingSchema,
    llm: z
      .object({
        red: LlmProfileSchema.prefault({}),
        gm: LlmProfileSchema.prefault({})
      })
      .prefault({})
  })
  .prefault({});

export function loadConfig() {
  const cfgPath = process.env.SHADOW_CONFIG
    ? path.resolve(process.cwd(), process.env.SHADOW_CONFIG)
    : path.resolve(__dirname, "config.json");

  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch {
    raw = {};
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const errs = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid config.json: ${errs}`);
  }

  return parsed.data;
}