// Provider terms — the agent owner prices their own signal.
//
// Murmur is a referee, not the seller. Price and cohort size used to be
// deployment-wide settings, which meant the operator set the terms of somebody
// else's product. This panel hands that back.
//
// Two numbers, deliberately distinct:
//
//   your ceiling      how many subscribers YOU are willing to serve (optional)
//   deliverable       how many murmur can actually grant before the market
//                     opens — each grant is its own transaction
//
// We sell the smaller of the two and say so, because taking payment murmur
// cannot deliver means a refund, and refunds are manual today.

import { useCallback, useEffect, useState } from "react";
import { getAccessToken } from "@privy-io/react-auth";

import { verdictApi, type ProviderTermsView } from "../../api.js";
import { Ik } from "../../icons.js";
import { InlineError } from "../compact/InlineError.js";

/** USDC is 6-decimal; atoms are what the contract and receipts speak in. */
const USDC_DECIMALS = 6;

/** Matches the shared input styling used by DestinationAddressForm. */
const INPUT_CLASS =
  "ck-mono bg-transparent border border-[var(--color-border-vis)] px-2 py-1 outline-none focus:border-[var(--color-display)] disabled:opacity-50 disabled:cursor-not-allowed";

function atomsToDisplay(atoms: string | undefined): string {
  if (!atoms) return "";
  try {
    const n = BigInt(atoms);
    const whole = n / 10n ** BigInt(USDC_DECIMALS);
    const frac = (n % 10n ** BigInt(USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, "0");
    return `${whole}.${frac}`.replace(/\.?0+$/, "") || "0";
  } catch {
    return "";
  }
}

function displayToAtoms(display: string): string | null {
  const trimmed = display.trim().replace(/^\$/, "");
  if (!/^\d*(\.\d{0,6})?$/.test(trimmed) || trimmed === "" || trimmed === ".") return null;
  const [whole = "0", frac = ""] = trimmed.split(".");
  const atoms = BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac.padEnd(USDC_DECIMALS, "0"));
  return atoms > 0n ? atoms.toString() : null;
}

export function ProviderTermsPanel({ slug }: { slug: string }) {
  const [terms, setTerms] = useState<ProviderTermsView | null>(null);
  const [price, setPrice] = useState("");
  const [version, setVersion] = useState("");
  const [maxSubs, setMaxSubs] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const token = await getAccessToken();
      if (!token) {
        setError("session expired. sign in again to load your terms.");
        return;
      }
      const view = await verdictApi.getProviderTerms(token, slug);
      setTerms(view);
      setPrice(atomsToDisplay(view.price_atoms));
      setVersion(view.pricing_version ?? "");
      setMaxSubs(
        view.max_subscribers_per_call == null ? "" : String(view.max_subscribers_per_call),
      );
    } catch (e) {
      setError((e as Error)?.message ?? "unknown error");
    }
  }, [slug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(async () => {
    setError(null);
    setSaved(null);
    const atoms = displayToAtoms(price);
    if (!atoms) {
      setError("Enter a price above zero, with 6 decimal places at most.");
      return;
    }
    if (!version.trim()) {
      setError("Enter a pricing version. It records which terms each subscriber agreed to.");
      return;
    }
    const parsedMax = maxSubs.trim() === "" ? null : Number(maxSubs);
    if (parsedMax !== null && (!Number.isInteger(parsedMax) || parsedMax <= 0)) {
      setError("Enter a whole number above zero, or leave it blank for no limit.");
      return;
    }
    setBusy(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("You are not signed in.");
      const view = await verdictApi.putProviderTerms(token, slug, {
        price_atoms: atoms,
        currency: "USDC",
        pricing_version: version.trim(),
        max_subscribers_per_call: parsedMax,
      });
      setTerms(view);
      setSaved("Saved. This applies to calls you seal from now on.");
    } catch (e) {
      setError((e as Error)?.message ?? "unknown error");
    } finally {
      setBusy(false);
    }
  }, [price, version, maxSubs, slug]);

  const stopSelling = useCallback(async () => {
    setError(null);
    setSaved(null);
    setBusy(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("You are not signed in.");
      const view = await verdictApi.deleteProviderTerms(token, slug);
      setTerms(view);
      setPrice("");
      setVersion("");
      setMaxSubs("");
      setSaved("You are no longer selling access on new calls.");
    } catch (e) {
      setError((e as Error)?.message ?? "unknown error");
    } finally {
      setBusy(false);
    }
  }, [slug]);

  return (
    <section className="ck-frame w-full max-w-[560px] flex flex-col">
      <div className="ck-header">
        <span className="ck-title ck-title-ik">
          <Ik name="x402" /> early access pricing
        </span>
        <span className="ck-mono ck-dim">
          {terms?.selling ? "selling" : "not selling"}
        </span>
      </div>

      <div className="px-4 py-4 flex flex-col gap-4">
        <p className="ck-dim text-[12px]">
          This is what a subscriber pays to read your call before it becomes
          public. You set the price. Murmur only referees. A change applies to
          calls you seal from now on. Calls already sold keep their old terms.
        </p>

        <label className="flex flex-col gap-1">
          <span className="ck-label ck-pos">price per call · USDC</span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.05"
            value={price}
            onChange={(e) => setPrice(e.currentTarget.value)}
            disabled={busy}
            className={INPUT_CLASS}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="ck-label ck-pos">pricing version</span>
          <input
            type="text"
            placeholder="v1"
            value={version}
            onChange={(e) => setVersion(e.currentTarget.value)}
            disabled={busy}
            className={INPUT_CLASS}
          />
          <span className="ck-dim text-[12px]">
            Raise this whenever you change the price. It records which terms
            each subscriber agreed to, so old receipts still add up.
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="ck-label ck-pos">subscriber limit per call</span>
          <input
            type="text"
            inputMode="numeric"
            placeholder="no limit"
            value={maxSubs}
            onChange={(e) => setMaxSubs(e.currentTarget.value)}
            disabled={busy}
            className={INPUT_CLASS}
          />
          {terms?.deliverable_max_subscribers_per_call != null && (
            <span className="ck-dim text-[12px]">
              This deployment can serve{" "}
              {terms.deliverable_max_subscribers_per_call} subscribers per call
              before the market opens. Each one is its own transaction. Leave
              this blank to serve that many.
            </span>
          )}
          {terms?.clamped_by_deliverability && terms.notice && (
            // Said plainly rather than silently selling fewer than asked for.
            <span className="ck-neg text-[12px]">{terms.notice}</span>
          )}
          {terms?.selling && !terms.clamped_by_deliverability && (
            <span className="ck-pos text-[12px]">
              You are selling up to{" "}
              {terms.effective_max_subscribers_per_call ?? "—"} per call.
            </span>
          )}
        </label>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="ck-btn ck-btn-bracket ck-pos justify-center disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {terms?.selling ? "update terms" : "start selling"}
          </button>
          {terms?.selling && (
            <button
              type="button"
              onClick={() => void stopSelling()}
              disabled={busy}
              className="ck-btn ck-btn-bracket justify-center disabled:opacity-40 disabled:cursor-not-allowed"
            >
              stop selling
            </button>
          )}
        </div>

        {saved && <span className="ck-pos text-[12px]">{saved}</span>}
        {error && <InlineError error={error} className="text-[12px]" />}
      </div>
    </section>
  );
}
