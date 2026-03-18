import { createPublicClient, getAddress, http, type Address } from "viem";
import { mainnet } from "viem/chains";

export const DEFAULT_AGENT_WALLET: Address =
  "0x0a3C305cC7645241AEdE654C75341a3b98aF7d66";

export interface EnsResolutionSnapshot {
  address: Address;
  ensName: string | null;
  displayName: string;
  lastCheckedAt: string | null;
}

export function createDefaultEnsResolution(
  address: Address = DEFAULT_AGENT_WALLET,
): EnsResolutionSnapshot {
  return {
    address,
    ensName: null,
    displayName: "loading...",
    lastCheckedAt: null,
  };
}

export async function resolveAgentEns(params: {
  address: Address;
  rpcUrl?: string;
}): Promise<EnsResolutionSnapshot> {
  const address = getAddress(params.address);
  const checkedAt = new Date().toISOString();

  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(params.rpcUrl ?? "https://ethereum-rpc.publicnode.com", {
      timeout: 10_000,
    }),
  });

  try {
    const ensName = await publicClient.getEnsName({ address });

    return {
      address,
      ensName,
      displayName: ensName ?? "not set",
      lastCheckedAt: checkedAt,
    };
  } catch (error) {
    return {
      address,
      ensName: null,
      displayName: "lookup failed",
      lastCheckedAt: checkedAt,
    };
  }
}
