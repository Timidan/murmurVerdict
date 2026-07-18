import { CompactTopbar } from "../components/compact/Topbar.js";
import { RecoveryLinks } from "../components/compact/ErrorState.js";

interface NotFoundPageProps {
  /** The unmatched path from parseLocation — echoed so users can spot typos. */
  path?: string;
}

/**
 * Real 404 surface — rendered by the router's `not_found` fallback instead of
 * silently painting the landing page under an unknown URL. Static page: no
 * API calls of its own; CompactTopbar supplies the shared cockpit chrome.
 * Error idiom mirrors MarketDetailPage's local NotFound block.
 */
export function NotFoundPage({ path }: NotFoundPageProps) {
  const attempted = path && path.length > 0 ? path : window.location.pathname;
  return (
    <div className="mmr-shell min-h-dvh flex flex-col">
      <CompactTopbar crumb="404" />
      <main className="px-2 py-3 ck-mono">
        <div className="ck-label ck-dim mb-1">404</div>
        <div className="ck-pos" style={{ fontSize: 14, fontWeight: 700 }}>
          page not found
        </div>
        <div className="ck-mono ck-dim mt-1 max-w-[52ch] truncate" title={attempted}>
          {attempted}
        </div>
        <p className="ck-mono ck-dim mt-1 leading-tight">
          Nothing is routed at this address — check the URL, or jump back in below.
        </p>
        <div className="mt-2">
          <RecoveryLinks />
        </div>
      </main>
    </div>
  );
}
