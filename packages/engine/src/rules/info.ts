import type { Contact, ContactKind, Effect, GameState, Side } from "../contract/index.ts";
import type { Rng } from "../rng.ts";
import { EFFECT_DURATION } from "./legality.ts";
import type { OpOutcome } from "./state.ts";
import { OBSERVED_INTEL_AGE, withContacts, withSide } from "./state.ts";
import { addLinkEffect } from "./surface.ts";

/**
 * Info operation effects (RD-2a's effect column, RD-9).
 *
 * Same contract as the surface ops: pure, no event emission, `applied: false`
 * for RD-1's fizzle path. The resolver runs this phase first (RD-1: INFO
 * before SURFACE).
 */

/** RD-2a: the theme a SPOOF without one falls back to. */
const DEFAULT_CONTACT_KIND: ContactKind = "recon-activity";

/**
 * FOCUSED_ISR_SWEEP (RD-2a): sets the acting side's intel age for the region
 * to 0. The other side's intel is untouched — age is stored per side.
 */
export function focusedIsrSweep(state: GameState, side: Side, regionId: string): OpOutcome {
  if (!state.regions[regionId]) {
    return { applied: false, reason: `Region "${regionId}" is not on the map` };
  }

  const sideState = state.sides[side];
  return {
    applied: true,
    state: withSide(state, side, {
      ...sideState,
      intelAge: { ...sideState.intelAge, [regionId]: OBSERVED_INTEL_AGE },
    }),
    effects: [{ kind: "intelRefreshed", regionId, side }],
    controlChanges: [],
  };
}

/**
 * JAMMING_CORRIDOR (RD-2a, RD-7): a side-owned JAM, added exactly like an
 * INTERDICT — the two differ only in what reads them. JAM never reduces
 * effective capacity; it drives intel masking (RD-9).
 */
export function jammingCorridor(state: GameState, side: Side, linkId: string): OpOutcome {
  return addLinkEffect(state, side, linkId, "JAM");
}

/**
 * SPOOF_CONTACTS (RD-2a, RD-9).
 *
 * The id comes from the caller's `rumor:<SIDE>:<turn>` substream, one
 * `nextU32` draw per contact — a draw count that is part of the frozen replay
 * format. The resolver forks that stream once per side per turn, so repeat
 * plays of the card in one turn (a hand is a permission set) still get
 * distinct ids.
 *
 * The id is deliberately opaque. `ContactView` exposes it verbatim to the
 * *enemy*, while RD-9 forbids disclosing authorship, so an id like the
 * prototype's `BLUE-RUMOR-3-812004` would leak both the creator and the turn
 * straight into the view.
 */
export function spoofContacts(
  state: GameState,
  side: Side,
  regionId: string,
  theme: ContactKind | null,
  rng: Rng,
): OpOutcome {
  if (!state.regions[regionId]) {
    return { applied: false, reason: `Region "${regionId}" is not on the map` };
  }

  const contact: Contact = {
    id: `contact-${rng.nextU32().toString(16).padStart(8, "0")}`,
    side,
    regionId,
    kind: theme ?? DEFAULT_CONTACT_KIND,
    expiresTurn: state.turn + EFFECT_DURATION,
  };

  return {
    applied: true,
    state: withContacts(state, [...state.contacts, contact]),
    effects: [{ kind: "contactCreated", contact }],
    controlChanges: [],
  };
}

/**
 * COUNTERINTEL_SWEEP (RD-2a): removes every *enemy* contact in the region.
 * `Contact.side` is the creator, so a side's own contacts survive its own
 * sweep — and contacts elsewhere are untouched.
 */
export function counterintelSweep(state: GameState, side: Side, regionId: string): OpOutcome {
  if (!state.regions[regionId]) {
    return { applied: false, reason: `Region "${regionId}" is not on the map` };
  }

  const swept = (contact: Contact) => contact.side !== side && contact.regionId === regionId;
  const effects: Effect[] = state.contacts
    .filter(swept)
    .map((contact) => ({ kind: "contactRemoved", contact }));

  return {
    applied: true,
    state: withContacts(
      state,
      state.contacts.filter((contact) => !swept(contact)),
    ),
    effects,
    controlChanges: [],
  };
}
