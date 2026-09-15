import { createPublicClient, createWalletClient, custom, http, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";

const FACILITATOR_URL = "https://gateway-api-testnet.circle.com";
const CIRCLE_DOMAIN = 6;
const USDC_DECIMALS = 1_000_000n;

const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const GATEWAY_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;

type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

export interface GatewayQuote {
  chainId: number;
  asset: string;
  gateway: string;
  amount: string;
}

export interface GatewayBalance {
  spendable: bigint;
  pending: boolean;
}

/** A pending Circle deposit is an uncertain money state, never a reason to top up again. */
export function gatewayShortfall(balance: GatewayBalance, needed: bigint): bigint | null {
  if (balance.pending || balance.spendable >= needed) return null;
  return needed - balance.spendable;
}

function depositStorageKey(quote: GatewayQuote, address: string): string {
  return `murmur:gateway-deposit:${quote.chainId}:${address.toLowerCase()}:${quote.gateway.toLowerCase()}:${quote.asset.toLowerCase()}`;
}

export function savedGatewayDeposit(quote: GatewayQuote, address: string): Hex | null {
  try {
    const value = window.localStorage.getItem(depositStorageKey(quote, address));
    return value && /^0x[\da-f]{64}$/i.test(value) ? value as Hex : null;
  } catch {
    return null;
  }
}

export function saveGatewayDeposit(quote: GatewayQuote, address: string, hash: Hex): void {
  try { window.localStorage.setItem(depositStorageKey(quote, address), hash); } catch { /* state still latches this open panel */ }
}

export function clearGatewayDeposit(quote: GatewayQuote, address: string): void {
  try { window.localStorage.removeItem(depositStorageKey(quote, address)); } catch { /* storage is optional */ }
}

export async function gatewayDepositReverted(hash: Hex): Promise<boolean> {
  try {
    const receipt = await createPublicClient({ chain: baseSepolia, transport: http() }).getTransactionReceipt({ hash });
    return receipt.status === "reverted";
  } catch {
    return false;
  }
}

function requireBaseSepolia(quote: GatewayQuote): asserts quote is GatewayQuote {
  if (quote.chainId !== baseSepolia.id) {
    throw new Error(`Gateway deposits are available only on Base Sepolia (84532), not chain ${quote.chainId}.`);
  }
}

function providerClients(provider: Eip1193Provider, address: string) {
  return {
    publicClient: createPublicClient({ chain: baseSepolia, transport: http() }),
    walletClient: createWalletClient({
      account: address as Address,
      chain: baseSepolia,
      transport: custom(provider),
    }),
  };
}

function decimalUsdcToAtoms(value: string): bigint {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) throw new Error("Gateway returned an invalid USDC balance.");
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * USDC_DECIMALS + BigInt(fraction.padEnd(6, "0").slice(0, 6));
}

/** Circle's ledger is the only balance that can pay a batched authorization. */
export async function gatewayBalance(address: string): Promise<GatewayBalance> {
  const body = { token: "USDC", sources: [{ domain: CIRCLE_DOMAIN, depositor: address }] };
  const [balanceResponse, depositsResponse] = await Promise.all([
    fetch(`${FACILITATOR_URL}/v1/balances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    fetch(`${FACILITATOR_URL}/v1/deposits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  ]);
  if (!balanceResponse.ok) throw new Error(`Gateway balance check failed (HTTP ${balanceResponse.status}).`);
  const balances = (await balanceResponse.json()) as { balances?: Array<{ balance?: string }> };
  const balance = balances.balances?.[0]?.balance;
  if (typeof balance !== "string") throw new Error("Gateway balance response had no USDC balance.");
  if (!depositsResponse.ok) throw new Error(`Gateway deposit check failed (HTTP ${depositsResponse.status}).`);
  const deposits = (await depositsResponse.json()) as { deposits?: Array<{ status?: string }> };
  if (!Array.isArray(deposits.deposits)) throw new Error("Gateway returned an invalid pending-deposit response.");
  const pending = deposits.deposits.some((deposit) => deposit.status === "pending");
  return { spendable: decimalUsdcToAtoms(balance), pending };
}

/** Sends the exact quote shortfall once. Callers persist the receipt hash before allowing another deposit. */
export async function depositGatewayUsdc(
  provider: Eip1193Provider,
  address: string,
  quote: GatewayQuote,
  shortfall: bigint,
  onSubmitted: (hash: Hex) => void,
): Promise<Hex> {
  requireBaseSepolia(quote);
  if (shortfall <= 0n) throw new Error("No Gateway deposit is needed.");
  await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x14a34" }] });
  const { publicClient, walletClient } = providerClients(provider, address);
  const asset = quote.asset as Address;
  const gateway = quote.gateway as Address;
  const approval = await walletClient.writeContract({ address: asset, abi: ERC20_ABI, functionName: "approve", args: [gateway, shortfall] });
  const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: approval });
  if (approvalReceipt.status !== "success") throw new Error("USDC approval did not confirm.");
  const deposit = await walletClient.writeContract({ address: gateway, abi: GATEWAY_ABI, functionName: "deposit", args: [asset, shortfall] });
  // Record the hash before awaiting the receipt: a timeout here leaves an
  // uncertain deposit, never permission to send another one.
  onSubmitted(deposit);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deposit });
  if (receipt.status !== "success") throw new Error("Gateway deposit did not confirm.");
  return deposit;
}

export async function decryptGrantedCall(args: {
  provider: Eip1193Provider;
  address: string;
  chainId: number;
  binaryIndexCtHash: string;
  confidenceCtHash: string;
}): Promise<{ binaryIndex: bigint; confidenceBps: bigint }> {
  if (args.chainId !== baseSepolia.id) throw new Error(`This browser supports CoFHE decrypt only on Base Sepolia (84532), not chain ${args.chainId}.`);
  const [{ createCofheClient, createCofheConfig }, { baseSepolia: cofheBaseSepolia }, { FheTypes }] = await Promise.all([
    import("@cofhe/sdk/web"),
    import("@cofhe/sdk/chains"),
    import("@cofhe/sdk"),
  ]);
  const { publicClient, walletClient } = providerClients(args.provider, args.address);
  const cofhe = createCofheClient(createCofheConfig({ supportedChains: [cofheBaseSepolia] }));
  await cofhe.connect(publicClient as never, walletClient as never);
  const permit = await cofhe.acp.createSelf({ type: "self", issuer: args.address });
  const deadline = Date.now() + 60_000;
  const decrypt = async (handle: string, type: number): Promise<bigint> => {
    for (;;) {
      try {
        return BigInt(await cofhe.decryptForView(BigInt(handle), type as never).set404RetryTimeout(60_000).withACP(permit as never).execute() as never);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/\b(403|forbidden|404|not found)\b/i.test(message) || Date.now() + 3_000 >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
  };
  const [binaryIndex, confidenceBps] = await Promise.all([
    decrypt(args.binaryIndexCtHash, FheTypes.Uint8),
    decrypt(args.confidenceCtHash, FheTypes.Uint16),
  ]);
  return { binaryIndex, confidenceBps };
}
