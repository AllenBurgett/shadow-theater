import type {
  CardId,
  Contact,
  Control,
  Effect,
  GameState,
  LinkState,
  RegionState,
  Scenario,
  Side,
  SideState,
  SupplyState,
} from "../contract/index.ts";
import { drawHands } from "./hands.ts";

/**
 * Game state: creation (engine-api `createGame`) and the structural-sharing
 * updates every rules module applies to it.
 *
 * Builds the canonical `GameState` from a loaded scenario and a seed. The
 * scenario is an explicit parameter and is only read — `loadScenario` hands
 * back a deep-frozen document (review B1) — so `GameState` references it by
 * id and no module-level scenario state exists.
 */

/** A turn-end control flip an operation caused, for the resolver's events. */
export interface ControlChange {
  regionId: string;
  from: Control;
  to: Control;
}

/**
 * The result of applying one operation (RD-2a).
 *
 * Operations are pure: they return the next state rather than editing the one
 * they are given, and they emit nothing — the resolver (T016) owns the event
 * log and turns `effects` into `orderApplied` and `controlChanges` into
 * `controlChanged`. `applied: false` is RD-1's fizzle path, carrying the
 * reason the resolver records in `orderFizzled`.
 */
export type OpOutcome =
  | { applied: true; state: GameState; effects: Effect[]; controlChanges: ControlChange[] }
  | { applied: false; reason: string };

/** Replaces one region, sharing every untouched branch of the state. */
export function withRegion(state: GameState, regionId: string, region: RegionState): GameState {
  return { ...state, regions: { ...state.regions, [regionId]: region } };
}

/** Replaces one link. */
export function withLink(state: GameState, linkId: string, link: LinkState): GameState {
  return { ...state, links: { ...state.links, [linkId]: link } };
}

/** Replaces one side's state. */
export function withSide(state: GameState, side: Side, sideState: SideState): GameState {
  return { ...state, sides: { ...state.sides, [side]: sideState } };
}

/** Replaces the contact list. */
export function withContacts(state: GameState, contacts: Contact[]): GameState {
  return { ...state, contacts };
}

/** Games start on turn 1; initiative is derived from the turn, never stored (RD-1). */
const FIRST_TURN = 1;

const SIDES: readonly Side[] = ["BLUE", "RED"];

/**
 * Intel age for a region a side has not observed at creation.
 *
 * RD-9 renders age 0 as CONFIRMED and ≤ 2 as LIKELY, so 3 is the *smallest*
 * value that reads UNKNOWN — which is exactly right at game start, where a
 * side has observed nothing but its own starting regions. It is a chosen
 * minimum, not an arbitrary constant.
 */
export const UNOBSERVED_INTEL_AGE = 3;

/**
 * The control the scenario declares, by side setup list.
 *
 * Initial control is applied declaratively rather than derived from presence:
 * the prototype set it explicitly (`game.js:158-167`) and the scenario authors
 * it. `state.test.ts` carries the creation invariant that the declaration
 * agrees with `resolveControl` of the same setup presence, so a scenario
 * cannot declare a control its own numbers contradict.
 *
 * Note that a per-side control list can only express BLUE, RED, or NEUTRAL —
 * a CONTESTED start position is unauthorable today. A region claimed by more
 * than one side is a scenario load error (`checkScenarioInvariants`), so the
 * map below can never disagree with itself.
 */
function declaredControl(scenario: Scenario): Map<string, Control> {
  const declared = new Map<string, Control>();
  for (const side of SIDES) {
    for (const regionId of scenario.setup.sides[side].control) {
      declared.set(regionId, side);
    }
  }
  return declared;
}

/** Setup presence for both sides; an unlisted region starts empty. */
function initialPresence(scenario: Scenario, regionId: string): RegionState["presence"] {
  return {
    BLUE: scenario.setup.sides.BLUE.presence[regionId] ?? 0,
    RED: scenario.setup.sides.RED.presence[regionId] ?? 0,
  };
}

/**
 * RD-12's ordered assignment minus its first tier: controlled by the side →
 * THIN; else that side is present → CUT; else NONE.
 *
 * No region starts IN_SUPPLY, because that tier requires the port-reachability
 * BFS over effective link capacity, which is **T019 in issue #15**. The supply
 * recompute landing there runs in the turn phase and supersedes this
 * initialisation — this is a deliberate placeholder, not the final rule.
 */
function initialSupply(
  control: Control,
  presence: RegionState["presence"],
  side: Side,
): SupplyState {
  if (control === side) {
    return "THIN";
  }
  if (presence[side] > 0) {
    return "CUT";
  }
  return "NONE";
}

function createRegionState(
  scenario: Scenario,
  regionId: string,
  declared: Map<string, Control>,
): RegionState {
  const presence = initialPresence(scenario, regionId);
  const control = declared.get(regionId) ?? "NEUTRAL";
  return {
    control,
    // RD-5/RD-8 read `lastController` as "control at the previous turn end".
    // Seeding it with the initial control is what stops turn 1 registering a
    // spurious controller change — unrest +1 everywhere a side starts, and a
    // habitat-loss political penalty against a habitat nobody lost.
    lastController: control,
    presence,
    fort: 0,
    unrest: 0,
    supply: {
      BLUE: initialSupply(control, presence, "BLUE"),
      RED: initialSupply(control, presence, "RED"),
    },
  };
}

function createSideState(scenario: Scenario, side: Side, hand: CardId[]): SideState {
  const intelAge: Record<string, number> = {};
  for (const region of scenario.map.regions) {
    // "Observed" is derived from setup presence per RD-9's own rule (own
    // presence > 0), not from the control list: presence is what the rule
    // reads every turn thereafter, so creation must not use a second notion.
    const observed = (scenario.setup.sides[side].presence[region.id] ?? 0) > 0;
    intelAge[region.id] = observed ? 0 : UNOBSERVED_INTEL_AGE;
  }
  return {
    political: scenario.resources.politicalStart,
    hand,
    intelAge,
  };
}

/** Builds the initial canonical state for `scenario` under `seed`. */
export function createGame(scenario: Scenario, seed: string): GameState {
  const declared = declaredControl(scenario);

  const regions: Record<string, RegionState> = {};
  for (const region of scenario.map.regions) {
    regions[region.id] = createRegionState(scenario, region.id, declared);
  }

  const links: Record<string, LinkState> = {};
  for (const link of scenario.map.links) {
    links[link.id] = { effects: [] };
  }

  // Turn 1's hands are drawn here, not by the first `resolveTurn`: both sides
  // submit orders against turn 1 before any turn resolves, and validation
  // reads `SideState.hand` (RD-3).
  const hands = drawHands(scenario, seed, FIRST_TURN);

  return {
    scenarioId: scenario.id,
    seed,
    turn: FIRST_TURN,
    regions,
    links,
    sides: {
      BLUE: createSideState(scenario, "BLUE", hands.BLUE),
      RED: createSideState(scenario, "RED", hands.RED),
    },
    contacts: [],
    objectiveHistory: [],
    objectiveProgress: [],
    gameOver: null,
  };
}
