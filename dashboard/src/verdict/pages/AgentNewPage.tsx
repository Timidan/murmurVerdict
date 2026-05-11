// ─── AgentNewPage — declare a new casual-tier agent (Phase 7b) ─────────────
//
// Route: #/account/agent/new. Auth-gated via AccountShell (Phase 7a).
//
// Three inputs: display_slug, display_name, bio. Frontend validation mirrors
// the backend's AgentSlugSchema (src/verdict/schema.ts) so users see slug
// problems inline before the round-trip. The server is still authoritative —
// reserved/duplicate slugs come back as 409 and we surface them in the same
// inline error slot.
//
// On a successful 201 from POST /v1/account/agents we mint an API key via
// POST /v1/account/agents/:slug/api-keys and open ApiKeyMintModal. The key
// plaintext is revealed exactly once — see modal for footgun protections.
//
// On modal DONE: refresh the account agents list (so AccountPage shows the
// new row) and navigate back to /account. Phase 7d will add the per-agent
// /integrate page; routing there now would land on the public agent profile
// instead of the snippet panel, so we close the loop at /account.

import { useEffect, useMemo, useState } from "react";
import { getAccessToken } from "@privy-io/react-auth";
import { CompactTopbar } from "../components/compact/Topbar.js";
import { ApiKeyMintModal } from "../components/account/ApiKeyMintModal.js";
import { useAccount } from "../hooks/useAccount.js";
import { ApiError, verdictApi, type MintApiKeyResponse } from "../api.js";

const SLUG_MAX = 32;
const NAME_MAX = 64;
const BIO_MAX = 280;

/**
 * Mirror src/verdict/schema.ts:AgentSlugSchema for inline UX. The backend
 * remains authoritative — reserved + duplicate slugs are validated server-
 * side and surfaced via 409.
 */
function validateSlug(input: string): { ok: boolean; reason?: string } {
  const s = input.trim();
  if (s.length === 0) return { ok: false, reason: "required" };
  if (s.length < 3) return { ok: false, reason: "min 3 chars" };
  if (s.length > SLUG_MAX) return { ok: false, reason: `max ${SLUG_MAX} chars` };
  if (/[A-Z]/.test(s)) return { ok: false, reason: "lowercase only" };
  if (/[^a-z0-9-]/.test(s))
    return { ok: false, reason: "letters, digits, single dashes only" };
  if (s.startsWith("-") || s.endsWith("-"))
    return { ok: false, reason: "no leading or trailing dash" };
  if (s.includes("--")) return { ok: false, reason: "no double dashes" };
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s))
    return { ok: false, reason: "invalid format" };
  return { ok: true };
}

function suggestSuffixed(slug: string): string {
  // Backend collision → suggest `${slug}-2` per the UX brief. Truncate so
  // the suggestion still passes the 32-char cap.
  const base = slug.length > SLUG_MAX - 2 ? slug.slice(0, SLUG_MAX - 2) : slug;
  return `${base}-2`;
}

interface MintedState {
  result: MintApiKeyResponse;
  slug: string;
}

export function AgentNewPage() {
  const account = useAccount();

  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [minted, setMinted] = useState<MintedState | null>(null);

  // Auth gate — bounce to login if Privy reports a stable signed-out state.
  // Same pattern as AccountPage; we never render the form when unauthed.
  useEffect(() => {
    if (!account.ready) return;
    if (account.isAuthenticated) return;
    const next = encodeURIComponent("/account/agent/new");
    window.location.hash = `#/account/login?next=${next}`;
  }, [account.ready, account.isAuthenticated]);

  const slugValidation = useMemo(() => validateSlug(slug), [slug]);
  const slugError = slugTouched && !slugValidation.ok ? slugValidation.reason ?? null : null;

  // Effective display name — defaults to the slug with hyphens → spaces if
  // the user didn't type one. Computed at submit time so the input remains
  // empty (placeholder visible) until they type.
  const effectiveName = name.trim() || slug.replace(/-/g, " ").trim();
  const nameLen = effectiveName.length;
  const bioLen = bio.length;
  const formReady =
    slugValidation.ok &&
    nameLen >= 1 &&
    nameLen <= NAME_MAX &&
    bioLen <= BIO_MAX &&
    !submitting;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSlugTouched(true);
    if (!formReady) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setServerError("no_access_token — try signing in again");
        return;
      }
      const trimmedBio = bio.trim();
      const created = await verdictApi.postCreateAgent(token, {
        display_slug: slug,
        display_name: effectiveName,
        ...(trimmedBio ? { bio: trimmedBio } : {}),
      });
      // Mint the first API key immediately — the user's mental model is
      // "I just made an agent, give me the credential". This is the
      // single moment we ever surface the plaintext key.
      const mint = await verdictApi.postMintApiKey(token, created.display_slug);
      setMinted({ result: mint, slug: created.display_slug });
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 409) {
          // Backend returns 409 for both "duplicate" and "reserved" slugs
          // (the server folds reserved-list rejections into the same
          // UNIQUE-style error path). We can't always distinguish, so
          // surface a single message + suggest a `-2` suffix.
          setServerError(`× taken — try ${suggestSuffixed(slug)}`);
          return;
        }
        if (e.status === 400) {
          setServerError("× invalid input — check the slug format");
          return;
        }
        if (e.status === 401 || e.status === 403) {
          setServerError("× session expired — sign in again");
          return;
        }
        if (e.status === 429) {
          setServerError("× too many attempts — wait a minute and retry");
          return;
        }
      }
      setServerError(`× create failed: ${(e as Error).message ?? "unknown"}`);
    } finally {
      setSubmitting(false);
    }
  };

  const onModalDone = () => {
    // Refresh the agents list so AccountPage shows the new row. We don't
    // await — navigation happens immediately and the hook flushes the
    // result by the time AccountPage's useEffect lands.
    void account.refreshAgents();
    setMinted(null);
    // Phase 7d will own /integrate — until then, close the loop at /account.
    window.location.hash = "#/account";
  };

  if (!account.configured) {
    return <ConfigErrorShell />;
  }

  if (!account.ready || !account.isAuthenticated) {
    return <LoadingShell />;
  }

  return (
    <div className="compact-shell min-h-dvh flex flex-col">
      <CompactTopbar
        crumb={
          <span>
            <a href="#/account" className="ck-dim hover:ck-pos no-underline">
              ACCOUNT
            </a>
            <span className="ck-dim mx-1">/</span>
            <span className="ck-pos">NEW AGENT</span>
          </span>
        }
      />

      <main className="flex-1 px-3 py-4 flex flex-col items-center">
        <form
          onSubmit={onSubmit}
          className="ck-frame w-full max-w-[560px] flex flex-col"
          noValidate
        >
          <div className="ck-header">
            <span className="ck-label ck-pos">DECLARE AGENT · CASUAL TIER</span>
            <span className="ck-mono ck-dim">PRIVATE</span>
          </div>

          <div className="px-4 py-4 flex flex-col gap-4">
            {/* ── display_slug ───────────────────────────────────────── */}
            <label className="flex flex-col gap-1">
              <span className="ck-label ck-pos">SLUG</span>
              <input
                type="text"
                value={slug}
                onChange={(e) => setSlug(e.currentTarget.value.toLowerCase())}
                onBlur={() => setSlugTouched(true)}
                placeholder="my-agent"
                maxLength={SLUG_MAX}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                className="ck-mono bg-transparent border border-[var(--color-border-vis)] px-2 py-1 outline-none focus:border-[var(--color-display)]"
                aria-invalid={slugError !== null}
                aria-describedby="slug-help"
              />
              <span id="slug-help" className="ck-mono ck-dim text-[10px]">
                3–32 chars · lowercase · letters, digits, single dashes ·{" "}
                {slug.length}/{SLUG_MAX}
              </span>
              {slugError && (
                <span
                  className="ck-mono text-[10px]"
                  style={{ color: "var(--color-accent)" }}
                >
                  × {slugError}
                </span>
              )}
            </label>

            {/* ── display_name ──────────────────────────────────────── */}
            <label className="flex flex-col gap-1">
              <span className="ck-label ck-pos">DISPLAY NAME</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                placeholder={slug.replace(/-/g, " ") || "MY AGENT"}
                maxLength={NAME_MAX}
                autoComplete="off"
                className="ck-mono uppercase bg-transparent border border-[var(--color-border-vis)] px-2 py-1 outline-none focus:border-[var(--color-display)]"
              />
              <span className="ck-mono ck-dim text-[10px]">
                defaults to slug · {name.length}/{NAME_MAX}
              </span>
            </label>

            {/* ── bio ───────────────────────────────────────────────── */}
            <label className="flex flex-col gap-1">
              <span className="ck-label ck-pos">BIO · OPTIONAL</span>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.currentTarget.value)}
                placeholder="one-line description of what this agent does."
                maxLength={BIO_MAX}
                rows={3}
                className="ck-mono bg-transparent border border-[var(--color-border-vis)] px-2 py-1 outline-none focus:border-[var(--color-display)] resize-none"
              />
              <span className="ck-mono ck-dim text-[10px] self-end">
                {bioLen}/{BIO_MAX}
              </span>
            </label>

            {serverError && (
              <div
                className="ck-frame-strong px-3 py-2 ck-mono"
                style={{ color: "var(--color-accent)" }}
                role="alert"
              >
                {serverError}
              </div>
            )}

            <div className="flex items-center gap-2 pt-2">
              <a href="#/account" className="ck-btn">
                [ ← BACK ]
              </a>
              <button
                type="submit"
                disabled={!formReady}
                className="ck-btn ck-btn-accent justify-center disabled:opacity-40 disabled:cursor-not-allowed"
              >
                [ MINT AGENT → ]
              </button>
              {submitting && (
                <span className="ck-mono ck-dim text-[10px]">working…</span>
              )}
            </div>
          </div>
        </form>
      </main>

      {minted && (
        <ApiKeyMintModal
          result={minted.result}
          slug={minted.slug}
          onDone={onModalDone}
        />
      )}
    </div>
  );
}

function LoadingShell() {
  return (
    <div className="compact-shell min-h-dvh flex flex-col">
      <CompactTopbar crumb={<span className="ck-pos">NEW AGENT</span>} />
      <main className="flex-1 px-3 py-3 max-w-[560px] w-full mx-auto">
        <div className="ck-frame px-4 py-6">
          <p className="ck-mono ck-dim">loading…</p>
        </div>
      </main>
    </div>
  );
}

function ConfigErrorShell() {
  return (
    <div className="compact-shell min-h-dvh flex flex-col">
      <CompactTopbar crumb={<span className="ck-neg">NEW AGENT · UNCONFIGURED</span>} />
      <main className="flex-1 px-3 py-3 max-w-[560px] w-full mx-auto">
        <section className="ck-frame-strong px-4 py-4">
          <p className="ck-mono ck-neg">privy not configured.</p>
          <p className="ck-mono ck-dim mt-2 text-[10px]">
            set <code>VITE_PRIVY_APP_ID</code> in dashboard/.env.local and rebuild.
          </p>
        </section>
      </main>
    </div>
  );
}
