import { useEffect, useState } from "react";

/**
 * The venue's own market artwork, at 16px, with a fallback that cannot fail.
 *
 * DECORATIVE BY CONTRACT. Every place this renders, the asset's name is the
 * text immediately beside it, so the image carries no information of its own:
 * `alt=""` + `aria-hidden` keeps it out of the accessible name instead of
 * making a screen reader read "BTC BTC".
 *
 * Three failure modes, all handled without layout shift, because the box is a
 * fixed 16×16 in every branch:
 *
 *   · no `icon_url` at all — every market registered before the field existed,
 *     and it is deliberately never backfilled. Renders the glyph directly, no
 *     network request attempted.
 *   · the URL 404s or the host is down — `onError` swaps to the glyph.
 *   · the URL changes between renders — the failed flag resets, so a market
 *     that gains working artwork is not stuck on the fallback.
 *
 * `referrerPolicy="no-referrer"` because these are third-party S3 objects: the
 * venue has no business learning which murmur page a reader is on.
 */
export function MarketAssetIcon({
  iconUrl,
  symbol,
  className,
}: {
  iconUrl?: string | null;
  /** Asset symbol ("BTC"); its first letter is the fallback glyph. */
  symbol?: string | null;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [iconUrl]);

  const box = "flex-none w-4 h-4 " + (className ?? "");

  if (!iconUrl || failed) {
    return (
      <span
        aria-hidden="true"
        className={
          box +
          " inline-flex items-center justify-center border border-[var(--color-border-vis)] " +
          "text-[12px] leading-none font-bold"
        }
      >
        {(symbol ?? "?").trim().charAt(0).toUpperCase() || "?"}
      </span>
    );
  }

  return (
    <img
      src={iconUrl}
      width={16}
      height={16}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      alt=""
      aria-hidden="true"
      onError={() => setFailed(true)}
      className={box + " object-contain"}
    />
  );
}
