import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONTROL_MARGIN,
  type Config,
  ConfigSchema,
  canonicalJson,
  createEventLog,
  createGame,
  createRng,
  drawHand,
  effectiveCapacity,
  fnv1a32,
  initiativeFor,
  type LlmConfig,
  type LoggingConfig,
  legalTargets,
  loadScenario,
  OrderSetSchema,
  OrderValidationError,
  resolveControl,
  resolveTurn,
  ScenarioLoadError,
  type ServerConfig,
  validateOrders,
  visibleToAll,
} from "./index.ts";

const scenarioJson = JSON.parse(
  readFileSync(new URL("./scenarios/vespera-01.json", import.meta.url), "utf8"),
) as unknown;

describe("@shadow/engine entry point", () => {
  it("re-exports the foundation API", () => {
    expect(typeof loadScenario).toBe("function");
    expect(typeof createRng).toBe("function");
    expect(typeof createEventLog).toBe("function");
    expect(typeof fnv1a32).toBe("function");
    expect(typeof canonicalJson).toBe("function");
    expect(ScenarioLoadError.prototype).toBeInstanceOf(Error);
  });

  it("re-exports the first rules slice", () => {
    expect(typeof createGame).toBe("function");
    expect(typeof resolveControl).toBe("function");
    expect(typeof drawHand).toBe("function");
    expect(typeof legalTargets).toBe("function");
    expect(typeof effectiveCapacity).toBe("function");
    expect(typeof validateOrders).toBe("function");
    expect(typeof resolveTurn).toBe("function");
    expect(initiativeFor(1)).toBe("BLUE");
    expect(OrderValidationError.prototype).toBeInstanceOf(Error);
    expect(CONTROL_MARGIN).toBe(10);
  });

  it("re-exports the contract schemas", () => {
    expect(
      OrderSetSchema.safeParse({
        side: "BLUE",
        turn: 1,
        operations: [
          {
            cardId: "SPOOF_CONTACTS",
            target: { kind: "REGION", id: "R-05" },
            theme: "recon-activity",
          },
        ],
      }).success,
    ).toBe(true);
    expect(OrderSetSchema.safeParse({ side: "GREEN", turn: 1, operations: [] }).success).toBe(
      false,
    );
  });

  it("ships the least-disclosure config defaults", () => {
    // Annotated with the exported inferred types, so the entry point dropping
    // one — or a block's shape drifting — is a typecheck failure rather than a
    // silently missing export.
    const config: Config = ConfigSchema.parse({});
    const server: ServerConfig = config.server;
    const llm: LlmConfig = config.llm;
    const logging: LoggingConfig = config.logging;

    expect({ server, llm, logging }).toEqual({
      server: { port: 3000, host: "127.0.0.1" },
      llm: {
        enabled: false,
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen3.6",
        timeoutMs: 60000,
        keepAlive: "30m",
      },
      logging: { dir: "./logs", diagnostics: false },
    });
  });

  it("canonicalises JSON by sorted keys, dropping undefined values", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, { f: 3, e: 4 }] } })).toBe(
      '{"a":{"c":[2,{"e":4,"f":3}]},"b":1}',
    );
  });

  it("composes the loader, the RNG, the event log, and game creation", () => {
    const scenario = loadScenario(scenarioJson);
    const state = createGame(scenario, scenario.id);
    const hand = createRng(scenario.id)
      .fork("hand:BLUE:1")
      .sample(scenario.cards, scenario.handSize);
    const log = createEventLog({ turn: 1, nextSeq: 1 });
    const header = log.emit(
      {
        kind: "gameCreated",
        schemaVersion: 1,
        scenarioId: scenario.id,
        scenarioHash: scenario.hash,
        seed: scenario.id,
      },
      visibleToAll(),
    );

    expect(hand).toHaveLength(6);
    expect(state.sides.BLUE.hand).toEqual(hand.map((card) => card.id));
    expect(header.kind).toBe("gameCreated");
    if (header.kind === "gameCreated") {
      expect(header.scenarioHash).toBe(scenario.hash);
    }
  });
});
