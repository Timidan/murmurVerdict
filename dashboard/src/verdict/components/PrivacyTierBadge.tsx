// ─── PrivacyTierBadge — one-line privacy-mode chip ─────────────────────────

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
  sealed_fhenix: { label: "fhenix sealed", cls: "ck-pos" },
};

export function PrivacyTierBadge({ mode }: PrivacyTierBadgeProps) {
  if (mode === null || mode === undefined || mode === "") return null;
  const style = PRIVACY_STYLES[mode] ?? {
    label: mode,
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
