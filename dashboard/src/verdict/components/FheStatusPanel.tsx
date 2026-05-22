// ─── FheStatusPanel — sealed Fhenix posture chip ────────────────────────────

import { useEffect, useState } from "react";
import { verdictApi, type MetaResponse } from "../api.js";

type Posture = "sealed" | "unknown";

interface PostureStyle {
  label: string;
  cls: string;
  note?: string;
}

const POSTURE_STYLES: Record<Posture, PostureStyle> = {
  sealed: {
    label: "FHENIX SEALED",
    cls: "ck-pos",
    note: "pending verdicts stay private; Fhenix reveal makes verdicts public after horizon",
  },
  unknown: {
    label: "PRIVACY ?",
    cls: "ck-dim",
    note: "daemon did not return a privacy block (older build?)",
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
      <div className="ck-mono ck-neg text-xs">
        PRIVACY · [ERROR] {error}
      </div>
    );
  }
  if (!meta) {
    return <div className="ck-mono ck-dim text-xs">PRIVACY · loading...</div>;
  }

  const posture = classifyPosture(meta.privacy);
  const style = POSTURE_STYLES[posture];
  const network = meta.privacy?.threshold_network ?? "-";

  return (
    <div className="border border-[var(--color-border-vis)] p-2 ck-mono text-xs flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span
          className={
            "ck-label inline-flex items-center px-[6px] py-[1px] border " +
            "border-[var(--color-border-vis)] " +
            style.cls
          }
        >
          [ {style.label} ]
        </span>
        <span className="ck-dim">network={network}</span>
      </div>
      {style.note && <div className="ck-dim">{style.note}</div>}
    </div>
  );
}
