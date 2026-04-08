import { useReadContract } from "wagmi";
import { formatUnits } from "viem";
import type { DashboardSnapshot } from "../types";

const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const;

const VAULT_BALANCE_ABI = [{
  name: "balanceOf",
  type: "function",
  stateMutability: "view",
  inputs: [{ name: "token", type: "address" }],
  outputs: [{ name: "", type: "uint256" }],
}] as const;

interface VaultHoldingsProps {
  vaultAddress: string | null;
  snapshot: DashboardSnapshot;
}

export function VaultHoldings({ vaultAddress, snapshot }: VaultHoldingsProps) {
  const { data: wethBalance } = useReadContract({
    address: vaultAddress as `0x${string}` | undefined,
    abi: VAULT_BALANCE_ABI,
    functionName: "balanceOf",
    args: [WETH_ADDRESS],
    query: { enabled: !!vaultAddress, refetchInterval: 15000 },
  });

  if (!vaultAddress) return null;

  const amount = wethBalance ? Number(formatUnits(wethBalance as bigint, 18)) : 0;

  if (amount === 0) return null;

  const usdValue = snapshot.ethPrice && snapshot.ethPrice > 0 ? amount * snapshot.ethPrice : null;
  const amtDisplay = amount >= 1 ? amount.toFixed(4) : amount.toFixed(6);

  return (
    <div className="panel">
      <div className="panel-title">Vault Token Holdings</div>
      <table className="term-table">
        <thead>
          <tr>
            <th>Token</th>
            <th>Balance</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ color: "#e4e4e7" }}>WETH</td>
            <td style={{ color: "#a1a1aa" }}>{amtDisplay}</td>
            <td style={{ color: usdValue ? "#22c55e" : "#71717a" }}>
              {usdValue ? `$${usdValue.toFixed(2)}` : "—"}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
