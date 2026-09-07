import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CardId } from "../contract/index.ts";
import { createRng } from "../rng.ts";
import { loadScenario } from "../scenario.ts";
import { drawHand, drawHands } from "./hands.ts";

const SCENARIO = loadScenario(
  JSON.parse(
    readFileSync(new URL("../scenarios/vespera-01.json", import.meta.url), "utf8"),
  ) as unknown,
);
const SEED = "vespera-01";
const POOL: CardId[] = SCENARIO.cards.map((card) => card.id);

describe("drawHand (RD-3)", () => {
  it("deals scenario.handSize cards to each side", () => {
    expect(drawHand(SCENARIO, SEED, "BLUE", 1)).toHaveLength(SCENARIO.handSize);
    expect(drawHand(SCENARIO, SEED, "RED", 1)).toHaveLength(SCENARIO.handSize);
  });

  it("deals only catalogue cards, without replacement within one hand", () => {
    const hand = drawHand(SCENARIO, SEED, "BLUE", 1);

    expect(POOL).toEqual(expect.arrayContaining(hand));
    expect(new Set(hand).size).toBe(hand.length);
  });

  it("draws from the frozen `hand:<SIDE>:<turn>` substream", () => {
    // The label grammar, the pool, and the draw count are part of the frozen
    // replay format (rng.ts): pinned here so a change to any of them fails
    // loudly instead of silently invalidating stored replays.
    expect(drawHand(SCENARIO, SEED, "BLUE", 3)).toEqual(
      createRng(SEED).fork("hand:BLUE:3").sample(POOL, SCENARIO.handSize),
    );
    expect(drawHand(SCENARIO, SEED, "RED", 3)).toEqual(
      createRng(SEED).fork("hand:RED:3").sample(POOL, SCENARIO.handSize),
    );
  });

  it("reproduces a hand from (seed, side, turn) alone", () => {
    expect(drawHand(SCENARIO, SEED, "BLUE", 4)).toEqual(drawHand(SCENARIO, SEED, "BLUE", 4));
  });

  it("gives each side, turn, and seed its own independent hand", () => {
    const blue = drawHand(SCENARIO, SEED, "BLUE", 1);

    expect(blue).not.toEqual(drawHand(SCENARIO, SEED, "RED", 1));
    expect(blue).not.toEqual(drawHand(SCENARIO, SEED, "BLUE", 2));
    expect(blue).not.toEqual(drawHand(SCENARIO, "other-seed", "BLUE", 1));
  });

  it("treats the hand as a permission set, not a consumable stack", () => {
    // data-model / RD-2a: a dealt card may appear in several operations of the
    // same set; only the CP and ISR budgets limit repetition (T015). Nothing
    // in this module consumes, marks, or dedupes a play, so membership is
    // idempotent — the property the whole permission-set reading rests on.
    const hand = drawHand(SCENARIO, SEED, "BLUE", 1);
    const played = [hand[0], hand[0], hand[1]] as CardId[];

    expect(played.every((cardId) => hand.includes(cardId))).toBe(true);
    expect(drawHand(SCENARIO, SEED, "BLUE", 1)).toEqual(hand);
  });

  it("rejects a turn outside the frozen label grammar", () => {
    expect(() => drawHand(SCENARIO, SEED, "BLUE", 0)).toThrow(/invalid substream label/);
  });
});

describe("drawHands (RD-3)", () => {
  it("deals both sides the turn's hands from their own substreams", () => {
    expect(drawHands(SCENARIO, SEED, 2)).toEqual({
      BLUE: drawHand(SCENARIO, SEED, "BLUE", 2),
      RED: drawHand(SCENARIO, SEED, "RED", 2),
    });
  });
});
