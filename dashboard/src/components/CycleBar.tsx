import { useState, useEffect } from "react";
import type { LoopPhase } from "../types";

interface CycleBarProps {
  currentPhase: LoopPhase | null;
  cycleId?: string;
  cycleStartedAt?: string;
}

const DISPLAY_PHASES = ["SENSE", "NORM", "SCORE", "DELIB", "RISK", "EXEC"] as const;

/** Map LoopPhase to the display phase index */
function phaseIndex(phase: LoopPhase): number {
  switch (phase) {
    case "sense":
      return 0;
    case "normalize":
      return 1;
    case "score":
      return 2;
    case "deliberate":
      return 3;
    case "risk_gate":
      return 4;
    case "quote":
    case "execute":
    case "attest":
      return 5;
    case "idle":
      return -1; // all done
  }
}

export function CycleBar({ currentPhase, cycleId, cycleStartedAt }: CycleBarProps) {
  const activeIdx = currentPhase ? phaseIndex(currentPhase) : -1;
  const [elapsed, setElapsed] = useState("");

  useEffect(() => {
    if (!cycleStartedAt) {
      setElapsed("");
      return;
    }

    const update = () => {
      const startMs = new Date(cycleStartedAt).getTime();
      const diff = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
      setElapsed(`${diff}s elapsed`);
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [cycleStartedAt]);

  return (
    <div className="cycle-bar">
      <span className="cycle-id">{cycleId ? `#${cycleId.slice(0, 6)}` : "IDLE"}</span>
      <div className="phase-bars">
        {DISPLAY_PHASES.map((label, i) => {
          let status: "done" | "active" | "pending";
          if (activeIdx === -1) {
            // idle -- all done or not started
            status = currentPhase === "idle" ? "done" : "pending";
          } else if (i < activeIdx) {
            status = "done";
          } else if (i === activeIdx) {
            status = "active";
          } else {
            status = "pending";
          }

          return (
            <div className="phase-segment" key={label}>
              <div className={`phase-bar ${status}`} />
              <span className={`phase-label ${status}`}>{label}</span>
            </div>
          );
        })}
      </div>
      <span className="cycle-elapsed">{elapsed}</span>
    </div>
  );
}
