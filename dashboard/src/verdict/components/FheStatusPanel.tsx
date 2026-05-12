// ─── FheStatusPanel — daemon FHE readiness chip (Z4) ───────────────────────
//
// Reads /v1/meta.privacy. Renders one of three postures:
//
//   off          fhe_direct_enabled=false → grey "FHE OFF"
//   mock-tier    threshold_mode ∈ {mock, stub, mock_quorum} → amber banner
//                "DEV: <mode>" — operator-blind path exists in code but the
//                trust root is NOT a real KMS/committee. Z5 will gate this
//                value off in prod readyz.
//   production   threshold_mode='production' → green "OPERATOR-BLIND LIVE"
//
// The component is intentionally read-only and tiny: the source of truth
// is the daemon. A future "ENABLE FHE" admin button does NOT belong here.
//
// Wire shape — see src/verdict/api.ts /v1/meta:
//   { privacy: { fhe_direct_enabled, provider, active_keyset_id,
//                threshold_mode } }

import { useEffect, useState } from "react";
import { verdictApi, type MetaResponse } from "../api.js";

type Posture = "off" | "dev" | "production" | "unknown";

interface PostureStyle {
  label: string;
  cls: string;
  note?: string;
}

const POSTURE_STYLES: Record<Posture, PostureStyle> = {
  off: {
    label: "FHE OFF",
    cls: "ck-dim",
    note: "operator-blind path disabled (legacy/committed only)",
  },
  dev: {
    label: "FHE DEV",
    cls: "ck-neg",
    note: "operator-blind path runs against a mock/stub trust root, not a real KMS committee",
  },
  production: {
    label: "OPERATOR-BLIND LIVE",
    cls: "ck-pos",
    note: "threshold committee is the trust root; daemon cannot decrypt predictions alone",
  },
  unknown: {
    label: "FHE ?",
    cls: "ck-dim",
    note: "daemon did not return a privacy block (older build?)",
  },
};

function classifyPosture(privacy: MetaResponse["privacy"]): Posture {
  if (!privacy) return "unknown";
  if (!privacy.fhe_direct_enabled) return "off";
  const mode = privacy.threshold_mode;
  if (mode === "production") return "production";
  if (mode === "mock" || mode === "stub" || mode === "mock_quorum") return "dev";
  return "unknown";
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
        FHE STATUS · [ERROR] {error}
      </div>
    );
  }
  if (!meta) {
    return <div className="ck-mono ck-dim text-xs">FHE STATUS · loading…</div>;
  }

  const posture = classifyPosture(meta.privacy);
  const style = POSTURE_STYLES[posture];
  const mode = meta.privacy?.threshold_mode ?? "—";
  const provider = meta.privacy?.provider ?? "—";

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
        <span className="ck-dim">threshold_mode={mode} · provider={provider}</span>
      </div>
      {style.note && <div className="ck-dim">{style.note}</div>}
    </div>
  );
}
