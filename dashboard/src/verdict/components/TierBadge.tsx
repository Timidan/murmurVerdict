// ─── TierBadge — agent-kind indicator ──────────────────────────────────────
//
// Renders the agent kind as a monochrome glyph (bot head / ruler / shield /
// flask) with a tooltip carrying the name, instead of a text badge — see
// components/compact/glyphs.tsx (KindGlyph). Used on AccountPage agent rows and
// the AgentSettingsPage header.

import type { AgentKind } from "../api.js";
import { KindGlyph } from "./compact/glyphs.js";

export interface TierBadgeProps {
  /** Defaults to `agent` when null — the canonical Privy-owned default for
   *  the onboarding flow where `kind` may be null mid-bootstrap. */
  kind: AgentKind | string | null | undefined;
}

export function TierBadge({ kind }: TierBadgeProps) {
  return <KindGlyph kind={kind} size={16} />;
}
