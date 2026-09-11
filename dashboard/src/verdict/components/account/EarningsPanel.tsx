// Earnings — what your calls sold for, what murmur has paid you, and the
// difference.
//
// Three layers, in the order an owner asks the question:
//
//   1. the money strip     per currency: accrued, paid, and what is left
//   2. the sales           one row per early-access sale
//   3. the payout journal  one row per transfer murmur recorded
//
// The balance is SIGNED end to end. When murmur has overpaid, this panel says
// "overpaid" and shows the number — the alternative is a page that reads
// "settled" while an operator error sits underneath it.

import { useCallback, useEffect, useState } from "react";
import { getAccessToken } from "@privy-io/react-auth";

import {
  verdictApi,
  type ProviderEarningsTotal,
  type ProviderEarningsView,
  type ProviderPayoutsView,
} from "../../api.js";
import { Ik } from "../../icons.js";
import { formatAtoms, isPositiveAtoms } from "../../lib/atoms-format.js";
import { formatLocalDateTime } from "../../lib/date-time-format.js";
import { shortId } from "../../lib/display-format.js";
import { InlineError } from "../compact/InlineError.js";

export function EarningsPanel({ slug }: { slug: string }) {
  const [earnings, setEarnings] = useState<ProviderEarningsView | null>(null);
  const [payouts, setPayouts] = useState<ProviderPayoutsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setError("Your session expired. Sign in again.");
        return;
      }
      // Both reads are ownership-gated the same way, so failing either one
      // means the whole page is wrong. Load them together.
      const [e, p] = await Promise.all([
        verdictApi.getAgentEarnings(token, slug),
        verdictApi.getAgentPayouts(token, slug),
      ]);
      setEarnings(e);
      setPayouts(p);
    } catch (e) {
      setError((e as Error)?.message ?? "unknown error");
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const totals = earnings?.totals ?? [];
  // The lifetime count, not `sales.length` — that page holds one page of rows.
  const lifetimeSales = totals.reduce((sum, t) => sum + t.sales, 0);

  return (
    <section className="ck-frame w-full flex flex-col">
      <div className="ck-header">
        <span className="ck-title ck-title-ik">
          <Ik name="x402" /> earnings
        </span>
        <span className="ck-mono ck-dim">
          {earnings ? `${lifetimeSales} sales` : "…"}
        </span>
      </div>

      <div className="px-4 py-4 flex flex-col gap-4">
        <p className="ck-dim text-[12px]">
          A subscriber pays to read your call before it becomes public. Murmur
          keeps a fee and records the rest as yours. An operator sends your
          share by hand and writes it down below.
        </p>

        {error && <InlineError error={error} className="text-[12px]" />}

        {loading && !earnings ? (
          <SkeletonStrip />
        ) : !earnings ? (
          // The request failed. An unloaded panel cannot claim there are no
          // sales — the error above says what happened.
          <p className="ck-mono ck-dim">[sales unavailable]</p>
        ) : totals.length === 0 ? (
          <p className="ck-mono ck-dim">No sales yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {totals.map((total) => (
              <MoneyStrip key={total.currency} total={total} />
            ))}
          </div>
        )}

        {earnings && earnings.sales.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="ck-label ck-pos">sales</h3>
            <ul className="divide-y divide-[var(--color-border)] border border-[var(--color-border)]">
              {earnings.sales.map((sale) => (
                <li
                  key={sale.entitlement_id}
                  className="grid grid-cols-[1fr_auto] items-baseline gap-3 px-3 py-2"
                >
                  <span className="min-w-0">
                    {/* The on-chain id, not a link: the call page keys on
                        murmur's internal id, which this row does not carry. */}
                    <span className="ck-mono" title={sale.onchain_call_id}>
                      {shortId(sale.onchain_call_id)}
                    </span>
                    <span
                      className="ck-dim text-[12px] ml-2"
                      title={formatLocalDateTime(sale.accrued_at) ?? sale.accrued_at}
                    >
                      {sale.accrued_at.slice(0, 10)}
                    </span>
                  </span>
                  <span className="text-right">
                    {/* Green reads as money in, the same green a winning call
                        carries in your call history. */}
                    <span className="ck-mono ck-pos">
                      +{formatAtoms(sale.net_atoms, sale.currency)}
                    </span>{" "}
                    <span className="ck-dim text-[12px]">{sale.currency}</span>
                    <span
                      className="ck-dim text-[12px] block"
                      title={`murmur kept ${formatAtoms(sale.fee_atoms, sale.currency)} ${sale.currency} of ${formatAtoms(sale.gross_atoms, sale.currency)} ${sale.currency}`}
                    >
                      paid {formatAtoms(sale.gross_atoms, sale.currency)} · fee{" "}
                      {formatAtoms(sale.fee_atoms, sale.currency)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <PayoutJournal payouts={payouts} loading={loading} />
      </div>
    </section>
  );
}

/**
 * One currency, both sides of the ledger, and the leftover said out loud.
 *
 * `owed` and `overpaid` are the two halves of one signed balance: exactly one
 * of them is ever non-zero, and the label changes with the sign so the number
 * can never be read the wrong way round.
 */
function MoneyStrip({ total }: { total: ProviderEarningsTotal }) {
  const overpaid = isPositiveAtoms(total.overpaid_atoms);
  return (
    <div className="border border-[var(--color-border-vis)] px-3 py-2 flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="ck-label ck-pos">{total.currency}</span>
        <span className="ck-dim text-[12px]">
          {total.sales} {total.sales === 1 ? "sale" : "sales"} ·{" "}
          {total.payout_entries}{" "}
          {total.payout_entries === 1 ? "payout entry" : "payout entries"}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Figure
          label="accrued"
          value={formatAtoms(total.lifetime_accrued_net, total.currency)}
          tone="pos"
          title="What your sales earned you, after murmur's fee."
        />
        <Figure
          label="paid"
          value={formatAtoms(total.lifetime_paid_net, total.currency)}
          tone="plain"
          title={
            isPositiveAtoms(total.lifetime_paid_reversed)
              ? `Payouts of ${formatAtoms(total.lifetime_paid_gross, total.currency)} less reversals of ${formatAtoms(total.lifetime_paid_reversed, total.currency)}.`
              : "What murmur has recorded as sent to you."
          }
        />
        <Figure
          label={overpaid ? "overpaid" : "owed"}
          value={formatAtoms(
            overpaid ? total.overpaid_atoms : total.owed_atoms,
            total.currency,
          )}
          tone={overpaid ? "neg" : "pos"}
          title={
            overpaid
              ? "Murmur sent you more than you earned. The operator will correct this with a reversal."
              : "Accrued, less what murmur has recorded as paid."
          }
        />
      </div>
      {overpaid && (
        <p className="ck-neg text-[12px]">
          Murmur paid you more than you earned. The operator corrects this with
          a reversal entry.
        </p>
      )}
    </div>
  );
}

function Figure({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone: "pos" | "neg" | "plain";
  title: string;
}) {
  const toneClass = tone === "pos" ? "ck-pos" : tone === "neg" ? "ck-neg" : "";
  return (
    <span className="flex flex-col" title={title}>
      <span className="ck-label ck-dim">{label}</span>
      <span className={`ck-mono ${toneClass}`}>{value}</span>
    </span>
  );
}

/**
 * The payout journal, underneath the sales it settles.
 *
 * A reversal renders with a minus sign and in the negative colour. The wire
 * amount is positive in both directions — the direction lives in `entry_type`
 * — so the sign here is presentation, applied once, in one place.
 */
function PayoutJournal({
  payouts,
  loading,
}: {
  payouts: ProviderPayoutsView | null;
  loading: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="ck-label ck-pos">payouts</h3>
      {!payouts ? (
        // Unloaded is not the same as empty, so it says neither.
        <p className="ck-dim text-[12px]">
          {loading ? "Loading the payout journal…" : "[payouts unavailable]"}
        </p>
      ) : payouts.payouts.length === 0 ? (
        <p className="ck-dim text-[12px]">
          Murmur has not recorded a payout for this agent yet. Payouts are sent
          by hand, then written down here.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] border border-[var(--color-border)]">
          {payouts.payouts.map((row) => {
            const reversal = row.entry_type === "reversal";
            return (
              <li
                key={row.id}
                className="grid grid-cols-[auto_1fr_auto] items-baseline gap-3 px-3 py-2"
              >
                <span
                  className="ck-dim text-[12px]"
                  title={formatLocalDateTime(row.created_at) ?? row.created_at}
                >
                  {row.created_at.slice(0, 10)}
                </span>
                <span className="min-w-0">
                  <span className="ck-mono truncate block" title={row.tx_ref}>
                    {shortId(row.tx_ref)}
                  </span>
                  <span className="ck-dim text-[12px]">
                    {row.payout_method}
                    {reversal ? " · reversal" : ""}
                    {row.note ? ` · ${row.note}` : ""}
                  </span>
                </span>
                <span
                  className={`ck-mono text-right ${reversal ? "ck-neg" : "ck-pos"}`}
                  title={`sent to ${row.destination_ref}`}
                >
                  {reversal ? "−" : "+"}
                  {formatAtoms(row.amount_atoms, row.currency)}{" "}
                  <span className="ck-dim text-[12px]">{row.currency}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function SkeletonStrip() {
  return (
    <div className="flex flex-col gap-2">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="border border-[var(--color-border)] px-3 py-3 flex gap-3"
        >
          <div className="h-[10px] bg-[var(--color-border)] w-[30%]" />
          <div className="h-[10px] bg-[var(--color-border)] w-[20%]" />
        </div>
      ))}
    </div>
  );
}
