import { useEffect, useState } from "react";

/**
 * The venue's market artwork at a fixed 16px, falling back to a letter glyph
 * when there is no url or it fails to load. Decorative: the asset name always
 * sits beside it. no-referrer because these are third-party objects.
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
