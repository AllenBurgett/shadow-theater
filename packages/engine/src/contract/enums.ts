import { z } from "zod";

/**
 * Closed vocabularies shared by every contract schema.
 *
 * `z.enum` (never TypeScript `enum` — the engine bans it: `erasableSyntaxOnly`
 * plus research R1/R2) so each vocabulary has exactly one definition that is
 * simultaneously a runtime validator, a TS union, and a JSON-Schema source for
 * the LLM boundary (R6).
 */

export const SideSchema = z.enum(["BLUE", "RED"]);
export type Side = z.infer<typeof SideSchema>;

export const ControlSchema = z.enum(["BLUE", "RED", "CONTESTED", "NEUTRAL"]);
export type Control = z.infer<typeof ControlSchema>;

/** Ordered assignment per RD-12. */
export const SupplyStateSchema = z.enum(["IN_SUPPLY", "THIN", "CUT", "NONE"]);
export type SupplyState = z.infer<typeof SupplyStateSchema>;

export const RegionTypeSchema = z.enum(["PORT", "HABITAT", "COMMS", "INDUSTRY", "WILDS", "POWER"]);
export type RegionType = z.infer<typeof RegionTypeSchema>;

/** The nine-card catalogue of plan RD-2a. */
export const CardIdSchema = z.enum([
  "DELIBERATE_ADVANCE",
  "RAPID_REDEPLOY",
  "FORTIFY_REGION",
  "INTERDICT_LINK",
  "SECURE_CORRIDOR",
  "FOCUSED_ISR_SWEEP",
  "JAMMING_CORRIDOR",
  "SPOOF_CONTACTS",
  "COUNTERINTEL_SWEEP",
]);
export type CardId = z.infer<typeof CardIdSchema>;

export const TargetKindSchema = z.enum(["REGION", "LINK"]);
export type TargetKind = z.infer<typeof TargetKindSchema>;

/** Drives RD-1 phase order: INFO ops resolve before SURFACE ops. */
export const CardDomainSchema = z.enum(["SURFACE", "INFO"]);
export type CardDomain = z.infer<typeof CardDomainSchema>;

export const ContactKindSchema = z.enum(["supply-buildup", "armour-massing", "recon-activity"]);
export type ContactKind = z.infer<typeof ContactKindSchema>;

export const LinkEffectKindSchema = z.enum(["JAM", "INTERDICT"]);
export type LinkEffectKind = z.infer<typeof LinkEffectKindSchema>;

/** Whole-set order validation codes (RD-2). */
export const ViolationCodeSchema = z.enum([
  "CARD_NOT_IN_HAND",
  "UNKNOWN_CARD",
  "TARGET_KIND_MISMATCH",
  "TARGET_ILLEGAL",
  "CP_EXCEEDED",
  "ISR_EXCEEDED",
  "TURN_MISMATCH",
  "THEME_NOT_APPLICABLE",
]);
export type ViolationCode = z.infer<typeof ViolationCodeSchema>;

/** Coarse political-capital disclosure band (RD-4). */
export const PostureBandSchema = z.enum(["STABLE", "STRAINED", "CRITICAL"]);
export type PostureBand = z.infer<typeof PostureBandSchema>;

export const GameOverReasonSchema = z.enum(["WIPEOUT", "COLLAPSE", "POINTS", "TURN_LIMIT"]);
export type GameOverReason = z.infer<typeof GameOverReasonSchema>;

export const WinnerSchema = z.enum(["BLUE", "RED", "DRAW"]);
export type Winner = z.infer<typeof WinnerSchema>;

/** Canonical record of the live LLM outcome (FR-014 / IB-003). */
export const RedOrdersSourceSchema = z.enum(["NATIVE", "REPAIRED", "FALLBACK"]);
export type RedOrdersSource = z.infer<typeof RedOrdersSourceSchema>;

export const IntelConfidenceSchema = z.enum(["CONFIRMED", "LIKELY", "UNKNOWN"]);
export type IntelConfidence = z.infer<typeof IntelConfidenceSchema>;

export const ObjectiveVisibilitySchema = z.enum(["public", "secret"]);
export type ObjectiveVisibility = z.infer<typeof ObjectiveVisibilitySchema>;
