import type { DashboardSnapshot } from "../types";
import { Sparkline } from "./Sparkline";

interface PositionsProps {
  snapshot: DashboardSnapshot;
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

/** Generate a deterministic random walk from a slug string for sparkline data */
function mockPriceHistory(slug: string, length = 20): number[] {
  // Simple hash from slug
  let hash = 0;
  for (let i = 0; i < slug.length; i++) {
    hash = (hash * 31 + slug.charCodeAt(i)) | 0;
  }

  const data: number[] = [];
  let value = 100 + (Math.abs(hash) % 50);
  const seed = Math.abs(hash);

  for (let i = 0; i < length; i++) {
    // Deterministic pseudo-random noise
    const noise = Math.sin(seed * (i + 1) * 0.1) * 3 + Math.cos(seed * (i + 1) * 0.07) * 2;
    value = value + noise;
    data.push(value);
  }

  return data;
}

export function Positions({ snapshot }: PositionsProps) {
  const positions = snapshot.treasury.positions;
  const maxPositions = 5;

  return (
    <div className="panel">
      <div className="panel-title">
        OPEN POSITIONS ({positions.length}/{maxPositions})
      </div>
      {positions.length === 0 ? (
        <div className="empty-state">NO POSITIONS</div>
      ) : (
        <table className="term-table">
          <thead>
            <tr>
              <th>ASSET</th>
              <th>VALUE</th>
              <th>RET</th>
              <th>SCORE</th>
              <th>TTL</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {positions.map((pos) => {
              const scored = snapshot.scoredAssets.find(
                (a) => a.slug === pos.slug
              );
              const compositeScore = scored?.compositeScore ?? 0;
              const entryValue = pos.usdValueAtEntry;

              // Time to live: time since entry
              const entryTime = new Date(pos.entryAt).getTime();
              const elapsed = Date.now() - entryTime;
              const hours = Math.floor(elapsed / (1000 * 60 * 60));
              const ttl =
                hours >= 24
                  ? `${Math.floor(hours / 24)}d ${hours % 24}h`
                  : `${hours}h`;

              const sparkData = mockPriceHistory(pos.slug);

              return (
                <tr key={pos.slug}>
                  <td style={{ color: "#e4e4e7" }}>
                    {SLUG_NAMES[pos.slug] ?? pos.slug}
                  </td>
                  <td>${entryValue.toFixed(0)}</td>
                  <td className="green">{"\u2014"}</td>
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
                  <td>
                    <Sparkline data={sparkData} width={40} height={14} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
