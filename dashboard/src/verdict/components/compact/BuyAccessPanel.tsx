// ─── Buying one sealed call, in the browser ─────────────────────────────────
//
// The owner-facing half of the consumer path. Its twin is
// tools/subscriber-buy-access.ts, which an AGENT runs from its own runtime with
// its own key. Both drive the SAME endpoint with the same four steps, because
// POST /v2/gateway/calls/:callId/access derives the subscriber from the
// verified payer inside the x402 signature and from nothing else:
//
//   1. POST with no payment            → 402 + the challenge
//   2. sign the authorization          → here, Privy; there, a runtime key
//   3. re-POST with PAYMENT-SIGNATURE  → murmur verifies, settles, queues the grant
//   4. poll GET …/access/status        → until the on-chain grant lands
//
// PAYMENT IS THE IDENTITY. The route takes no runtime key and no Privy session;
// whoever signs becomes the subscriber. So the only difference between the two
// paths is who holds the signing key, and nothing about the protocol changes.
//
// WHY THIS MOUNTS ITS OWN PrivyProvider: /leaderboard is a public route, kept
// deliberately outside the Privy bundle (Router.tsx mounts AccountShell only
// for /account/*). This component is `lazy()`-imported by the matrix the moment
// a buyer opens a row, so the SDK chunk is fetched on demand and the public
// bundle stays as Privy-free as it was.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useCreateWallet,
  usePrivy,
  useSignTypedData,
  useWallets,
  type ConnectedWallet,
} from "@privy-io/react-auth";

import { PrivyProvider } from "../../auth/PrivyProvider.js";
import { isPrivyConfigured } from "../../auth/privy-config.js";
import { callAccessUrl, verdictApi, type RawResponse } from "../../api.js";
import { Ik } from "../../icons.js";
import {
  buyLine,
  classifyPoll,
  classifyPurchase,
  isBusy,
  noWalletStop,
  POLL_INTERVAL_MS,
  POLL_LIMIT,
  pollTimeoutStop,
  quoteFromChallenge,
  quoteLabel,
  stalePriceNotice,
  stopFromResponse,
  stopFromSignature,
  unreachableStop,
  unreadableChallengeStop,
  type AccessStatusBody,
  type BuyState,
  type SettlementConfidence,
} from "../../lib/call-access-buy.js";
import type { OpenCallView } from "../../lib/listings-matrix.js";
import {
  accessResource,
  buildBatchPayment,
  encodePaymentHeader,
  parseAccessChallenge,
} from "../../lib/x402-batch-payment.js";
import { shortId } from "../../lib/display-format.js";

/** The provider island. See the header note on why it is mounted here. */
export function BuyAccessPanel({ call, onClose }: { call: OpenCallView; onClose: () => void }) {
  return (
    <PrivyProvider>
      <BuyAccessBody call={call} onClose={onClose} />
    </PrivyProvider>
  );
}

function BuyAccessBody({ call, onClose }: { call: OpenCallView; onClose: () => void }) {
  // Hooks first and unconditionally, so hook order never depends on config.
  // Outside a mounted provider Privy's hooks return a no-op default reporting
  // `ready: false`, which would leave this panel saying "connecting…" forever —
  // hence the explicit unconfigured branch in the markup below.
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  const { signTypedData } = useSignTypedData();
  const [state, setState] = useState<BuyState>({ step: "idle" });
  const configured = isPrivyConfigured();

  // Strictly the Privy embedded wallet, for the reason AgentOnboardPage gives:
  // `useWallets()` returns every browser-injected wallet whether or not the
  // user linked it, and silently spending from one of those is worse here than
  // anywhere else on the site — this one moves money and picks who gets to
  // decrypt the call.
  const wallet: ConnectedWallet | null =
    wallets.find((w) => w.walletClientType === "privy") ?? null;

  // Cancel everything in flight when the row closes. A poll loop that outlives
  // its panel would keep calling setState on an unmounted tree.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const start = useCallback(async () => {
    if (!wallet) {
      setState({ step: "stopped", stop: noWalletStop() });
      return;
    }
    setState({ step: "quoting" });
    try {
      // (1) What does THIS call cost? 402 is the success case.
      const challenged = await verdictApi.callAccessChallenge(call.onchainCallId);
      if (!live.current) return;
      if (challenged.status !== 402) {
        setState({
          step: "stopped",
          stop: stopFromResponse(challenged.status, challenged.body, "quote"),
        });
        return;
      }
      const parsed = parseAccessChallenge(challenged.body);
      if (!parsed.ok) {
        setState({ step: "stopped", stop: unreadableChallengeStop(parsed.reason) });
        return;
      }
      const quote = quoteFromChallenge(call.onchainCallId, parsed.challenge);

      // Ask whether this wallet ALREADY holds the grant before prompting for a
      // signature. murmur would answer the same way after payment — it checks
      // the chain before settling — but making somebody sign for something they
      // already own, to be told it was free, is a worse way to find out.
      const existing = await verdictApi.callAccessStatus(call.onchainCallId, wallet.address);
      if (!live.current) return;
      if (
        existing.status === 200 &&
        classifyPoll(existing.body as AccessStatusBody).kind === "granted"
      ) {
        setState({ step: "granted", subscriber: wallet.address, alreadyOwned: true });
        return;
      }

      setState({
        step: "quoted",
        quote,
        stale: stalePriceNotice(call.lockedPriceAtoms, quote),
      });
    } catch (err) {
      if (!live.current) return;
      setState({ step: "stopped", stop: unreachableStop("quote", err) });
    }
  }, [call.lockedPriceAtoms, call.onchainCallId, wallet]);

  // Quote as soon as the panel has a wallet to quote for. Step 1 is an unpaid
  // read — it spends nothing and prompts nothing — so making a buyer click
  // "get the price" first would be a click that buys them no information.
  // Latched, so a wallet arriving late does not re-quote over a live purchase.
  const quoted = useRef(false);
  useEffect(() => {
    if (quoted.current) return;
    if (!configured || !ready || !authenticated || !wallet) return;
    quoted.current = true;
    void start();
  }, [authenticated, configured, ready, start, wallet]);

  const pay = useCallback(async () => {
    if (state.step !== "quoted" || !wallet) return;
    const quote = state.quote;
    setState({ step: "signing", quote });

    // (2) Sign the EIP-3009 authorization. This is the whole identity step —
    // the address that signs is the address murmur grants decrypt access to.
    let header: string;
    try {
      const built = buildBatchPayment({ challenge: quote.challenge, from: wallet.address });
      const { signature } = await signTypedData(built.typedData, { address: wallet.address });
      header = encodePaymentHeader({
        requirements: quote.challenge.requirements,
        authorization: built.authorization,
        signature,
        resource: accessResource(callAccessUrl(quote.onchainCallId), quote.onchainCallId),
      });
    } catch (err) {
      if (!live.current) return;
      setState({ step: "stopped", stop: stopFromSignature(err) });
      return;
    }
    if (!live.current) return;

    // (3) Present it.
    setState({ step: "presenting", quote });
    let outcome: ReturnType<typeof classifyPurchase>;
    try {
      const paid = await verdictApi.callAccessPurchase(quote.onchainCallId, header);
      outcome = classifyPurchase(paid.status, paid.body);
    } catch (err) {
      if (!live.current) return;
      setState({ step: "stopped", stop: unreachableStop("present", err) });
      return;
    }
    if (!live.current) return;
    if (outcome.kind === "stopped") {
      setState({ step: "stopped", stop: outcome.stop });
      return;
    }
    const subscriber = outcome.subscriber || wallet.address;
    if (outcome.kind === "granted") {
      setState({ step: "granted", subscriber, alreadyOwned: outcome.alreadyOwned });
      return;
    }

    // (4) Presented. The grant is broadcast asynchronously; wait for the chain.
    //
    // A 202 is NOT proof the money moved — it can carry `settlement_unknown`,
    // or a `payment_settling` reservation this request never settled — so the
    // confidence rides along and each poll re-reads it. The line says "paid"
    // only once the server's own status records a settled payment.
    let settlement: SettlementConfidence = outcome.settlement;
    setState({ step: "waiting", quote, subscriber, polls: 0, settlement });
    for (let i = 0; i < POLL_LIMIT; i++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (!live.current) return;
      let polled: RawResponse;
      try {
        polled = await verdictApi.callAccessStatus(quote.onchainCallId, subscriber);
      } catch {
        // A blip on the status route is not a failed purchase. Keep waiting.
        continue;
      }
      if (!live.current) return;
      const verdict = classifyPoll(polled.body as AccessStatusBody);
      if (verdict.kind === "granted") {
        setState({ step: "granted", subscriber, alreadyOwned: false });
        return;
      }
      if (verdict.kind === "stopped") {
        setState({ step: "stopped", stop: verdict.stop });
        return;
      }
      settlement = verdict.settlement;
      setState({ step: "waiting", quote, subscriber, polls: i + 1, settlement });
    }
    if (live.current) setState({ step: "stopped", stop: pollTimeoutStop(settlement) });
  }, [signTypedData, state, wallet]);

  const line = buyLine(state);
  const busy = isBusy(state);

  return (
    <div className="px-2 pb-2 pt-1 flex flex-col gap-2">
      <span className="flex items-center justify-between gap-3">
        <span className="ck-label ck-dim inline-flex items-center gap-1.5">
          <Ik name="x402" />
          early access
        </span>
        {/* Always closeable, including mid-wait. Closing stops the polling
            (the `live` ref), it does not stop the purchase: a paid grant lands
            on chain either way and shows up on the account's purchases panel.
            Trapping somebody in a panel for the eight minutes a slow grant can
            take would be the worse failure. */}
        <button
          type="button"
          onClick={onClose}
          className="ck-btn ck-btn-bracket"
          title={
            busy
              ? "Closes this panel. Anything already paid for still completes — check purchases on your account."
              : undefined
          }
        >
          close
        </button>
      </span>

      {/* One sentence on what the money buys. Everything else hovers. */}
      <p
        className="ck-dim m-0"
        title="You pay the price locked onto this call when it was sealed, and the wallet that signs receives on-chain permission to decrypt it before the public reveal. Murmur never holds the plaintext — you unseal it locally."
      >
        Decrypt this call before its reveal. The wallet that signs is the wallet
        that gets access.
      </p>

      {!configured && (
        <p
          className="ck-mono ck-dim m-0"
          title="Buying in the browser needs a wallet to sign the payment, and this build has no Privy app id. An agent can still buy this call from its own runtime with tools/subscriber-buy-access.ts — the endpoint is the same one."
        >
          no sign-in configured on this build
        </p>
      )}

      {configured && !ready && <p className="ck-mono ck-dim m-0">connecting…</p>}

      {configured && ready && !authenticated && (
        <span>
          <button type="button" className="ck-btn ck-btn-bracket ck-pos" onClick={() => login()}>
            <Ik name="controller-wallet" />
            sign in to buy
          </button>
        </span>
      )}

      {configured && ready && authenticated && !wallet && (
        <span className="flex flex-col gap-2 items-start">
          <p className="ck-dim m-0">This account has no murmur wallet yet.</p>
          <button
            type="button"
            className="ck-btn ck-btn-bracket ck-pos"
            onClick={() => void createWallet()}
          >
            <Ik name="controller-wallet" />
            create one
          </button>
        </span>
      )}

      {configured && ready && authenticated && wallet && (
        <>
          <p className="ck-dim m-0">
            paying as{" "}
            <span className="ck-mono" title={wallet.address}>
              {shortId(wallet.address, 8, 6)}
            </span>
          </p>

          {/* The price is stated in exactly ONE element on this page, and it is
              the label of the button that authorizes it — built from the 402's
              own quote, never from the row above. `buyLine` returns nothing for
              this step for the same reason: a second copy of a number is a
              second copy to keep in step. */}
          {state.step === "quoted" && (
            <>
              {state.stale && <p className="ck-neg m-0">{state.stale}</p>}
              <span className="flex flex-wrap gap-3 items-center">
                <button
                  type="button"
                  className="ck-btn ck-btn-bracket ck-pos"
                  onClick={() => void pay()}
                  title={`Signs an authorization for ${quoteLabel(state.quote)} against Circle's Gateway. Nothing is charged until murmur verifies it.`}
                >
                  <Ik name="x402" />
                  pay {quoteLabel(state.quote)}
                </button>
                <span className="ck-dim" title={`pricing ${state.quote.pricingVersion}`}>
                  locked at seal time
                </span>
              </span>
            </>
          )}

          {state.step === "stopped" && state.stop.retryable && (
            <span>
              <button type="button" className="ck-btn ck-btn-bracket" onClick={() => void start()}>
                try again
              </button>
            </span>
          )}
        </>
      )}

      {line && (
        <p
          className={`ck-mono m-0 ${line.tone === "pos" ? "ck-pos" : line.tone === "neg" ? "ck-neg" : "ck-dim"}`}
          /* The stop prints its own detail below, so a tooltip repeating it
             would read the same sentence twice to a screen reader. */
          title={state.step === "stopped" ? undefined : line.title}
        >
          {line.text}
        </p>
      )}

      {/* A stop's headline is three words: "gateway balance short" names no
          balance a buyer can go and look at. The recovery lives in the detail,
          and a tooltip is unreachable on touch, so it is rendered. */}
      {state.step === "stopped" && <p className="ck-dim m-0">{state.stop.detail}</p>}

      {state.step === "granted" && (
        <p className="ck-dim m-0" title="The unseal tool reads the ciphertext handles from the status route and decrypts them with a permit only your wallet can sign. Murmur is not involved in the decrypt.">
          Unseal it from your own machine:{" "}
          {/* The WHOLE call id. A shortened one is not an argument the tool can
              take, and this line is meant to be copied and run. */}
          <span className="ck-mono break-all">
            tsx tools/subscriber-unseal-granted-call.ts {call.onchainCallId}
          </span>
        </p>
      )}
    </div>
  );
}
