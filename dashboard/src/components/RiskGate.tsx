import type { RiskGateResult } from "../types";

interface RiskGateProps {
  riskGate: RiskGateResult | null;
}

export function RiskGate({ riskGate }: RiskGateProps) {
  // Compute check count summary
  const counts = { pass: 0, warn: 0, fail: 0 };
  if (riskGate) {
    for (const check of riskGate.checks) {
      counts[check.status]++;
    }
  }

  const total = counts.pass + counts.warn + counts.fail;
  const summaryParts: string[] = [];
  if (counts.pass > 0) summaryParts.push(`${counts.pass}/${total} PASS`);
  if (counts.warn > 0) summaryParts.push(`${counts.warn} WARN`);
  if (counts.fail > 0) summaryParts.push(`${counts.fail} FAIL`);
  const summaryText = summaryParts.join(" | ");

  return (
    <div className="panel">
      <div className="panel-title">
        RISK GATE &mdash; {riskGate ? `${riskGate.checks.length} CHECKS` : "14 CHECKS"}
      </div>
      {!riskGate ? (
        <div className="empty-state">Waiting for cycle...</div>
      ) : (
        <>
          <div className="risk-checks">
            {riskGate.checks.map((check, i) => (
              <div className="risk-check-item" key={i}>
                <span className={`check-dot ${check.status}`} />
                <span className="risk-check-name" title={check.reason}>
                  {check.name}
                </span>
              </div>
            ))}
          </div>
          <div className="risk-check-summary">
            {summaryText}
          </div>
          <div className="risk-summary">
            <div className="risk-summary-item">
              <span className="risk-summary-label">STATUS</span>
              <span
                className={`risk-summary-value ${riskGate.approved ? "green" : "red"}`}
              >
                {riskGate.approved ? "APPROVED" : "BLOCKED"}
              </span>
            </div>
            <div className="risk-summary-item">
              <span className="risk-summary-label">EFF. SIZE</span>
              <span className="risk-summary-value">
                ${riskGate.effectiveSizeUsd.toFixed(0)}
              </span>
            </div>
            <div className="risk-summary-item">
              <span className="risk-summary-label">SLIPPAGE</span>
              <span className="risk-summary-value">
                {riskGate.maxSlippageBps}bps
              </span>
            </div>
            <div className="risk-summary-item">
              <span className="risk-summary-label">DELEG. LEFT</span>
              <span className="risk-summary-value">
                ${riskGate.delegationCapRemaining.toFixed(0)}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
