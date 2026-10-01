import { TopbarCrumb } from "../components/compact/TopbarCrumb.js";
import { RecoveryLinks } from "../components/compact/ErrorState.js";

interface NotFoundPageProps {
  /** The unmatched path from parseLocation — echoed so users can spot typos. */
  path?: string;
}

/** 404 page for the router's `not_found` fallback. No API calls. */
export function NotFoundPage({ path }: NotFoundPageProps) {
  const attempted = path && path.length > 0 ? path : window.location.pathname;
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopbarCrumb>404</TopbarCrumb>
      <main className="px-2 py-3 ck-mono">
        <div className="ck-label ck-dim mb-1">404</div>
        <div className="ck-title">Page not found</div>
        <div className="ck-mono ck-dim mt-1 max-w-[52ch] truncate" title={attempted}>
          {attempted}
        </div>
        <p className="ck-mono ck-dim mt-1 leading-tight">
          Nothing lives at this address. Check the URL, or use a link below.
        </p>
        <div className="mt-2">
          <RecoveryLinks />
        </div>
      </main>
    </div>
  );
}
