import { useSocket } from "./hooks/useSocket";
import { Header } from "./components/Header";
import { CycleBar } from "./components/CycleBar";
import { Summary } from "./components/Summary";
import { Positions } from "./components/Positions";
import { Heatmap } from "./components/Heatmap";
import { RiskGate } from "./components/RiskGate";
import { DecisionLog } from "./components/DecisionLog";

export function App() {
  const { snapshot, connected, currentPhase } = useSocket("ws://localhost:3001");

  if (!connected) {
    return (
      <div>
        <div className="header">
          <div className="header-left">
            <span className="header-brand">MURMUR</span>
          </div>
          <div className="header-right" style={{ color: "#ef4444" }}>DISCONNECTED</div>
        </div>
        <div className="loading-container">CONNECTING TO AGENT...</div>
      </div>
    );
  }

  return (
    <div>
      <Header snapshot={snapshot} connected={connected} />
      <CycleBar
        currentPhase={currentPhase}
        cycleId={snapshot?.currentCycle?.cycleId}
        cycleStartedAt={snapshot?.currentCycle?.startedAt}
      />
      {!snapshot ? (
        <SkeletonLayout />
      ) : (
        <>
          <Summary snapshot={snapshot} />
          <div className="main-grid">
            <Positions snapshot={snapshot} />
            <Heatmap scoredAssets={snapshot.scoredAssets} />
            <RiskGate riskGate={snapshot.riskGate} />
            <DecisionLog decisions={snapshot.lastDecisions} />
          </div>
        </>
      )}
    </div>
  );
}

/** Skeleton loading state that mirrors the real layout */
function SkeletonLayout() {
  return (
    <>
      {/* Summary skeleton */}
      <div className="summary-section">
        <div className="summary-row">
          {Array.from({ length: 6 }).map((_, i) => (
            <div className="stat-box" key={i}>
              <div className="stat-label">
                <span className="skeleton" style={{ display: "inline-block", width: 36, height: 8 }} />
              </div>
              <div style={{ marginTop: 6 }}>
                <span className="skeleton" style={{ display: "inline-block", width: 64, height: 16 }} />
              </div>
            </div>
          ))}
        </div>
        {/* Chart skeleton */}
        <div className="portfolio-chart-container">
          <div className="skeleton" style={{ width: "100%", height: 120 }} />
        </div>
      </div>

      {/* Main grid skeleton */}
      <div className="main-grid">
        {/* Positions skeleton */}
        <div className="panel">
          <div className="panel-title">
            <span className="skeleton" style={{ display: "inline-block", width: 120, height: 8 }} />
          </div>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} style={{ display: "flex", gap: 12, padding: "6px 0", alignItems: "center" }}>
              <span className="skeleton" style={{ display: "inline-block", width: 40, height: 10 }} />
              <span className="skeleton" style={{ display: "inline-block", width: 48, height: 10 }} />
              <span className="skeleton" style={{ display: "inline-block", width: 32, height: 10 }} />
              <span className="skeleton" style={{ display: "inline-block", width: 32, height: 10 }} />
              <span className="skeleton" style={{ display: "inline-block", width: 28, height: 10 }} />
              <span className="skeleton" style={{ display: "inline-block", width: 40, height: 14 }} />
            </div>
          ))}
        </div>

        {/* Heatmap skeleton */}
        <div className="panel">
          <div className="panel-title">
            <span className="skeleton" style={{ display: "inline-block", width: 200, height: 8 }} />
          </div>
          {Array.from({ length: 7 }).map((_, row) => (
            <div key={row} style={{ display: "flex", gap: 1, marginBottom: 1 }}>
              <span className="skeleton" style={{ display: "inline-block", width: 52, height: 18 }} />
              {Array.from({ length: 9 }).map((_, col) => (
                <span
                  key={col}
                  className="skeleton"
                  style={{ display: "inline-block", flex: 1, height: 18 }}
                />
              ))}
              <span className="skeleton" style={{ display: "inline-block", width: 44, height: 18 }} />
            </div>
          ))}
        </div>

        {/* RiskGate skeleton */}
        <div className="panel">
          <div className="panel-title">
            <span className="skeleton" style={{ display: "inline-block", width: 100, height: 8 }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 12px" }}>
            {Array.from({ length: 14 }).map((_, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 0" }}>
                <span className="skeleton" style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%" }} />
                <span className="skeleton" style={{ display: "inline-block", width: 80, height: 9 }} />
              </div>
            ))}
          </div>
        </div>

        {/* DecisionLog skeleton */}
        <div className="panel">
          <div className="panel-title">
            <span className="skeleton" style={{ display: "inline-block", width: 160, height: 8 }} />
          </div>
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns: "56px 48px 52px 1fr 80px",
                gap: 6,
                padding: "4px 0",
                background: i % 2 === 0 ? "#0c0c0e" : "#09090b",
              }}
            >
              <span className="skeleton" style={{ display: "inline-block", height: 9 }} />
              <span className="skeleton" style={{ display: "inline-block", height: 9 }} />
              <span className="skeleton" style={{ display: "inline-block", height: 9 }} />
              <span className="skeleton" style={{ display: "inline-block", height: 9 }} />
              <span className="skeleton" style={{ display: "inline-block", height: 9 }} />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
