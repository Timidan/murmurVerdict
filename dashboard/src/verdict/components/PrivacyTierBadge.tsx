// ─── PrivacyTierBadge — privacy-mode indicator ─────────────────────────────

import { SealGlyph } from "./compact/glyphs.js";

export interface PrivacyTierBadgeProps {
  /** From `submissions.privacy_mode`; renders nothing when null. */
  mode: string | null | undefined;
}

export function PrivacyTierBadge({ mode }: PrivacyTierBadgeProps) {
  return <SealGlyph mode={mode} size={16} />;
}
