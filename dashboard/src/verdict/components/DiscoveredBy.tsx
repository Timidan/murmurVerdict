import { useEffect, useState } from "react";
import { verdictApi } from "../api.js";

interface Discoverer {
  ref: string;
  total: number;
  first_at: string;
  last_at: string;
}

interface DiscoveredByProps {
  slug: string;
}

/**
 * Compact attribution strip on an agent profile. Renders the top 3
 * referrers (by click count) as inline mono chips, prefixed by "discovered by".
 *
 * Hidden when no one has shared this agent yet — empty network is not
 * a failure state, it's just absence of signal.
 */
export function DiscoveredBy({ slug }: DiscoveredByProps) {
  const [rows, setRows] = useState<Discoverer[]>([]);

  useEffect(() => {
    let cancel = false;
    verdictApi
      .discoverers(slug, 3)
      .then((r) => {
        if (cancel) return;
        setRows(
          r.discoverers.map((d) => ({
            ref: d.ref,
            total: d.total,
            first_at: d.first_at,
            last_at: d.last_at,
          })),
        );
      })
      .catch(() => {
        // best-effort — absence of attribution data shouldn't break the page
      });
    return () => {
      cancel = true;
    };
  }, [slug]);

  if (rows.length === 0) return null;

  return (
    <div className="mt-4 flex flex-wrap items-baseline gap-3 t-meta">
      <span className="t-label text-[var(--color-secondary)]">discovered by</span>
      {rows.map((r, i) => (
        <span key={r.ref} className="flex items-baseline gap-2">
          <a
            href={`https://x.com/${r.ref}`}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--color-display)] hover:text-[var(--color-accent)]"
          >
            @{r.ref}
          </a>
          <span className="text-[var(--color-disabled)] font-mono">×{r.total}</span>
          {i < rows.length - 1 && (
            <span className="text-[var(--color-border-vis)]">·</span>
          )}
        </span>
      ))}
    </div>
  );
}
