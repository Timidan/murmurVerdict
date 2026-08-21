// ─── FheStatusPanel — sealed Fhenix posture chip ────────────────────────────

import { useEffect, useState } from "react";
import { verdictApi, type MetaResponse } from "../api.js";
import { InlineError } from "./compact/InlineError.js";

type Posture = "sealed" | "unknown";

interface PostureStyle {
  label: string;
  cls: string;
  note?: string;
}

const POSTURE_STYLES: Record<Posture, PostureStyle> = {
  sealed: {
    label: "PRIVATE BY DEFAULT",
    cls: "ck-pos",
    note: "Murmur keeps your calls encrypted until they resolve. After the market closes, the result goes public on the leaderboard.",
  },
  unknown: {
    label: "PRIVACY UNKNOWN",
    cls: "ck-dim",
    note: "unable to confirm how this deployment handles privacy. Refresh the page. Tell us if it keeps happening.",
  },
};

function classifyPosture(privacy: MetaResponse["privacy"]): Posture {
  if (!privacy) return "unknown";
  return privacy.mode === "sealed_fhenix" ? "sealed" : "unknown";
}

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
  if (!meta) {
    return <div className="ck-mono ck-dim">Checking the privacy status…</div>;
  }

  const posture = classifyPosture(meta.privacy);
  const style = POSTURE_STYLES[posture];

  return (
    <div className="border border-[var(--color-border-vis)] p-2 ck-mono flex flex-col gap-1">
      <span
        className={
          "ck-label inline-flex items-center self-start px-[6px] py-[1px] border " +
          "border-[var(--color-border-vis)] " +
          style.cls
        }
      >
        [ {style.label} ]
      </span>
      {style.note && <div className="ck-dim">{style.note}</div>}
    </div>
  );
}
