// ─── PrivacyTierBadge — privacy-mode indicator ─────────────────────────────
//
// Renders the call's privacy mode as a monochrome seal/padlock glyph with a
// tooltip carrying the name (e.g. "fhenix sealed"), instead of a text chip —
// see components/compact/glyphs.tsx (SealGlyph). Returns null when the row
// predates the privacy_mode column.

import { SealGlyph } from "./compact/glyphs.js";

export interface PrivacyTierBadgeProps {
  /** From `submissions.privacy_mode`. Null/undefined when the row predates
   *  the privacy_mode column — render nothing in that case. */
  mode: string | null | undefined;
}

export function PrivacyTierBadge({ mode }: PrivacyTierBadgeProps) {
  return <SealGlyph mode={mode} size={14} />;
}
