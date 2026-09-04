import { describe, expect, it } from "vitest";
import { EventSchema } from "../contract/index.ts";
import {
  createEventLog,
  isHidden,
  stampVisibility,
  visibility,
  visibleToAll,
  visibleToNone,
  visibleToOnly,
} from "./events.ts";

describe("createEventLog", () => {
  it("stamps v, turn, and a monotonic seq from the given start", () => {
    const log = createEventLog({ turn: 4, nextSeq: 12 });

    const first = log.emit({ kind: "turnStarted", initiative: "RED" }, visibleToAll());
    const second = log.emit(
      { kind: "controlChanged", regionId: "R-03", from: "BLUE", to: "CONTESTED" },
      visibleToAll(),
    );

    expect(first.v).toBe(1);
    expect(first.seq).toBe(12);
    expect(first.turn).toBe(4);
    expect(second.seq).toBe(13);
    expect(second.turn).toBe(4);
    expect(log.nextSeq()).toBe(14);
  });

  it("emits events that satisfy the wire schema", () => {
    const log = createEventLog({ turn: 1, nextSeq: 1 });
    const header = log.emit(
      {
        kind: "gameCreated",
        schemaVersion: 1,
        scenarioId: "vespera-01",
        scenarioHash: "0f1e2d3c",
        seed: "vespera-01",
      },
      visibleToAll(),
    );
    const applied = log.emit(
      {
        kind: "orderApplied",
        side: "BLUE",
        cardId: "DELIBERATE_ADVANCE",
        target: { kind: "REGION", id: "R-02" },
        effects: [{ kind: "presenceChanged", regionId: "R-02", side: "BLUE", delta: 18 }],
      },
      visibleToOnly("BLUE"),
    );

    expect(EventSchema.safeParse(header).success).toBe(true);
    expect(EventSchema.safeParse(applied).success).toBe(true);
  });

  it("copies visibleTo rather than aliasing the caller's object", () => {
    const log = createEventLog({ turn: 2, nextSeq: 1 });
    const stamp = { BLUE: true, RED: false };
    const event = log.emit({ kind: "turnStarted", initiative: "RED" }, stamp);

    stamp.RED = true;

    expect(event.visibleTo).toEqual({ BLUE: true, RED: false });
    expect(log.events()[0]?.visibleTo).toEqual({ BLUE: true, RED: false });
  });

  it("returns a frozen snapshot that callers cannot mutate", () => {
    const log = createEventLog({ turn: 1, nextSeq: 1 });
    log.emit({ kind: "turnStarted", initiative: "BLUE" }, visibleToAll());

    const snapshot = log.events();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => (snapshot as unknown as unknown[]).push({})).toThrow();

    log.emit({ kind: "postureChanged", side: "RED", band: "STRAINED" }, visibleToAll());

    expect(snapshot).toHaveLength(1);
    expect(log.events()).toHaveLength(2);
  });

  it("starts an empty log at its configured seq", () => {
    const log = createEventLog({ turn: 7, nextSeq: 42 });
    expect(log.events()).toEqual([]);
    expect(log.nextSeq()).toBe(42);
  });
});

describe("visibility helpers", () => {
  it("builds a stamp from a per-side predicate", () => {
    expect(visibility((side) => side === "RED")).toEqual({ BLUE: false, RED: true });
  });

  it("provides the three fixed stamps", () => {
    expect(visibleToAll()).toEqual({ BLUE: true, RED: true });
    expect(visibleToNone()).toEqual({ BLUE: false, RED: false });
    expect(visibleToOnly("BLUE")).toEqual({ BLUE: true, RED: false });
    expect(visibleToOnly("RED")).toEqual({ BLUE: false, RED: true });
  });

  it("lets a predicate inspect the payload it is stamping", () => {
    const payload = {
      kind: "attrition",
      regionId: "R-07",
      side: "BLUE",
      amount: -2,
    } as const;

    const stamp = stampVisibility(
      payload,
      (side, event) => side === "BLUE" || ("regionId" in event && event.regionId === "R-01"),
    );

    expect(stamp).toEqual({ BLUE: true, RED: false });
  });

  it("recognises a stamp no side can see", () => {
    expect(isHidden(visibleToNone())).toBe(true);
    expect(isHidden(visibleToOnly("RED"))).toBe(false);
  });
});
