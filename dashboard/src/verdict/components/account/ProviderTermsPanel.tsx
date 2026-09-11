// Early access pricing — one price per market, set by the agent's owner.
//
// Murmur is a referee, not the seller. An owner LISTS their service on a
// market at a price. A price used to be one number per
// agent; it is now one per venue series, and a registration is its
// precondition — an owner opts into serving a market, then prices it.
// Dropping the registration cascades that market's price away with it.
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

import { verdictApi, type MarketRegistrationRow } from "../../api.js";
import { Ik, IkBrand } from "../../icons.js";
import { InlineError } from "../compact/InlineError.js";

/** What a half-typed price may look like: digits, one dot, <=6 decimals. */
const PRICE_DRAFT = /^\d*(\.\d{0,6})?$/;

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

/**
 * One message at a time, aimed at whatever produced it: `series` names the row
 * it belongs under, or null for a panel-level failure (the initial load).
 */
interface Note {
  series: string | null;
  text: string;
  bad: boolean;
}

/**
 * The three values a listing carries. They travel together because they are
 * saved together: version and ceiling used to be one pair for the whole panel,
 * so saving a price on ETH wrote BTC's version and cap over ETH's stored ones.
 */
interface TermsDraft {
  price: string;
  version: string;
  maxSubs: string;
}

const EMPTY_DRAFT: TermsDraft = { price: "", version: "", maxSubs: "" };

/** A row's draft is seeded from that row's OWN stored terms, never a sibling's. */
function draftFromTerms(terms: MarketRegistrationRow["terms"]): TermsDraft {
  return {
    price: atomsToDisplay(terms?.price_atoms),
    version: terms?.pricing_version ?? "",
    maxSubs:
      terms?.max_subscribers_per_call == null
        ? ""
        : String(terms.max_subscribers_per_call),
  };
}

export function ProviderTermsPanel({ slug }: { slug: string }) {
  const [rows, setRows] = useState<MarketRegistrationRow[] | null>(null);
  /**
   * One draft per series, keyed by venue_series_id, holding price, pricing
   * version and subscriber cap together. This is the whole isolation
   * guarantee: editing BTC writes one key and leaves every other row's draft
   * byte-identical. Writes patch only the row they touched rather than
   * re-reading the list, so a save can never reseed a draft mid-edit.
   */
  const [drafts, setDrafts] = useState<Record<string, TermsDraft>>({});
  /** Deployment-wide, so one series' read carries it for every row. */
  const [deliverable, setDeliverable] = useState<number | null>(null);
  /** The series currently being written, or null when idle. */
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);

  const refresh = useCallback(async () => {
    setNote(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setNote({ series: null, text: "session expired. sign in again.", bad: true });
        return;
      }
      const view = await verdictApi.getMarketRegistrations(token, slug);
      setRows(view.series);
      const seeded: Record<string, TermsDraft> = {};
      for (const row of view.series) {
        seeded[row.venue_series_id] = draftFromTerms(row.terms);
      }
      setDrafts(seeded);
      const probe = view.series[0]?.venue_series_id;
      if (probe) {
        const terms = await verdictApi.getProviderTerms(token, slug, probe);
        setDeliverable(terms.deliverable_max_subscribers_per_call);
      }
    } catch (e) {
      setNote({ series: null, text: (e as Error)?.message ?? "unknown error", bad: true });
    }
  }, [slug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Replace one row in place. Every other row — and every draft — is untouched. */
  const patchRow = useCallback(
    (series: string, patch: Partial<MarketRegistrationRow>) => {
      setRows((prev) =>
        prev
          ? prev.map((row) =>
              row.venue_series_id === series ? { ...row, ...patch } : row,
            )
          : prev,
      );
    },
    [],
  );

  /** Edit one field of one row's draft. Other rows are never read or written. */
  const patchDraft = useCallback(
    (series: string, patch: Partial<TermsDraft>) => {
      setDrafts((prev) => ({
        ...prev,
        [series]: { ...EMPTY_DRAFT, ...prev[series], ...patch },
      }));
    },
    [],
  );

  const list = useCallback(
    async (series: string) => {
      setNote(null);
      // Only this row's draft is read, so its stored version and cap survive a
      // save on any other row.
      const draft = drafts[series] ?? EMPTY_DRAFT;
      const atoms = displayToAtoms(draft.price);
      if (!atoms) {
        setNote({
          series,
          text: "Enter a price above zero, with 6 decimal places at most.",
          bad: true,
        });
        return;
      }
      // Blocking the save on an empty version stranded the owner. It is
      // bookkeeping, so default it per row and let the sale through.
      const effectiveVersion = draft.version.trim() || "v1";
      const parsedMax = draft.maxSubs.trim() === "" ? null : Number(draft.maxSubs);
      if (parsedMax !== null && (!Number.isInteger(parsedMax) || parsedMax <= 0)) {
        setNote({
          series,
          text: "Enter a whole number above zero, or leave it blank for no limit.",
          bad: true,
        });
        return;
      }
      setBusy(series);
      try {
        const token = await getAccessToken();
        if (!token) throw new Error("You are not signed in.");
        const view = await verdictApi.putProviderTerms(token, slug, series, {
          price_atoms: atoms,
          currency: "USDC",
          pricing_version: effectiveVersion,
          max_subscribers_per_call: parsedMax,
        });
        setDeliverable(view.deliverable_max_subscribers_per_call);
        // Patched from the response, not from the draft: the daemon is the
        // authority on what it stored.
        const stored = {
          price_atoms: view.price_atoms ?? atoms,
          currency: view.currency ?? "USDC",
          pricing_version: view.pricing_version ?? effectiveVersion,
          max_subscribers_per_call: view.max_subscribers_per_call ?? null,
        };
        patchRow(series, { registered: true, terms: stored });
        setDrafts((prev) => ({ ...prev, [series]: draftFromTerms(stored) }));
        setNote(
          view.clamped_by_deliverability && view.notice
            ? // Said plainly rather than silently selling fewer than asked for.
              { series, text: view.notice, bad: true }
            : {
                series,
                text:
                  view.effective_max_subscribers_per_call == null
                    ? "saved · applies to calls sealed from now on"
                    : `saved · up to ${view.effective_max_subscribers_per_call} subscribers per call`,
                bad: false,
              },
        );
      } catch (e) {
        setNote({ series, text: (e as Error)?.message ?? "unknown error", bad: true });
      } finally {
        setBusy(null);
      }
    },
    [drafts, slug, patchRow],
  );

  /** Clear the price, keep the registration — the market stays available to price again. */
  const unlist = useCallback(
    async (series: string) => {
      setNote(null);
      setBusy(series);
      try {
        const token = await getAccessToken();
        if (!token) throw new Error("You are not signed in.");
        const view = await verdictApi.deleteProviderTerms(token, slug, series);
        setDeliverable(view.deliverable_max_subscribers_per_call);
        patchRow(series, { terms: null });
        // Clear the price only. Version and cap are the owner's bookkeeping for
        // this market, so re-listing keeps their numbering instead of resetting.
        patchDraft(series, { price: "" });
      } catch (e) {
        setNote({ series, text: (e as Error)?.message ?? "unknown error", bad: true });
      } finally {
        setBusy(null);
      }
    },
    [slug, patchRow, patchDraft],
  );

  const register = useCallback(
    async (series: string) => {
      setNote(null);
      setBusy(series);
      try {
        const token = await getAccessToken();
        if (!token) throw new Error("You are not signed in.");
        await verdictApi.postMarketRegistration(token, slug, series);
        patchRow(series, { registered: true, terms: null });
        setDrafts((prev) => ({ ...prev, [series]: EMPTY_DRAFT }));
      } catch (e) {
        setNote({ series, text: (e as Error)?.message ?? "unknown error", bad: true });
      } finally {
        setBusy(null);
      }
    },
    [slug, patchRow],
  );

  const loadFailed = rows === null && note !== null && note.series === null;
  const listed = rows?.filter((row) => row.terms).length ?? 0;

  return (
    <section className="ck-frame w-full flex flex-col">
      <div className="ck-header">
        <span className="ck-title ck-title-ik">
          <Ik name="x402" /> early access pricing
        </span>
        <span className="ck-mono ck-dim">
          {rows ? `${listed} of ${rows.length} listed` : "…"}
        </span>
      </div>

      {rows === null ? (
        loadFailed ? null : <p className="ck-mono ck-dim px-4 py-4">loading…</p>
      ) : rows.length === 0 ? (
        <p className="ck-mono ck-dim px-4 py-4">No markets to price yet.</p>
      ) : (
        <ul>
          {rows.map((row) => {
            const series = row.venue_series_id;
            const rowBusy = busy === series;
            const draft = drafts[series] ?? EMPTY_DRAFT;
            return (
              <li
                key={series}
                className="border-t border-[var(--color-border)] first:border-t-0"
              >
                <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] sm:grid-cols-[minmax(0,1fr)_100px_80px_auto] items-center gap-x-3 gap-y-2 px-4 py-3">
                  <div className="col-span-3 sm:col-span-1 min-w-0">
                    <span
                      className="ck-mono ck-value ck-pos block truncate"
                      title={
                        row.venue_category
                          ? `${row.series_title} · ${row.venue_category}`
                          : row.series_title
                      }
                    >
                      {row.series_title}
                    </span>
                    <span className="ck-dim text-[12px] block truncate">
                      {row.series_slug}
                    </span>
                  </div>

                  {row.registered ? (
                    /* The denomination rides ON the field. A bare number left
                       the owner guessing what unit they were typing. */
                    <span
                      className={`${INPUT_CLASS} w-full min-w-0 flex items-center gap-1.5`}
                    >
                      <IkBrand name="usdc" size={16} />
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="0.00"
                        aria-label={`price per call in USDC · ${row.series_title}`}
                        title="What a subscriber pays, in USDC, to read this market's calls before they are public."
                        value={draft.price}
                        onChange={(e) => {
                          // Refuse the keystroke rather than validating on save:
                          // a field that accepts letters and then rejects them
                          // teaches the wrong thing about what it holds.
                          const next = e.currentTarget.value;
                          if (!PRICE_DRAFT.test(next)) return;
                          patchDraft(series, { price: next });
                        }}
                        disabled={rowBusy}
                        className="ck-mono bg-transparent border-0 outline-none w-full min-w-0 p-0 disabled:opacity-50"
                      />
                    </span>
                  ) : (
                    <span className="ck-dim text-[12px]">not registered</span>
                  )}

                  <span
                    className={row.terms ? "ck-tag ck-tag-ok" : "ck-tag"}
                    title={
                      row.terms
                        ? `version ${row.terms.pricing_version} · ceiling ${
                            row.terms.max_subscribers_per_call ?? "none"
                          }`
                        : row.registered
                          ? "serving this market, not listed for early access"
                          : undefined
                    }
                    aria-hidden={row.registered ? undefined : true}
                  >
                    {row.terms ? "listed" : row.registered ? "registered" : "·"}
                  </span>

                  {/* A listed row keeps its own save. Without it the edited
                      price had nowhere to go but unlist, which cleared it. */}
                  <span className="justify-self-end flex items-center gap-2">
                    {row.terms && (
                      <button
                        type="button"
                        onClick={() => void list(series)}
                        disabled={busy !== null}
                        title="save this market's price, version and ceiling"
                        className="ck-btn ck-btn-bracket ck-pos disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        save
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        void (row.terms
                          ? unlist(series)
                          : row.registered
                            ? list(series)
                            : register(series))
                      }
                      disabled={busy !== null}
                      title={
                        row.terms
                          ? "take this market off the list; the registration stays"
                          : row.registered
                            ? "list your early access on this market at this price"
                            : "serve this market, so it can be priced"
                      }
                      className="ck-btn ck-btn-bracket disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {row.terms ? "unlist" : row.registered ? "list" : "register"}
                    </button>
                  </span>
                </div>

                {/* Version and ceiling belong to THIS market. Held panel-wide,
                    they rode along on whichever row you saved and overwrote the
                    terms of every other one. */}
                {row.registered && (
                  <div className="px-4 pb-3 flex flex-wrap items-center gap-x-5 gap-y-2">
                    <label className="flex items-center gap-2">
                      <span className="ck-label ck-pos">version</span>
                      <input
                        type="text"
                        placeholder="v1"
                        aria-label={`pricing version · ${row.series_title}`}
                        title="Raise it whenever you change this market's price. It stamps which terms each subscriber agreed to, so old receipts still add up."
                        value={draft.version}
                        onChange={(e) =>
                          patchDraft(series, { version: e.currentTarget.value })
                        }
                        disabled={rowBusy}
                        className={`${INPUT_CLASS} w-[90px]`}
                      />
                    </label>

                    <label className="flex items-center gap-2">
                      <span className="ck-label ck-pos">your ceiling</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        placeholder="no limit"
                        aria-label={`subscriber limit per call · ${row.series_title}`}
                        title="Your own ceiling on how many subscribers to serve per call on this market. Blank serves as many as this deployment can grant before the market opens; each grant is its own transaction."
                        value={draft.maxSubs}
                        onChange={(e) => {
                          // Whole subscribers only — same keystroke rule as the price.
                          const next = e.currentTarget.value;
                          if (!/^\d*$/.test(next)) return;
                          patchDraft(series, { maxSubs: next });
                        }}
                        disabled={rowBusy}
                        className={`${INPUT_CLASS} w-[110px]`}
                      />
                    </label>
                  </div>
                )}

                {note !== null && note.series === series && (
                  <div className="px-4 pb-3">
                    {note.bad ? (
                      <InlineError error={note.text} className="text-[12px]" />
                    ) : (
                      <span className="ck-pos text-[12px]">{note.text}</span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Deployment-wide, so it is stated once rather than under every row. */}
      {deliverable != null && (
        <div className="border-t border-[var(--color-border)] px-4 py-3">
          <span className="ck-dim text-[12px]">
            this deployment can grant {deliverable} subscribers per call
          </span>
        </div>
      )}

      {note !== null && note.series === null && (
        <div className="px-4 pb-4">
          {note.bad ? (
            <InlineError error={note.text} className="text-[12px]" />
          ) : (
            <span className="ck-pos text-[12px]">{note.text}</span>
          )}
        </div>
      )}
    </section>
  );
}
