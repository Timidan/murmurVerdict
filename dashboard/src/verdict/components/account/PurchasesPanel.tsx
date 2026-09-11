// Purchases made by your controller wallet.
//
// Two tiers, and the panel is explicit about which one it is showing.
//
//   unsigned  granted rows only. Each one mirrors an on-chain grant anybody
//             can already read, so murmur serves them without proof.
//   signed    everything, including purchases that stalled and money that is
//             owed back. That is a private operational record of what somebody
//             tried to buy and what went wrong, so it takes a signature from
//             the wallet itself.
//
// The signature is over `murmur:purchases:<address>:<unix>` and unlocks a read
// of the signer's OWN history and nothing else. It is not a transaction, and
// the copy says so before asking for it.
//
// `payment_status: 'unknown'` is rendered as the word "unknown". It means
// murmur holds no settlement receipt for that row — NOT that the payment
// failed — and softening it either way would be a guess about somebody's money.

import { useCallback, useEffect, useRef, useState } from "react";
import { useSignMessage, useWallets } from "@privy-io/react-auth";

import {
  purchasesAuthMessage,
  verdictApi,
  type AccountAgent,
  type WalletPurchaseRow,
  type WalletPurchasesView,
} from "../../api.js";
import { Ik } from "../../icons.js";
import { formatAtoms } from "../../lib/atoms-format.js";
import { formatLocalDateTime } from "../../lib/date-time-format.js";
import { shortId } from "../../lib/display-format.js";
import { InlineError } from "../compact/InlineError.js";

export function PurchasesPanel({ agents }: { agents: AccountAgent[] }) {
  const { wallets } = useWallets();
  const { signMessage } = useSignMessage();
  const [view, setView] = useState<WalletPurchasesView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  // The signed read is replayable for five minutes, so paging keeps the same
  // proof instead of asking the wallet to sign once per page.
  const [auth, setAuth] = useState<
    { unixSeconds: number; signature: string } | null
  >(null);

  const boundAddresses = agents
    .map((a) => a.controller_wallet?.wallet_address)
    .filter((a): a is string => Boolean(a));
  const isBound = (a: string) =>
    boundAddresses.some((b) => b.toLowerCase() === a.toLowerCase());

  // An owner buys in the browser from the Privy wallet, while an agent's
  // controller wallet is often a different one, so the panel offers both
  // rather than choosing for them. Connected wallets come first — only those
  // can sign. A bound wallet that is not connected still reads unsigned.
  const options: Array<{ address: string; name: string }> = wallets.map((w) => ({
    address: w.address,
    name:
      (w.walletClientType === "privy" ? "privy wallet" : w.walletClientType) +
      (isBound(w.address) ? " · controller wallet" : ""),
  }));
  for (const b of boundAddresses) {
    if (!options.some((o) => o.address.toLowerCase() === b.toLowerCase())) {
      options.push({ address: b, name: "controller wallet · not connected" });
    }
  }

  const fallback =
    wallets.find((w) => isBound(w.address))?.address ??
    wallets.find((w) => w.walletClientType === "privy")?.address ??
    wallets[0]?.address ??
    boundAddresses[0] ??
    null;
  const address = picked ?? fallback;
  const connected =
    wallets.find((w) => w.address.toLowerCase() === address?.toLowerCase()) ??
    null;

  // Rows belong to the address they were fetched for. Switching wallets drops
  // them, and bumping the token discards whatever is still in flight.
  const requestRef = useRef(0);
  useEffect(() => {
    requestRef.current += 1;
    setView(null);
    setError(null);
    setAuth(null);
    setBusy(false);
  }, [address]);

  const load = useCallback(
    async (signed: boolean) => {
      if (!address) {
        setError("Bind a controller wallet first. It is the wallet that pays.");
        return;
      }
      const request = ++requestRef.current;
      setBusy(true);
      setError(null);
      try {
        if (!signed) {
          const page = await verdictApi.getWalletPurchases(address);
          if (requestRef.current !== request) return;
          setAuth(null);
          setView(page);
          return;
        }
        if (!connected) {
          setError("Connect the wallet that paid. It has to sign this.");
          return;
        }
        const unixSeconds = Math.floor(Date.now() / 1000);
        // Pin the signer to the wallet whose history we are asking for —
        // Privy otherwise defaults to embedded HD index 0, which would sign
        // for a different address and be rejected.
        const { signature } = await signMessage(
          { message: purchasesAuthMessage(connected.address, unixSeconds) },
          { address: connected.address },
        );
        const proof = { unixSeconds, signature };
        const page = await verdictApi.getWalletPurchases(
          connected.address,
          proof,
        );
        if (requestRef.current !== request) return;
        setAuth(proof);
        setView(page);
      } catch (e) {
        if (requestRef.current !== request) return;
        setError((e as Error)?.message ?? "unknown error");
      } finally {
        if (requestRef.current === request) setBusy(false);
      }
    },
    [address, connected, signMessage],
  );

  // "full history" was one page. Older purchases and their refund rows sat
  // behind the cursor the response already carries.
  const loadMore = useCallback(async () => {
    const cursor = view?.next_cursor;
    if (!address || !cursor) return;
    const request = ++requestRef.current;
    setBusy(true);
    setError(null);
    try {
      const page = await verdictApi.getWalletPurchases(
        address,
        auth ?? undefined,
        { cursor },
      );
      if (requestRef.current !== request) return;
      setView((prev) =>
        prev ? { ...page, purchases: [...prev.purchases, ...page.purchases] } : page,
      );
    } catch (e) {
      if (requestRef.current !== request) return;
      setError((e as Error)?.message ?? "unknown error");
    } finally {
      if (requestRef.current === request) setBusy(false);
    }
  }, [address, auth, view?.next_cursor]);

  return (
    <section className="ck-frame">
      <div className="ck-header">
        <span className="ck-title ck-title-ik">
          <Ik name="x402" /> purchases
        </span>
        <span className="ck-mono ck-dim">
          {view ? (view.authenticated ? "full history" : "granted only") : "…"}
        </span>
      </div>

      <div className="px-3 py-3 flex flex-col gap-3">
        {/* Why granted rows are public, and what signing adds, are answers to
            questions the two buttons already ask. They belong on the hover. */}
        <p
          className="ck-dim text-[12px]"
          title="Granted purchases are visible to anyone because each one is already on chain. Signing reveals the rest: what stalled, and what is owed back."
        >
          Calls this wallet paid to read early.
        </p>

        {options.length > 1 ? (
          <label className="flex items-center gap-2">
            <span className="ck-label">wallet</span>
            <select
              value={address ?? ""}
              onChange={(e) => setPicked(e.currentTarget.value)}
              disabled={busy}
              className="ck-mono ck-select"
              title="the wallet whose purchases you are reading"
            >
              {options.map((o) => (
                <option key={o.address} value={o.address} title={o.address}>
                  {shortId(o.address, 8, 6)} · {o.name}
                </option>
              ))}
            </select>
          </label>
        ) : address ? (
          <p className="ck-dim text-[12px]">
            wallet <span className="ck-mono" title={address}>{shortId(address, 8, 6)}</span>
          </p>
        ) : (
          <p className="ck-mono ck-dim">No controller wallet is bound yet.</p>
        )}

        <span className="flex flex-wrap gap-2">
          <button
            type="button"
            className="ck-btn ck-btn-bracket"
            onClick={() => void load(false)}
            disabled={busy || !address}
          >
            <Ik name="all-calls" />
            show granted purchases
          </button>
          <button
            type="button"
            className="ck-btn ck-btn-bracket ck-pos"
            onClick={() => void load(true)}
            disabled={busy || !connected}
            title="signs a message. It is not a transaction and moves no money."
          >
            <Ik name="attest" />
            sign to show everything
          </button>
        </span>

        {error && <InlineError error={error} className="text-[12px]" />}

        {view && view.purchases.length === 0 && (
          <p className="ck-mono ck-dim">
            {view.authenticated
              ? "This wallet has bought nothing."
              : "No granted purchases. Sign to check for ones still in flight."}
          </p>
        )}

        {view && view.purchases.length > 0 && (
          <>
            {!view.authenticated && (
              <p className="ck-dim text-[12px]">
                Granted purchases only. Purchases still in flight, and any money
                owed back, are hidden until you sign.
              </p>
            )}
            <ul className="divide-y divide-[var(--color-border)] border border-[var(--color-border)]">
              {view.purchases.map((row) => (
                <PurchaseRow key={`${row.onchain_call_id}-${row.created_at}`} row={row} />
              ))}
            </ul>
            {view.next_cursor && (
              <button
                type="button"
                className="ck-btn ck-btn-bracket self-start"
                onClick={() => void loadMore()}
                disabled={busy}
              >
                show older purchases
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function PurchaseRow({ row }: { row: WalletPurchaseRow }) {
  const granted = row.status === "granted";
  const refundOwed =
    row.refund_status !== null &&
    row.refund_status !== undefined &&
    row.refund_status !== "none";
  return (
    <li className="grid grid-cols-[1fr_auto] items-baseline gap-3 px-3 py-2">
      <span className="min-w-0">
        <span className="ck-mono truncate block" title={row.onchain_call_id}>
          {shortId(row.onchain_call_id)}
        </span>
        <span className="ck-dim text-[12px]">
          {row.producer_agent_slug ? `${row.producer_agent_slug} · ` : ""}
          {formatLocalDateTime(row.created_at) ?? row.created_at}
        </span>
      </span>
      <span className="text-right flex flex-col items-end">
        <span className="ck-mono">
          {row.amount
            ? `${formatAtoms(row.amount, row.currency)} ${row.currency ?? ""}`
            : "—"}
        </span>
        <span className={`text-[12px] ${granted ? "ck-pos" : "ck-dim"}`}>
          {granted ? "granted" : row.status}
        </span>
        {row.payment_status && (
          <span
            className={
              "text-[12px] " +
              (row.payment_status === "confirmed" ? "ck-dim" : "ck-neg")
            }
            title={
              row.payment_status === "confirmed"
                ? "Murmur holds a settlement receipt for this payment."
                : "Murmur holds no settlement receipt for this row. That does not mean the payment failed — it means murmur cannot confirm it."
            }
          >
            payment {row.payment_status}
          </span>
        )}
        {refundOwed && (
          <span className="ck-neg text-[12px]" title="the operator sends refunds by hand">
            refund {row.refund_status}
          </span>
        )}
      </span>
    </li>
  );
}
