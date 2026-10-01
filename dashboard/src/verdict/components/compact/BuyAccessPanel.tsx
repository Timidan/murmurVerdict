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
  useSignMessage,
  useSignTypedData,
  useWallets,
  type ConnectedWallet,
} from "@privy-io/react-auth";

import { PrivyProvider } from "../../auth/PrivyProvider.js";
import { isPrivyConfigured } from "../../auth/privy-config.js";
import { callAccessUrl, purchasesAuthMessage, verdictApi, type RawResponse } from "../../api.js";
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
import { formatAtoms } from "../../lib/atoms-format.js";
import { clearGatewayDeposit, decryptGrantedCall, depositGatewayUsdc, gatewayBalance, gatewayDepositReverted, gatewayShortfall, saveGatewayDeposit, savedGatewayDeposit } from "../../lib/browser-call-access.js";
import { parseMarketConfig } from "../../lib/market-meta.js";

type GatewayFunding =
  | { kind: "checking" }
  | { kind: "ready"; spendable: bigint; pending: boolean }
  | { kind: "submitting" }
  | { kind: "submitted"; transactionHash: string }
  | { kind: "error"; message: string };

type AccessDetails = AccessStatusBody & {
  chainId?: number;
  contract?: string;
  callId?: string;
  ciphertexts?: {
    binaryIndex?: { handle?: string };
    confidenceBps?: { handle?: string };
  };
};

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
  const { signMessage } = useSignMessage();
  const [state, setState] = useState<BuyState>({ step: "idle" });
  const [funding, setFunding] = useState<GatewayFunding>({ kind: "checking" });
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

  const refreshFunding = useCallback(async (quote: ReturnType<typeof quoteFromChallenge>) => {
    if (quote.challenge.chainId !== 421614) {
      setFunding({ kind: "error", message: `Gateway funding is available only on Arbitrum Sepolia (421614), not chain ${quote.challenge.chainId}.` });
      return;
    }
    setFunding({ kind: "checking" });
    try {
      const balance = await gatewayBalance(wallet!.address);
      if (!live.current) return;
      const saved = savedGatewayDeposit({
        chainId: quote.challenge.chainId,
        asset: quote.challenge.requirements.asset,
        gateway: quote.challenge.requirements.extra.verifyingContract,
        amount: quote.challenge.requirements.amount,
      }, wallet!.address);
      if (saved && balance.spendable < BigInt(quote.challenge.requirements.amount)) {
        if (!(await gatewayDepositReverted(saved))) {
          setFunding({ kind: "submitted", transactionHash: saved });
          return;
        }
        clearGatewayDeposit({ chainId: quote.challenge.chainId, asset: quote.challenge.requirements.asset, gateway: quote.challenge.requirements.extra.verifyingContract, amount: quote.challenge.requirements.amount }, wallet!.address);
      }
      if (saved) clearGatewayDeposit({ chainId: quote.challenge.chainId, asset: quote.challenge.requirements.asset, gateway: quote.challenge.requirements.extra.verifyingContract, amount: quote.challenge.requirements.amount }, wallet!.address);
      setFunding({ kind: "ready", ...balance });
    } catch (error) {
      if (!live.current) return;
      setFunding({ kind: "error", message: error instanceof Error ? error.message : "Could not check Gateway funds." });
    }
  }, [wallet]);

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
      void refreshFunding(quote);
    } catch (err) {
      if (!live.current) return;
      setState({ step: "stopped", stop: unreachableStop("quote", err) });
    }
  }, [call.lockedPriceAtoms, call.onchainCallId, refreshFunding, wallet]);

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
    if (funding.kind !== "ready" || funding.spendable < BigInt(quote.challenge.requirements.amount)) return;
    setState({ step: "signing", quote });

    // (2) Sign the EIP-3009 authorization. This is the whole identity step —
    // the address that signs is the address murmur grants decrypt access to.
    let header: string;
    let auth: { unixSeconds: number; signature: string };
    try {
      const built = buildBatchPayment({ challenge: quote.challenge, from: wallet.address });
      const { signature } = await signTypedData(built.typedData, { address: wallet.address });
      header = encodePaymentHeader({
        requirements: quote.challenge.requirements,
        authorization: built.authorization,
        signature,
        resource: accessResource(callAccessUrl(quote.onchainCallId), quote.onchainCallId),
      });
      const unixSeconds = Math.floor(Date.now() / 1000);
      const statusSignature = await signMessage(
        { message: purchasesAuthMessage(wallet.address, unixSeconds) },
        { address: wallet.address },
      );
      auth = { unixSeconds, signature: statusSignature.signature };
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
        if (Date.now() - auth.unixSeconds * 1000 >= 240_000) {
          try {
            const unixSeconds = Math.floor(Date.now() / 1000);
            const signed = await signMessage(
              { message: purchasesAuthMessage(subscriber, unixSeconds) },
              { address: subscriber },
            );
            auth = { unixSeconds, signature: signed.signature };
          } catch (error) {
            setState({
              step: "stopped",
              stop: {
                code: "StatusAuthDeclined",
                headline: "status read paused",
                detail: "Payment was already submitted. The signed status refresh was declined, so check the purchases panel before trying again.",
                tone: "dim",
                retryable: false,
              },
            });
            return;
          }
        }
        polled = await verdictApi.callAccessStatus(quote.onchainCallId, subscriber, auth);
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
  }, [funding, signMessage, signTypedData, state, wallet]);

  const deposit = useCallback(async () => {
    if (state.step !== "quoted" || !wallet || funding.kind !== "ready") return;
    const needed = BigInt(state.quote.challenge.requirements.amount);
    const shortfall = gatewayShortfall(funding, needed);
    if (shortfall === null) return;
    setFunding({ kind: "submitting" });
    let submitted = false;
    try {
      // Privy returns a fresh provider after a chain switch, so switch before retrieving it.
      await wallet.switchChain("0x66eee");
      const provider = await wallet.getEthereumProvider();
      const transactionHash = await depositGatewayUsdc(provider, wallet.address, {
        chainId: state.quote.challenge.chainId,
        asset: state.quote.challenge.requirements.asset,
        gateway: state.quote.challenge.requirements.extra.verifyingContract,
        amount: state.quote.challenge.requirements.amount,
      }, shortfall, (hash) => {
        submitted = true;
        saveGatewayDeposit({ chainId: state.quote.challenge.chainId, asset: state.quote.challenge.requirements.asset, gateway: state.quote.challenge.requirements.extra.verifyingContract, amount: state.quote.challenge.requirements.amount }, wallet.address, hash);
        if (live.current) setFunding({ kind: "submitted", transactionHash: hash });
      });
      if (!live.current) return;
      setFunding({ kind: "submitted", transactionHash });
    } catch (error) {
      if (submitted) return;
      if (!live.current) return;
      setFunding({ kind: "error", message: error instanceof Error ? error.message : "Gateway deposit failed." });
    }
  }, [funding, state, wallet]);



  const line = buyLine(state);
  const busy = isBusy(state);

  return (
    <div className="px-2 pb-2 pt-1 flex flex-col gap-2">
      <span className="flex items-center justify-between gap-3">
        <span className="ck-label ck-dim inline-flex items-center gap-1.5">
          <Ik name="x402" />
          Early access
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
          title="Buying in the browser needs a wallet to sign the payment, and this build has no Privy app id. An agent can still buy this call from its own runtime through the same endpoint."
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
          <p className="ck-dim m-0 break-all">
            fund this wallet with Arbitrum Sepolia ETH for gas and USDC: <span className="ck-mono">{wallet.address}</span>{" "}
            <button type="button" className="ck-btn ck-btn-bracket" onClick={() => void navigator.clipboard.writeText(wallet.address)}>copy</button>
          </p>

          {/* The price is stated in exactly ONE element on this page, and it is
              the label of the button that authorizes it — built from the 402's
              own quote, never from the row above. `buyLine` returns nothing for
              this step for the same reason: a second copy of a number is a
              second copy to keep in step. */}
          {state.step === "quoted" && (
            <>
              {state.stale && <p className="ck-neg m-0">{state.stale}</p>}
              {funding.kind === "checking" && <p className="ck-dim m-0">checking Circle Gateway balance…</p>}
              {funding.kind === "error" && <p className="ck-neg m-0">{funding.message}</p>}
              {funding.kind === "ready" && funding.spendable < BigInt(state.quote.challenge.requirements.amount) && (
                <p className="ck-dim m-0">
                  {funding.pending
                    ? "A Gateway deposit is pending. Wait for Circle to credit it, then refresh instead of depositing again."
                    : "Deposit the exact shortfall to Circle Gateway before paying. Credit can take several minutes and may arrive after this call's sale closes."}
                </p>
              )}
              {funding.kind === "submitted" && <p className="ck-dim m-0 break-all">Deposit submitted: <span className="ck-mono">{funding.transactionHash}</span>. Wait for Circle to credit it, then refresh the Gateway balance.</p>}
              <span className="flex flex-wrap gap-3 items-center">
                <button
                  type="button"
                  className="ck-btn ck-btn-bracket ck-pos"
                  onClick={() => void pay()}
                  disabled={funding.kind !== "ready" || funding.spendable < BigInt(state.quote.challenge.requirements.amount)}
                  title={`Signs an authorization for ${quoteLabel(state.quote)} against Circle's Gateway. Nothing is charged until murmur verifies it.`}
                >
                  <Ik name="x402" />
                  pay {quoteLabel(state.quote)}
                </button>
                <button type="button" className="ck-btn ck-btn-bracket" onClick={() => void refreshFunding(state.quote)} disabled={funding.kind === "checking" || funding.kind === "submitting"}>
                  refresh Gateway
                </button>
                {funding.kind === "ready" && funding.spendable < BigInt(state.quote.challenge.requirements.amount) && !funding.pending && (
                  <button type="button" className="ck-btn ck-btn-bracket ck-pos" onClick={() => void deposit()}>
                    deposit {formatAtoms((BigInt(state.quote.challenge.requirements.amount) - funding.spendable).toString(), "USDC")} USDC
                  </button>
                )}
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

      {state.step === "granted" && wallet && (
        <DecryptCall key={wallet.address + call.onchainCallId} wallet={wallet} onchainCallId={call.onchainCallId} marketId={call.marketId} />
      )}
    </div>
  );
}


/** Available from both checkout and purchase history, even after sales close. */
export function DecryptCall({ wallet, onchainCallId, marketId }: {
  wallet: ConnectedWallet;
  onchainCallId: string;
  marketId?: string;
}) {
  const [decrypted, setDecrypted] = useState<{ binaryIndex: bigint; confidenceBps: bigint; outcomeLabel: string } | null>(null);
  const [decryptError, setDecryptError] = useState<string | null>(null);
  const [decrypting, setDecrypting] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const decrypt = useCallback(async () => {
    if (!wallet) return;
    setDecrypting(true);
    setDecryptError(null);
    try {
      const response = await verdictApi.callAccessStatus(onchainCallId, wallet.address);
      const details = response.body as AccessDetails;
      const binary = details.ciphertexts?.binaryIndex?.handle;
      const confidence = details.ciphertexts?.confidenceBps?.handle;
      if (
        response.status !== 200 ||
        details.grant?.onchainGranted !== true ||
        details.chainId !== 421614 ||
        details.callId?.toLowerCase() !== onchainCallId.toLowerCase() ||
        !/^0x[\da-f]{40}$/i.test(details.contract ?? "") ||
        !binary ||
        !confidence
      ) {
        throw new Error("This call is not ready to decrypt for this wallet on Arbitrum Sepolia.");
      }
      await wallet.switchChain("0x66eee");
      const provider = await wallet.getEthereumProvider();
      const result = await decryptGrantedCall({ provider, address: wallet.address, chainId: details.chainId, binaryIndexCtHash: binary, confidenceCtHash: confidence });
      if (result.binaryIndex !== 0n && result.binaryIndex !== 1n) throw new Error(`Invalid binary outcome index ${result.binaryIndex}.`);
      if (result.confidenceBps < 0n || result.confidenceBps > 10_000n) throw new Error(`Invalid confidence ${result.confidenceBps} bps.`);
      let outcomeLabel = "outcome";
      try {
        const market = marketId ? await verdictApi.market(marketId) : null;
        const outcomes = market ? parseMarketConfig(market.market)?.outcomes : undefined;
        if (typeof outcomes?.[Number(result.binaryIndex)] === "string") outcomeLabel = outcomes[Number(result.binaryIndex)];
      } catch {
        // The decrypt is still true if venue labels are temporarily unavailable.
      }
      if (!live.current) return;
      setDecrypted({ ...result, outcomeLabel });
    } catch (error) {
      if (live.current) setDecryptError(error instanceof Error ? error.message : "Could not decrypt this call.");
    } finally {
      if (live.current) setDecrypting(false);
    }
  }, [marketId, onchainCallId, wallet]);

  return (
    <div className="flex flex-col gap-2 items-start">
      <button type="button" className="ck-btn ck-btn-bracket ck-pos" onClick={() => void decrypt()} disabled={decrypting}>
        {decrypting ? "decrypting locally…" : "decrypt locally"}
      </button>
      {decryptError && <p className="ck-neg m-0">{decryptError}</p>}
      {decrypted && <p className="ck-pos m-0">prediction: {decrypted.outcomeLabel} (index {decrypted.binaryIndex}) · confidence: {(Number(decrypted.confidenceBps) / 100).toFixed(2)}%</p>}
    </div>
  );
}
