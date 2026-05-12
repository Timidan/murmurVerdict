// ─── PrivacyTierBadge — one-line privacy-mode chip (Z4) ────────────────────
//
// Mirrors TierBadge's visual rhythm. Maps `submissions.privacy_mode` to one
// of three labels per docs/operator-blind-privacy-plan.md §4 Z4:
//
//   legacy_plaintext → PLAINTEXT       (ck-dim)
//   committed        → SEALED          (ck-pos) — age-encrypted body, daemon
//                                                  decrypts at reveal time
//   fhe_direct       → OPERATOR-BLIND  (ck-neg) — encrypted under threshold
//                                                  keys; no party can decrypt
//                                                  the prediction alone
//
// The chip is deliberately decorative: it does NOT vary the data shown on
// the call/agent page (that's a function of which columns are populated).
// Its job is to tell the reader at a glance which trust posture this call
// was minted under.
//
// Unknown values surface as the literal mode in uppercase so a future
// privacy_mode value doesn't render as a blank.

export interface PrivacyTierBadgeProps {
  /** From `submissions.privacy_mode`. Null/undefined when the row predates
   *  the privacy_mode column — render nothing in that case (caller branches). */
  mode: string | null | undefined;
}

interface PrivacyStyle {
  label: string;
  cls: string;
}

const PRIVACY_STYLES: Record<string, PrivacyStyle> = {
  legacy_plaintext: { label: "PLAINTEXT", cls: "ck-dim" },
  committed: { label: "SEALED", cls: "ck-pos" },
  fhe_direct: { label: "OPERATOR-BLIND", cls: "ck-neg" },
};

export function PrivacyTierBadge({ mode }: PrivacyTierBadgeProps) {
  if (mode === null || mode === undefined || mode === "") return null;
  const style = PRIVACY_STYLES[mode] ?? {
    label: mode.toUpperCase(),
    cls: "ck-dim",
  };
  return (
    <span
      className={
        "ck-label inline-flex items-center px-[6px] py-[1px] border " +
        "border-[var(--color-border-vis)] " +
        style.cls
      }
    >
      [ {style.label} ]
    </span>
  );
}
