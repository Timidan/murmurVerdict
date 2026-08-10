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
    note: "Your calls are encrypted until they resolve. After the deadline, the result is posted publicly for the leaderboard.",
  },
  unknown: {
    label: "PRIVACY UNKNOWN",
    cls: "ck-dim",
    note: "We could not confirm the privacy mode. Refresh, or contact support if this persists.",
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
        error={`privacy status unavailable — ${error}`}
        className="ck-mono"
      />
    );
  }
  if (!meta) {
    return <div className="ck-mono ck-dim">Checking privacy status…</div>;
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
