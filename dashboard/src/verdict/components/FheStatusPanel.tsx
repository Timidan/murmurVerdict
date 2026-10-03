// ─── FheStatusPanel — speaks only when the privacy posture is not the normal sealed one ──

import { useEffect, useState } from "react";
import { verdictApi, type MetaResponse } from "../api.js";
import { InlineError } from "./compact/InlineError.js";

export function FheStatusPanel() {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    verdictApi
      .meta()
      .then((r) => {
        if (!cancel) setMeta(r);
      })
      .catch((e) => {
        if (!cancel) setError(e.message);
      });
    return () => {
      cancel = true;
    };
  }, []);

  if (error) {
    return (
      <InlineError
        error={`We could not read the privacy status — ${error}`}
        className="ck-mono"
      />
    );
  }
  if (!meta || meta.privacy?.mode === "sealed_fhenix") return null;

  return (
    <div className="border border-[var(--color-border-vis)] p-2 ck-mono flex flex-col gap-1">
      <span
        className={
          "ck-label inline-flex items-center self-start px-[6px] py-[1px] border " +
          "border-[var(--color-border-vis)] ck-dim"
        }
      >
        [ Privacy unknown ]
      </span>
      <div className="ck-dim">
        unable to confirm how this deployment handles privacy. Refresh the page. Tell us if it keeps happening.
      </div>
    </div>
  );
}
