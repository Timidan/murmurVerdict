/**
 * Shared COMPACT error / empty surface. Turns a raw developer string
 * (`GET /v1/agents/x → 404`) into a humane, recoverable page: a quiet status
 * word, a plain-language headline, the looked-up id, a one-line explanation,
 * bracket recovery links, and the technical string tucked into a collapsed
 * <details> — never in the headline. Reused by AgentPage, CallPage and (for
 * generic errors) MarketDetailPage so every miss reads the same way.
 */

interface ErrorStateProps {
  /** `not_found` → "404 / <what> not found"; `error` → "error / couldn't load this <what>". */
  kind: "not_found" | "error";
  /** Subject noun folded into the headline, e.g. "agent", "call", "market". */
  what: string;
  /** The looked-up id/slug — rendered mono + truncated, full value on hover. */
  id?: string;
  /** Raw technical string (method/path/status). Collapsed only; never headline. */
  detail?: string;
}

export function ErrorState({ kind, what, id, detail }: ErrorStateProps) {
  const status = kind === "not_found" ? "404" : "error";
  const headline =
    kind === "not_found" ? `${what} not found` : `we could not load this ${what}`;
  const oneLiner =
    kind === "not_found"
      ? `Nothing is registered under this ${what} id. It may be retired, renamed, or mistyped.`
      : `The request did not go through. This usually clears up on its own. Try again, or use a link below.`;

  return (
    <div className="px-2 py-3 ck-mono">
      <div className="ck-label ck-dim mb-1">{status}</div>
      {/* T1 (18px) — the headline has to out-rank the body under it. It used to
          be `ck-value-lg` (15px) sitting directly above 16px `ck-mono` lines, so
          the explanation read LOUDER than the thing it explains. `ck-title` is
          the shipped tier for the head of a region and carries display ink of
          its own, which is why the `ck-pos` that used to supply that ink is
          gone. Not an <h1>: in-shell an h1 has to out-rank ck-title (21px), and
          this block is a state headline inside a page, not the page's title. */}
      <div className="ck-title">{headline}</div>
      {id && (
        <div className="ck-mono ck-dim mt-1 truncate" title={id}>
          {id}
        </div>
      )}
      <p className="ck-mono ck-dim mt-1 leading-tight max-w-[56ch]">{oneLiner}</p>
      <div className="mt-2">
        <RecoveryLinks />
      </div>
      {detail && (
        <details className="mt-3">
          <summary className="ck-label ck-dim cursor-pointer select-none">
            technical detail
          </summary>
          <pre className="details-fade ck-mono ck-dim mt-1 whitespace-pre-wrap break-all leading-tight">
            {detail}
          </pre>
        </details>
      )}
    </div>
  );
}

/**
 * Canonical recovery link row — home / dashboard / leaderboard as bracket
 * buttons. Exported so surfaces that keep their own not-found layout (e.g.
 * MarketDetailPage's <NotFound/>) can align their link row with the shared set.
 */
export function RecoveryLinks() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <a href="#/" className="ck-btn ck-btn-bracket">
        ← home
      </a>
      <a href="#/dashboard" className="ck-btn ck-btn-bracket">
        dashboard
      </a>
      <a href="#/leaderboard" className="ck-btn ck-btn-bracket">
        leaderboard
      </a>
    </div>
  );
}
