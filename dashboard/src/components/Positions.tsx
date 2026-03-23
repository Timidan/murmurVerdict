import type { DashboardSnapshot } from "../types";

interface PositionsProps {
  snapshot: DashboardSnapshot;
  ethPrice?: number | null;
}

const SLUG_NAMES: Record<string, string> = {
  ethereum: "ETH",
  weth: "WETH",
  "wrapped-bitcoin": "cbBTC",
  aave: "AAVE",
  uniswap: "UNI",
  chainlink: "LINK",
  "aerodrome-finance": "AERO",
  "virtual-protocol": "VRTL",
};

export function Positions({ snapshot, ethPrice }: PositionsProps) {
  const positions = snapshot.treasury.positions;
  const maxPositions = 5;

  return (
    <div className="panel">
      <div className="panel-title">
        Open Positions ({positions.length}/{maxPositions})
      </div>
      {positions.length === 0 ? (
        <div className="empty-state">No positions</div>
      ) : (
        <table className="term-table">
          <thead>
            <tr>
              <th>Asset</th>
              <th>Amt</th>
              <th>Value</th>
              <th>Ret</th>
              <th>Score</th>
              <th>TTL</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((pos) => {
              const scored = snapshot.scoredAssets.find(
                (a) => a.slug === pos.slug
              );
              const compositeScore = scored?.compositeScore ?? 0;

              // Compute human-readable token amount (divide raw by 1e18)
              const tokenAmount = Number(pos.amountHeld) / 1e18;

              // For ethereum/weth, use live ethPrice to compute USD value when
              // the on-chain testnet quoter returned 0
              let entryValue = pos.usdValueAtEntry;
              if (
                (pos.slug === "ethereum" || pos.slug === "weth") &&
                ethPrice &&
                ethPrice > 0 &&
                entryValue === 0
              ) {
                entryValue = tokenAmount * ethPrice;
              }

              // Compute return if ethPrice is available and position is ETH
              let retDisplay: string;
              let retColor: string;
              if (
                (pos.slug === "ethereum" || pos.slug === "weth") &&
                ethPrice &&
                ethPrice > 0 &&
                entryValue > 0
              ) {
                const currentValue = ethPrice * tokenAmount;
                const ret = ((currentValue - entryValue) / entryValue) * 100;
                retDisplay = `${ret >= 0 ? "+" : ""}${ret.toFixed(1)}%`;
                retColor = ret >= 0 ? "#22c55e" : "#ef4444";
              } else {
                retDisplay = "N/A";
                retColor = "#3f3f46";
              }

              // Time to live: time since entry
              const entryTime = new Date(pos.entryAt).getTime();
              const elapsed = Date.now() - entryTime;
              const hours = Math.floor(elapsed / (1000 * 60 * 60));
              const ttl =
                hours >= 24
                  ? `${Math.floor(hours / 24)}d ${hours % 24}h`
                  : `${hours}h`;

              // Format token amount: show up to 4 significant decimals
              const amtDisplay =
                tokenAmount >= 1
                  ? tokenAmount.toFixed(2)
                  : tokenAmount.toFixed(4);

              return (
                <tr key={pos.slug}>
                  <td style={{ color: "#e4e4e7" }}>
                    {SLUG_NAMES[pos.slug] ?? pos.slug}
                  </td>
                  <td style={{ color: "#a1a1aa" }}>{amtDisplay}</td>
                  <td>${entryValue.toFixed(0)}</td>
                  <td style={{ color: retColor }}>{retDisplay}</td>
                  <td
                    className={
                      compositeScore > 0.3
                        ? "green"
                        : compositeScore < -0.3
                          ? "red"
                          : "amber"
                    }
                  >
                    {compositeScore.toFixed(2)}
                  </td>
                  <td style={{ color: "#71717a" }}>{ttl}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
