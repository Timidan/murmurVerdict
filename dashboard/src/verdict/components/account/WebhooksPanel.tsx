// Webhooks — murmur posts to your server when something happens to a call.
//
// The signing secret is returned exactly once, at creation, and is never
// retrievable afterwards. That is the same one-shot contract a minted key
// carries, so this panel uses the same idiom: a modal that appears on success,
// says plainly that this is the only time, and offers a copy button.
//
// Deleting works by OWNERSHIP, not by the secret. An owner who closed the
// secret dialog can still manage their own subscriptions, which is the whole
// reason /v1/account/webhooks exists.

import { useCallback, useEffect, useRef, useState } from "react";
import { getAccessToken } from "@privy-io/react-auth";

import {
  verdictApi,
  type AccountAgent,
  type AccountWebhookRow,
  type CreateWebhookResponse,
} from "../../api.js";
import { Ik } from "../../icons.js";
import { formatLocalDateTime } from "../../lib/date-time-format.js";
import { InlineError } from "../compact/InlineError.js";
import { useFocusTrap } from "../compact/useFocusTrap.js";

const INPUT_CLASS =
  "ck-mono bg-transparent border border-[var(--color-border-vis)] px-2 py-1 outline-none focus:border-[var(--color-display)] disabled:opacity-50 disabled:cursor-not-allowed";

/**
 * Every delivery carries both events. There is no per-event switch on the
 * wire, so this list is stated as a fact rather than offered as a control —
 * a checkbox that changes nothing is worse than no checkbox.
 */
const DELIVERED_EVENTS = ["call.accepted", "call.resolved"] as const;

export function WebhooksPanel({ agents }: { agents: AccountAgent[] }) {
  const [rows, setRows] = useState<AccountWebhookRow[]>([]);
  const [url, setUrl] = useState("");
  const [scope, setScope] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateWebhookResponse | null>(null);

  const named = agents.filter((a) => a.display_slug !== null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const token = await getAccessToken();
      if (!token) {
        setError("Your session expired. Sign in again.");
        return;
      }
      const { webhooks } = await verdictApi.getAccountWebhooks(token);
      setRows(webhooks);
    } catch (e) {
      setError((e as Error)?.message ?? "unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Default the scope to the only agent, when there is only one. Asking a
  // one-agent owner to pick from a list of one is a question with no content.
  useEffect(() => {
    if (scope === "" && named.length === 1) {
      setScope(named[0]!.display_slug!);
    }
  }, [named, scope]);

  const create = useCallback(async () => {
    setError(null);
    const target = url.trim();
    if (!target) {
      setError("Enter the URL murmur should post to.");
      return;
    }
    if (!scope) {
      setError("Pick which agent this webhook follows.");
      return;
    }
    setBusy(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Your session expired. Sign in again.");
      const result = await verdictApi.postWebhook(token, {
        agent_slug: scope,
        url: target,
      });
      setCreated(result);
      setUrl("");
      await refresh();
    } catch (e) {
      setError((e as Error)?.message ?? "unknown error");
    } finally {
      setBusy(false);
    }
  }, [url, scope, refresh]);

  const remove = useCallback(
    async (id: string) => {
      setError(null);
      setBusy(true);
      try {
        const token = await getAccessToken();
        if (!token) throw new Error("Your session expired. Sign in again.");
        await verdictApi.deleteAccountWebhook(token, id);
        await refresh();
      } catch (e) {
        setError((e as Error)?.message ?? "unknown error");
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return (
    <section className="ck-frame">
      <div className="ck-header">
        <span className="ck-title ck-title-ik">
          <Ik name="webhook" /> Webhooks
        </span>
        <span className="ck-mono ck-dim">{rows.length} active</span>
      </div>

      <div className="px-3 py-3 flex flex-col gap-3">
        {/* The signing detail lives on the line rather than above it — a
            subscriber who needs it hovers, everyone else reads four words. */}
        <p
          className="ck-dim text-[12px]"
          title="Every delivery is signed, so your server can verify murmur sent it. Each subscription receives both events."
        >
          Signed POST on{" "}
          <span className="ck-mono">{DELIVERED_EVENTS.join(" · ")}</span>
        </p>

        {named.length === 0 ? (
          <p className="ck-mono ck-dim">Add an agent first.</p>
        ) : (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label className="ck-mono flex flex-col gap-1 w-[40ch] max-w-full min-w-0">
              <span className="ck-label ck-pos">URL</span>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.currentTarget.value)}
                placeholder="https://your-server.example/murmur"
                disabled={busy}
                className={`${INPUT_CLASS} min-w-0`}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="ck-label ck-pos">Agent</span>
              <select
                value={scope}
                onChange={(e) => setScope(e.currentTarget.value)}
                disabled={busy}
                className="ck-mono ck-select"
              >
                <option value="">pick an agent</option>
                {named.map((a) => (
                  <option key={a.agent_id} value={a.display_slug!}>
                    {a.display_slug}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="ck-btn ck-btn-bracket ck-pos"
              disabled={busy}
            >
              <Ik name="webhook" />
              add the webhook
            </button>
          </form>
        )}

        {error && <InlineError error={error} className="text-[12px]" />}

        {loading && rows.length === 0 ? (
          <p className="ck-dim text-[12px]">Loading your webhooks.</p>
        ) : rows.length === 0 ? (
          <p className="ck-mono ck-dim">No webhooks yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)] border border-[var(--color-border)]">
            {rows.map((row) => (
              <li
                key={row.id}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-3 px-3 py-2"
              >
                <span className="min-w-0">
                  <span className="ck-mono truncate block" title={row.url}>
                    {row.url}
                  </span>
                  <span className="ck-dim text-[12px]">
                    {row.agent_slug} · added{" "}
                    {formatLocalDateTime(row.created_at) ?? row.created_at}
                  </span>
                </span>
                <span className="text-right text-[12px]">
                  <span className={row.failure_count > 0 ? "ck-neg" : "ck-dim"}>
                    {row.delivery_count} sent · {row.failure_count} failed
                  </span>
                  <span className="ck-dim block">
                    {row.last_delivery_at
                      ? `last ${formatLocalDateTime(row.last_delivery_at)}`
                      : "no deliveries yet"}
                  </span>
                </span>
                {/* Every row's button reads "delete", so the accessible name
                    carries the URL too — otherwise a screen reader hears the
                    same word N times with no way to tell the rows apart. The
                    label still starts with the visible word. */}
                <button
                  type="button"
                  className="ck-btn ck-btn-bracket"
                  onClick={() => void remove(row.id)}
                  disabled={busy}
                  title={`delete the webhook for ${row.url}`}
                  aria-label={`delete the webhook for ${row.url}`}
                >
                  <Ik name="revoke" />
                  delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {created && (
        <WebhookSecretModal created={created} onClose={() => setCreated(null)} />
      )}
    </section>
  );
}

/**
 * The one and only time the signing secret is visible.
 *
 * Same shape as the api-key and runtime-key mint modals: it is not dismissible
 * by accident, it says outright that the value will not be shown again, and
 * the copy button is the primary action.
 */
function WebhookSecretModal({
  created,
  onClose,
}: {
  created: CreateWebhookResponse;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const copyRef = useRef<HTMLButtonElement | null>(null);
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(created.secret).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  }, [created.secret]);

  // Same focus lifecycle as the key-reveal modals: move focus in on mount,
  // return it on unmount, and keep Tab inside while it is open.
  useEffect(() => {
    const prevFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (copyRef.current ?? panelRef.current)?.focus();
    return () => {
      prevFocus?.focus();
    };
  }, []);
  useFocusTrap(panelRef);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-3"
      role="dialog"
      aria-modal="true"
      aria-labelledby="webhook-secret-title"
    >
      <section
        ref={panelRef}
        tabIndex={-1}
        className="ck-frame-strong max-w-[560px] w-full bg-[var(--color-bg)] outline-none"
      >
        <div className="ck-header">
          <span id="webhook-secret-title" className="ck-title ck-title-ik">
            <Ik name="webhook" /> Your signing secret
          </span>
        </div>
        <div className="px-4 py-4 flex flex-col gap-3">
          <p className="ck-neg text-[12px]">
            Copy this now. Murmur shows it once and cannot show it again.
          </p>
          <code className="ck-mono break-all border border-[var(--color-border-vis)] px-2 py-2">
            {created.secret}
          </code>
          <p className="ck-dim text-[12px]">
            Murmur signs every delivery with this secret and sends the signature
            in the <span className="ck-mono">{created.verify_signature.header}</span>{" "}
            header. Your server hashes the raw request body with the secret and
            compares. A request that does not match did not come from murmur.
          </p>
          <span className="flex gap-2">
            <button
              type="button"
              ref={copyRef}
              onClick={copy}
              className="ck-btn ck-btn-bracket ck-pos"
            >
              <Ik name="copy" />
              {copied ? "copied" : "copy the secret"}
            </button>
            <button type="button" onClick={onClose} className="ck-btn ck-btn-bracket">
              I saved it
            </button>
          </span>
        </div>
      </section>
    </div>
  );
}
