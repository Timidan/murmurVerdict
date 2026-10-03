// ─── DestinationAddressForm — payout target editor ─────────────────────────
//
// Lives at #/account/agent/:slug/payout. Lets the casual-tier operator
// bind/update the EVM address that scored-call settlement proceeds
// eventually land at. Payout execution remains deferred, but declaring the
// address is still required so the protocol knows where to park funds.
//
// Server-side invariants reflected here:
//   · Address normalized to lowercase 0x+40hex (matches WalletAddressSchema).
//   · 24h cooldown between updates (V2 §7.4). Backend returns 429 with
//     `retry_after_seconds`. We never trust client time alone — the
//     countdown is seeded from server-provided `updated_at` on load + on
//     successful PATCH, and the live tick is just a UI projection.
//
// UI promise:
//   · After a successful PATCH, show "saved · cooldown 24h" with a
//     decreasing countdown (no spinner, no banner — just dim text).
//   · After a 429 cooldown response, swap the submit button for a dim
//     "next change in 23h 12m 04s" + disable until the countdown clears.
//   · Inline `[error] not a valid evm address` on blur with bad regex input.

import { useCallback, useEffect, useMemo, useState } from "react";
import { getAccessToken } from "@privy-io/react-auth";
import { ApiError, verdictApi, type DestinationCooldownError } from "../../api.js";
import { useFunnelEmit } from "../../hooks/useFunnelEmit.js";
import { InlineError } from "../compact/InlineError.js";

const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const EVM_REGEX = /^0x[0-9a-fA-F]{40}$/;

export interface DestinationAddressFormProps {
  slug: string;
  /** Current address pulled from /v1/account/agents (null if never set). */
  currentAddress: string | null;
  /** ISO timestamp of last successful update (null if never). */
  updatedAt: string | null;
  /** Fires after a successful PATCH so the parent can refresh its cache. */
  onSaved: () => void;
}

/**
 * Format a positive duration as "Xh Ym Zs". Negative or zero values
 * render as "0s" — the caller decides whether to render the countdown
 * at all (typically gated on `secondsRemaining > 0`).
 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  // Pad seconds + minutes for steady-width readout (no layout shift).
  const ss = String(s).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  return `${h}h ${mm}m ${ss}s`;
}

/**
 * Compute current cooldown-remaining ms given a `last update` ISO.
 * Returns 0 when the cooldown is over OR when last is null/unparseable.
 */
function cooldownRemainingMs(lastIso: string | null, nowMs: number): number {
  if (!lastIso) return 0;
  const last = Date.parse(lastIso);
  if (!Number.isFinite(last)) return 0;
  return Math.max(0, COOLDOWN_MS - (nowMs - last));
}

export function DestinationAddressForm({
  slug,
  currentAddress,
  updatedAt,
  onSaved,
}: DestinationAddressFormProps) {
  const emitFunnel = useFunnelEmit();
  const [input, setInput] = useState("");
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Address shown as "current". Updated optimistically on success so the
  // form reflects the new state without refetching the parent.
  const [shownAddress, setShownAddress] = useState<string | null>(currentAddress);
  // The active `updatedAt` ISO. Seeded from props, overwritten on:
  //   · successful PATCH → server-returned `destination_address_updated_at`
  //   · 429 PATCH        → derived as (now - (COOLDOWN_MS - retry*1000))
  const [lastUpdatedIso, setLastUpdatedIso] = useState<string | null>(updatedAt);
  // Wall clock tick — updated every 1s so the countdown re-renders.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [serverError, setServerError] = useState<string | null>(null);

  // Sync with parent if the list refetches.
  useEffect(() => {
    setShownAddress(currentAddress);
  }, [currentAddress]);
  useEffect(() => {
    setLastUpdatedIso(updatedAt);
  }, [updatedAt]);

  // 1Hz tick — only mounted while the cooldown is active so unmount
  // cleanly stops the interval (no memory leak on long-dwell pages).
  const remaining = cooldownRemainingMs(lastUpdatedIso, nowMs);
  useEffect(() => {
    if (remaining <= 0) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [remaining > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // Client-side regex (case-insensitive) — backend is authoritative on
  // the lowercase form, so we lowercase the value before POSTing.
  const validation = useMemo(() => {
    const v = input.trim();
    if (v.length === 0) return { ok: false, reason: "required" as const };
    if (!EVM_REGEX.test(v))
      return { ok: false, reason: "That is not a valid EVM address." as const };
    return { ok: true as const };
  }, [input]);

  const inlineError =
    touched && !validation.ok ? validation.reason ?? null : null;

  const cooldownActive = remaining > 0;
  const canSubmit = !submitting && !cooldownActive && validation.ok;

  /**
   * Convert an ApiError into a user-facing string. On 429 we ALSO update
   * `lastUpdatedIso` so the countdown starts immediately — without this,
   * the user would have to refresh to see the cooldown surface.
   */
  const explainError = useCallback((err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.status === 429) {
        // Parse retry_after_seconds out of the JSON body.
        let retry: number | null = null;
        try {
          const body = JSON.parse(err.rawBody) as DestinationCooldownError;
          if (typeof body.retry_after_seconds === "number") {
            retry = body.retry_after_seconds;
          }
        } catch {
          /* fall through — show generic 429 */
        }
        if (retry !== null) {
          // Derive a synthetic last-update timestamp so the countdown
          // matches the backend's view: cooldown ends at now + retry,
          // so last-update = now + retry - COOLDOWN_MS.
          const synth = new Date(Date.now() + retry * 1000 - COOLDOWN_MS);
          setLastUpdatedIso(synth.toISOString().replace(/\.\d+Z$/, "Z"));
        }
        return "You changed this recently. See the countdown below.";
      }
      if (err.status === 401 || err.status === 403)
        return "Your session expired. Sign in again.";
      if (err.status === 400) return "That is not a valid address.";
      if (err.status === 404) return "We cannot find that agent.";
    }
    return `We could not save the address: ${(err as Error).message ?? "unknown"}`;
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!canSubmit) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setServerError("Your session expired. Sign in again.");
        return;
      }
      // Send the lowercase form (backend requires it). The form
      // stores/uses the lowercase value going forward too.
      const next = input.trim().toLowerCase();
      const res = await verdictApi.patchDestinationAddress(token, slug, next);
      setShownAddress(res.destination_address);
      setLastUpdatedIso(res.destination_address_updated_at);
      setInput("");
      setTouched(false);
      // Funnel emit — fire-and-forget after the patch round
      // trip succeeds. We don't include the address itself (PII-adjacent
      // — a payout address is on-chain public but the funnel store
      // doesn't need it to derive conversion). The slug attribute lets
      // funnel queries group by agent without joining usage_events.agent_id
      // (which is null on these account-scoped emits).
      void emitFunnel("destination.set", { slug });
      onSaved();
    } catch (e) {
      setServerError(explainError(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className="ck-frame w-full flex flex-col"
      noValidate
    >
      <div className="ck-header">
        <span className="ck-title">Where your payouts go</span>
      </div>

      <div className="px-4 py-4 flex flex-col gap-4">
        {/* ── Current address readout ───────────────────────────────── */}
        <div className="flex flex-col gap-1">
          <span className="ck-label ck-pos">Current</span>
          {shownAddress ? (
            <code
              className="ck-mono self-start w-[46ch] max-w-full break-all px-2 py-1 border border-[var(--color-border)]"
              style={{ userSelect: "all" }}
            >
              {shownAddress}
            </code>
          ) : (
            <span className="ck-mono ck-dim">not set — murmur holds the funds</span>
          )}
        </div>

        {/* ── Editor ─────────────────────────────────────────────── */}
        <label className="flex flex-col gap-1">
          <span className="ck-label ck-pos">New address</span>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.currentTarget.value)}
            onBlur={() => setTouched(true)}
            placeholder="0x…"
            maxLength={42}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={cooldownActive || submitting}
            className="ck-mono self-start w-[46ch] max-w-full min-w-0 bg-transparent border border-[var(--color-border-vis)] px-2 py-1 outline-none focus:border-[var(--color-display)] disabled:opacity-50 disabled:cursor-not-allowed"
            aria-invalid={inlineError !== null}
            aria-describedby="addr-help"
          />
          <span id="addr-help" className="ck-dim text-[12px]">
            An EVM address: 0x and 40 hex characters. Case does not matter.
          </span>
          {inlineError && (
            <InlineError error={inlineError} className="text-[12px]" />
          )}
        </label>

        {/* ── Cooldown / status row ─────────────────────────────── */}
        {cooldownActive && (
          <p
            className="text-[12px]"
            style={{ color: "var(--color-accent-ink)" }}
            aria-live="polite"
          >
            You can change this again in {formatDuration(remaining)}.
          </p>
        )}
        {!cooldownActive && lastUpdatedIso && (
          <p className="ck-pos text-[12px]" aria-live="polite">
            Saved. You can change it again now.
          </p>
        )}
        {serverError && (
          <InlineError
            error={serverError}
            className="ck-frame-strong px-3 py-2 ck-mono"
          />
        )}

        <div className="flex items-center gap-2 pt-2">
          <button
            type="submit"
            disabled={!canSubmit}
            className="ck-btn ck-btn-bracket ck-pos justify-center disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="update address"
          >
            save the address →
          </button>
          {submitting && <span className="ck-dim text-[12px]">Saving…</span>}
        </div>
      </div>
    </form>
  );
}
