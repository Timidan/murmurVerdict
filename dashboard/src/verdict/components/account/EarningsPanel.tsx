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
  type ProviderReleaseBalanceView,
  type ProviderWithdrawalsView,
} from "../../api.js";
import { Ik } from "../../icons.js";
import { formatAtoms, isPositiveAtoms } from "../../lib/atoms-format.js";
import { formatLocalDateTime } from "../../lib/date-time-format.js";
import { shortId } from "../../lib/display-format.js";
import { CurrencyMark } from "../compact/CurrencyMark.js";
import { InlineError } from "../compact/InlineError.js";

/**
 * Rows per page. The server's default is 100, which this panel used to take
 * silently and render as if it were everything. A money ledger that ends
 * without saying whether it is complete is lying by omission, so both lists
 * page on the `page` the wire already carries.
 */
const PAGE = 25;

export function EarningsPanel({ slug }: { slug: string }) {
  const [earnings, setEarnings] = useState<ProviderEarningsView | null>(null);
  const [payouts, setPayouts] = useState<ProviderPayoutsView | null>(null);
  const [withdrawals, setWithdrawals] = useState<ProviderWithdrawalsView | null>(null);
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
        verdictApi.getAgentEarnings(token, slug, { limit: PAGE, offset: 0 }),
        verdictApi.getAgentPayouts(token, slug, { limit: PAGE, offset: 0 }),
      ]);
      setEarnings(e);
      setPayouts(p);
      // Separate and non-fatal: a deployment with no payout rail still has an
      // earnings page, and a failure here must not blank the ledger above it.
      try {
        setWithdrawals(await verdictApi.getAgentWithdrawals(token, slug));
      } catch {
        setWithdrawals(null);
      }
    } catch (e) {
      setError((e as Error)?.message ?? "unknown error");
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A full page means there may be more; a short page is the end. Older rows
  // append below, the same way purchases and activity already page.
  const [paging, setPaging] = useState(false);
  const moreSales = earnings !== null && earnings.page.returned === earnings.page.limit;
  const morePayouts = payouts !== null && payouts.page.returned === payouts.page.limit;

  const loadOlderSales = useCallback(async () => {
    if (!earnings || !moreSales) return;
    setPaging(true);
    try {
      const token = await getAccessToken();
      if (!token) return;
      const next = await verdictApi.getAgentEarnings(token, slug, {
        limit: PAGE,
        offset: earnings.sales.length,
      });
      setEarnings({ ...next, sales: [...earnings.sales, ...next.sales] });
    } catch (e) {
      setError((e as Error)?.message ?? "unknown error");
    } finally {
      setPaging(false);
    }
  }, [earnings, moreSales, slug]);

  const loadOlderPayouts = useCallback(async () => {
    if (!payouts || !morePayouts) return;
    setPaging(true);
    try {
      const token = await getAccessToken();
      if (!token) return;
      const next = await verdictApi.getAgentPayouts(token, slug, {
        limit: PAGE,
        offset: payouts.payouts.length,
      });
      setPayouts({ ...next, payouts: [...payouts.payouts, ...next.payouts] });
    } catch (e) {
      setError((e as Error)?.message ?? "unknown error");
    } finally {
      setPaging(false);
    }
  }, [payouts, morePayouts, slug]);

  const totals = earnings?.totals ?? [];
  // The lifetime count, not `sales.length` — that page holds one page of rows.
  const lifetimeSales = totals.reduce((sum, t) => sum + t.sales, 0);

  return (
    <section className="ck-frame w-full flex flex-col">
      <div className="ck-header">
        <span className="ck-title ck-title-ik">
          <Ik name="x402" /> Earnings
        </span>
        <span className="ck-mono ck-dim">
          {earnings ? `${lifetimeSales} sales` : "…"}
        </span>
      </div>

      <div className="px-4 py-4 flex flex-col gap-4">

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
              <MoneyStrip
                key={total.currency}
                total={total}
                slug={slug}
                balance={
                  withdrawals?.balances.find((b) => b.currency === total.currency) ?? null
                }
                withdrawalsAvailable={withdrawals?.withdrawals_available ?? false}
                onWithdrawn={() => void refresh()}
              />
            ))}
          </div>
        )}

        {earnings && earnings.sales.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="ck-label ck-pos">Sales</h3>
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
                    <CurrencyMark currency={sale.currency} className="ck-dim text-[12px]" />
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
            {moreSales && (
              <button
                type="button"
                className="ck-btn ck-btn-bracket self-start"
                onClick={() => void loadOlderSales()}
                disabled={paging}
              >
                show older sales
              </button>
            )}
          </div>
        )}

        {withdrawals && withdrawals.withdrawals.length > 0 && (
          <WithdrawalList rows={withdrawals.withdrawals} />
        )}

        <PayoutJournal
          payouts={payouts}
          loading={loading}
          onOlder={morePayouts ? loadOlderPayouts : null}
          paging={paging}
        />
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
function MoneyStrip({
  total,
  slug,
  balance,
  withdrawalsAvailable,
  onWithdrawn,
}: {
  total: ProviderEarningsTotal;
  slug: string;
  /** null while the withdrawals read is loading, or where no rail runs. */
  balance: ProviderReleaseBalanceView | null;
  withdrawalsAvailable: boolean;
  onWithdrawn: () => void;
}) {
  const overpaid = isPositiveAtoms(total.overpaid_atoms);
  const owed = !overpaid && isPositiveAtoms(total.owed_atoms);
  return (
    <div className="border border-[var(--color-border-vis)] px-3 py-2 flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="ck-label ck-pos">
          <CurrencyMark currency={total.currency} />
        </span>
        <span className="ck-dim text-[12px]">
          {total.sales} {total.sales === 1 ? "sale" : "sales"} ·{" "}
          {total.payout_entries}{" "}
          {total.payout_entries === 1 ? "payout entry" : "payout entries"}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Figure
          label="Accrued"
          value={formatAtoms(total.lifetime_accrued_net, total.currency)}
          tone="pos"
          title="What your sales earned you, after murmur's fee."
        />
        <Figure
          label="Paid"
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
      {/* The withdraw control lives HERE, beside the number it moves. Where no
          payout rail runs, the same spot says so instead of offering a button
          the deployment cannot honour. */}
      {balance && withdrawalsAvailable && (
        <WithdrawRow slug={slug} balance={balance} onWithdrawn={onWithdrawn} />
      )}
      {owed && !withdrawalsAvailable && (
        <p className="ck-dim text-[12px]">
          Payouts are not automated on this deployment. An operator sends your
          share by hand and writes it in the journal below.{" "}
          <a
            href={`#/account/agent/${encodeURIComponent(slug)}/payout`}
            className="ck-pos"
          >
            Check where it goes
          </a>
          .
        </p>
      )}
      {overpaid && (
        <p className="ck-neg text-[12px]">
          Murmur paid you more than you earned. The operator corrects this with
          a reversal entry.
        </p>
      )}
    </div>
  );
}

/**
 * Available, held, and the button.
 *
 * `available` and `owed` are different numbers and the difference is the whole
 * point of the delivery gate: money is OWED as soon as a call sells, and
 * becomes AVAILABLE once the buyer has confirmed they received it (or the call
 * went public and anyone can check it). Showing only one of them would either
 * promise money that cannot move yet, or hide money that was earned.
 */
function WithdrawRow({
  slug,
  balance,
  onWithdrawn,
}: {
  slug: string;
  balance: ProviderReleaseBalanceView;
  onWithdrawn: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Generated ONCE per intent, not per click: the same id retried replays the
  // original reservation instead of taking a second one.
  const [requestId] = useState(() => `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  const available = BigInt(balance.available_atoms);
  const held = BigInt(balance.held_net_atoms);
  const reserved = BigInt(balance.reserved_atoms);
  const unenrolled = BigInt(balance.unenrolled_net_atoms);

  const withdraw = async () => {
    setBusy(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Your session expired. Sign in again.");
      await verdictApi.createAgentWithdrawal(token, slug, requestId);
      onWithdrawn();
    } catch (e) {
      setError((e as Error)?.message ?? "unknown error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1 border-t border-[var(--color-border)] pt-2 mt-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-col">
          <span className="ck-label ck-dim">Available to withdraw</span>
          <span className={"ck-mono " + (available > 0n ? "ck-pos" : "ck-dim")}>
            {formatAtoms(balance.available_atoms, balance.currency)}{" "}
            <CurrencyMark currency={balance.currency} className="ck-dim text-[12px]" />
          </span>
        </span>
        <button
          type="button"
          onClick={() => void withdraw()}
          disabled={busy || available <= 0n}
          className="ck-btn ck-btn-bracket min-h-[32px] disabled:opacity-50"
          title={
            available > 0n
              ? `Send ${formatAtoms(balance.available_atoms, balance.currency)} ${balance.currency} to your payout address.`
              : "Nothing is available to withdraw yet."
          }
        >
          {busy ? "requesting…" : "withdraw"}
        </button>
      </div>

      {/* Each of these is a different thing for the owner to do about it, so
          none of them is collapsed into a single "pending" figure. */}
      {held > 0n && (
        <p className="ck-dim text-[12px] m-0">
          {formatAtoms(balance.held_net_atoms, balance.currency)} from{" "}
          {balance.held_sales} sale{balance.held_sales === 1 ? "" : "s"} is waiting on the
          buyer. It unlocks when they confirm, or when the call is published.
        </p>
      )}
      {reserved > 0n && (
        <p className="ck-dim text-[12px] m-0">
          {formatAtoms(balance.reserved_atoms, balance.currency)} is already on its way.
        </p>
      )}
      {unenrolled > 0n && (
        <p className="ck-dim text-[12px] m-0">
          {formatAtoms(balance.unenrolled_net_atoms, balance.currency)} is from sales made
          before murmur tracked delivery. An operator has to check those by hand.
        </p>
      )}
      {error && <InlineError error={error} className="text-[12px]" />}
    </div>
  );
}

/** Withdrawals in flight, and what happened to the ones that finished. */
function WithdrawalList({ rows }: { rows: ProviderWithdrawalsView["withdrawals"] }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="ck-label ck-pos">Withdrawals</h3>
      <ul className="divide-y divide-[var(--color-border)] border border-[var(--color-border)]">
        {rows.map((row) => (
          <li key={row.id} className="grid grid-cols-[1fr_auto] items-baseline gap-3 px-3 py-2">
            <span className="min-w-0">
              <span className="ck-mono">
                {formatAtoms(row.amount_atoms, row.currency)}{" "}
                <CurrencyMark currency={row.currency} className="ck-dim text-[12px]" />
              </span>
              <span className="ck-dim text-[12px] block">{row.status_note}</span>
            </span>
            <span className="text-right">
              <span
                className={
                  "ck-mono text-[12px] " +
                  (row.state === "paid"
                    ? "ck-pos"
                    : row.state === "needs_review" || row.state === "failed"
                      ? "ck-neg"
                      : "ck-dim")
                }
              >
                {row.state}
              </span>
              {row.tx_hash && (
                <span className="ck-dim text-[12px] block" title={row.tx_hash}>
                  {shortId(row.tx_hash)}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
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
  onOlder,
  paging,
}: {
  payouts: ProviderPayoutsView | null;
  loading: boolean;
  /** Null when the last page was short, i.e. the journal is complete. */
  onOlder: (() => Promise<void>) | null;
  paging: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="ck-label ck-pos">Payouts</h3>
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
                  <CurrencyMark currency={row.currency} className="ck-dim text-[12px]" />
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {onOlder && (
        <button
          type="button"
          className="ck-btn ck-btn-bracket self-start"
          onClick={() => void onOlder()}
          disabled={paging}
        >
          show older payouts
        </button>
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
