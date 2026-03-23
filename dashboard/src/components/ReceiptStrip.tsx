import type { DashboardSnapshot } from "../types";

interface ReceiptStripProps {
  snapshot: DashboardSnapshot;
}

function truncateCid(cid: string): string {
  if (cid.length <= 16) return cid;
  return cid.slice(0, 8) + "..." + cid.slice(-6);
}

function truncateTxHash(hash: string): string {
  if (hash.length <= 14) return hash;
  return hash.slice(0, 8) + "..." + hash.slice(-6);
}

function cycleLatency(snapshot: DashboardSnapshot): string {
  if (!snapshot.currentCycle?.startedAt) return "--";
  const started = new Date(snapshot.currentCycle.startedAt).getTime();
  const elapsed = (Date.now() - started) / 1000;
  return `${elapsed.toFixed(1)}s`;
}

export function ReceiptStrip({ snapshot }: ReceiptStripProps) {
  const cid = snapshot.latestFilecoinCid;

  // Latest executed decision with a txHash
  const latestExec = snapshot.lastDecisions.find(
    (d) => d.result === "executed" && d.txHash
  );
  const txHash = latestExec?.txHash ?? null;

  const riskApproved = snapshot.riskGate?.approved ?? null;
  const riskLabel =
    riskApproved === null ? "--" : riskApproved ? "approved" : "blocked";
  const riskColor = riskApproved === true ? "#22c55e" : riskApproved === false ? "#ef4444" : "#3f3f46";

  const latency = cycleLatency(snapshot);

  return (
    <div className="receipt-strip">
      <div className="receipt-item">
        <span className="receipt-label">Filecoin</span>
        <span className="receipt-value">
          {cid ? (
            <a
              href={`https://w3s.link/ipfs/${cid}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {truncateCid(cid)}
            </a>
          ) : (
            <span style={{ color: "#3f3f46" }}>--</span>
          )}
        </span>
      </div>
      <div className="receipt-item">
        <span className="receipt-label">Tx</span>
        <span className="receipt-value">
          {txHash ? (
            <a
              href={`https://sepolia.basescan.org/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {truncateTxHash(txHash)}
            </a>
          ) : (
            <span style={{ color: "#3f3f46" }}>--</span>
          )}
        </span>
      </div>
      <div className="receipt-item">
        <span className="receipt-label">Cycle</span>
        <span className="receipt-value">{latency}</span>
      </div>
      <div className="receipt-item">
        <span className="receipt-label">Risk</span>
        <span className="receipt-value" style={{ color: riskColor }}>
          {riskLabel}
        </span>
      </div>
    </div>
  );
}
