// ─── TierBadge — agent-kind indicator ──────────────────────────────────────

import type { AgentKind } from "../api.js";
import { KindGlyph } from "./compact/glyphs.js";

export interface TierBadgeProps {
  /** Null renders as `agent` (kind can be null mid-onboarding). */
  kind: AgentKind | string | null | undefined;
}

export function TierBadge({ kind }: TierBadgeProps) {
  return <KindGlyph kind={kind} size={16} />;
}
