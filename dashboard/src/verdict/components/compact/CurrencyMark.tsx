import { IkBrand } from "../../icons.js";

/**
 * The asset a number is denominated in.
 *
 * USDC gets Circle's real mark rather than four letters — the same rule the
 * linked-logins panel follows for Google. Any other settlement asset keeps its
 * code, because a logo we do not have is worse than the word.
 *
 * The mark is decorative; the code stays in the accessible name, so a screen
 * reader still hears "0.27 USDC" and a pointer still gets the tooltip.
 */
export function CurrencyMark({
  currency,
  className,
}: {
  currency: string;
  /** Applied to whichever branch renders, so one caller class covers both. */
  className?: string;
}) {
  const code = currency.toUpperCase();
  if (code !== "USDC") return <span className={className}>{code}</span>;
  return (
    <span className={"inline-flex align-[-3px] " + (className ?? "")} title="USDC">
      <IkBrand name="usdc" size={16} />
      <span className="sr-only">USDC</span>
    </span>
  );
}
