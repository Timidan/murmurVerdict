import * as dotenv from "dotenv";
dotenv.config();

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  http,
  maxUint256,
  parseUnits,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import {
  type AssetSlug,
  type ExecutionResult,
  type LLMDecision,
  type Position,
  type RiskGateResult,
  type TreasuryState,
  type UniswapQuote,
  MurmurError,
} from "../types/index.js";

// ─── Errors ───────────────────────────────────────────────────────────────────

export class ExecutionError extends MurmurError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "EXECUTION_ERROR", context);
    this.name = "ExecutionError";
  }
}

// ─── Base Sepolia Token Registry ──────────────────────────────────────────────

export interface TokenMeta {
  address: Address;
  decimals: number;
  symbol: string;
  name: string;
}

export const BASE_TOKENS: Record<AssetSlug | "usdc", TokenMeta> = {
  usdc: {
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    decimals: 6,
    symbol: "USDC",
    name: "USD Coin",
  },
  ethereum: {
    address: "0x4200000000000000000000000000000000000006",
    decimals: 18,
    symbol: "WETH",
    name: "Wrapped Ether",
  },
  weth: {
    address: "0x4200000000000000000000000000000000000006",
    decimals: 18,
    symbol: "WETH",
    name: "Wrapped Ether",
  },
  "wrapped-bitcoin": {
    address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    decimals: 8,
    symbol: "cbBTC",
    name: "Coinbase Wrapped Bitcoin",
  },
  aave: {
    address: "0x63706e401c06ac8513145b7687a14804d17f814b",
    decimals: 18,
    symbol: "AAVE",
    name: "Aave Token",
  },
  uniswap: {
    address: "0xc3De830EA07524a0761646a6a4e4be0e114a3C83",
    decimals: 18,
    symbol: "UNI",
    name: "Uniswap",
  },
  chainlink: {
    address: "0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196",
    decimals: 18,
    symbol: "LINK",
    name: "ChainLink Token",
  },
  "aerodrome-finance": {
    address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
    decimals: 18,
    symbol: "AERO",
    name: "Aerodrome",
  },
  "virtual-protocol": {
    address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",
    decimals: 18,
    symbol: "VIRTUAL",
    name: "Virtual Protocol",
  },
};

// ─── Uniswap Base Sepolia Deployments ─────────────────────────────────────────

const UNISWAP_SWAP_ROUTER_02: Address =
  "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4";
const UNISWAP_QUOTER_V2: Address = "0xC5290058841028F1614F3A6F0F5816cAd0df5E27";

const POOL_FEE_LOW = 500;
const POOL_FEE_MID = 3000;
const POOL_FEE_HIGH = 10000;

const PREFERRED_POOL_FEE: Partial<Record<AssetSlug | "usdc", number>> = {
  ethereum: POOL_FEE_LOW,
  weth: POOL_FEE_LOW,
  "wrapped-bitcoin": POOL_FEE_MID,
  aave: POOL_FEE_MID,
  uniswap: POOL_FEE_MID,
  chainlink: POOL_FEE_MID,
  "aerodrome-finance": POOL_FEE_MID,
  "virtual-protocol": POOL_FEE_HIGH,
};

const UNISWAP_TRADING_API_URL = "https://trade-api.gateway.uniswap.org/v1";
const REQUEST_TIMEOUT_MS = 30_000;

// ─── TradeVault ────────────────────────────────────────────────────────────────

export const TRADE_VAULT_ADDRESS: Address =
  "0x14114283D2f1471344907061BF49EB15daF9cB1E";

const TRADE_VAULT_ABI = [
  {
    name: "executeTrade",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenIn", type: "address", internalType: "address" },
      { name: "amountIn", type: "uint256", internalType: "uint256" },
      { name: "routerCalldata", type: "bytes", internalType: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
  },
  {
    name: "canTrade",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "amountIn", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
  },
  {
    name: "dailyRemaining",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
  },
] as const;

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const QUOTER_V2_ABI = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const SWAP_ROUTER_ABI = [
  {
    name: "exactInputSingle",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

// ─── Trading API Types ────────────────────────────────────────────────────────

interface TradingApiQuoteRequest {
  type: "EXACT_INPUT";
  amount: string;
  tokenInChainId: number;
  tokenOutChainId: number;
  tokenIn: string;
  tokenOut: string;
  swapper: string;
  slippageTolerance?: number;
}

interface TradingApiQuoteResponse {
  quote?: {
    input: { amount: string; token: string };
    output: { amount: string; token: string };
    route?: unknown[][];
    priceImpact?: number;
  };
  routing?: string;
}

// ─── Client Factory ───────────────────────────────────────────────────────────

export function createClients(params: {
  rpcUrl: string;
  privateKey: `0x${string}`;
}): {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: ReturnType<typeof privateKeyToAccount>;
} {
  const account = privateKeyToAccount(params.privateKey);

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(params.rpcUrl, { timeout: REQUEST_TIMEOUT_MS }),
  });

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(params.rpcUrl, { timeout: REQUEST_TIMEOUT_MS }),
  });

  return {
    publicClient: publicClient as PublicClient,
    walletClient: walletClient as WalletClient,
    account,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function resolveTokens(
  action: "buy" | "reduce" | "exit",
  slug: AssetSlug,
): { tokenIn: TokenMeta; tokenOut: TokenMeta } {
  const usdc = BASE_TOKENS.usdc;
  const asset = BASE_TOKENS[slug];

  if (!asset) {
    throw new ExecutionError(`No token config found for slug: ${slug}`, {
      slug,
    });
  }

  if (action === "buy") {
    return { tokenIn: usdc, tokenOut: asset };
  }

  return { tokenIn: asset, tokenOut: usdc };
}

export function resolvePoolFee(slug: AssetSlug): number {
  return PREFERRED_POOL_FEE[slug] ?? POOL_FEE_MID;
}

export function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  const factor = BigInt(10_000 - slippageBps);
  return (amountOut * factor) / BigInt(10_000);
}

export async function getTokenBalance(
  publicClient: PublicClient,
  tokenAddress: Address,
  ownerAddress: Address,
): Promise<bigint> {
  const balance = await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [ownerAddress],
  });

  return balance as bigint;
}

export async function getUsdcBalance(
  publicClient: PublicClient,
  ownerAddress: Address,
): Promise<bigint> {
  return getTokenBalance(publicClient, BASE_TOKENS.usdc.address, ownerAddress);
}

export async function getTokenPriceUsd(
  publicClient: PublicClient,
  slug: AssetSlug,
): Promise<number> {
  const token = BASE_TOKENS[slug];
  if (!token) return 0;

  const oneUnit = 10n ** BigInt(token.decimals);
  const fee = resolvePoolFee(slug);

  try {
    const result = await publicClient.simulateContract({
      address: UNISWAP_QUOTER_V2,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: token.address,
          tokenOut: BASE_TOKENS.usdc.address,
          amountIn: oneUnit,
          fee,
          sqrtPriceLimitX96: BigInt(0),
        },
      ],
    });

    const [amountOut] = result.result as [bigint, bigint, number, bigint];
    return Number(amountOut) / 1e6; // USDC has 6 decimals
  } catch (err) {
    console.warn(`[Executor] Failed to get price for ${slug}: ${(err as Error).message}`);
    return 0;
  }
}

export async function getAllBalances(
  publicClient: PublicClient,
  ownerAddress: Address,
): Promise<Map<AssetSlug, { balance: bigint; usdValue: number }>> {
  const results = new Map<AssetSlug, { balance: bigint; usdValue: number }>();

  const slugs = Object.keys(BASE_TOKENS).filter(
    (k) => k !== "usdc",
  ) as AssetSlug[];

  // Deduplicate slugs that share the same token address (e.g. "ethereum" and "weth")
  const seenAddresses = new Set<string>();
  const uniqueSlugs = slugs.filter((slug) => {
    const addr = BASE_TOKENS[slug]?.address.toLowerCase();
    if (!addr || seenAddresses.has(addr)) return false;
    seenAddresses.add(addr);
    return true;
  });

  await Promise.all(
    uniqueSlugs.map(async (slug) => {
      const token = BASE_TOKENS[slug];
      if (!token) return;

      try {
        const balance = await getTokenBalance(
          publicClient,
          token.address,
          ownerAddress,
        );

        if (balance > 0n) {
          const priceUsd = await getTokenPriceUsd(publicClient, slug);
          const usdValue =
            (Number(balance) / 10 ** token.decimals) * priceUsd;
          results.set(slug, { balance, usdValue });
        }
      } catch (err) {
        console.warn(`[Executor] Failed to query ${slug}: ${(err as Error).message}`);
      }
    }),
  );

  return results;
}

export async function refreshPortfolio(
  publicClient: PublicClient,
  ownerAddress: Address,
  vaultAddress: Address = TRADE_VAULT_ADDRESS,
): Promise<TreasuryState> {
  // Read USDC balance from vault (where deposited funds live)
  const vaultUsdcBalance = (await publicClient.readContract({
    address: vaultAddress,
    abi: TRADE_VAULT_ABI,
    functionName: "balanceOf",
    args: [BASE_TOKENS.usdc.address],
  })) as bigint;

  const usdcBalance = vaultUsdcBalance;
  const usdcUsd = Number(usdcBalance) / 1e6;

  const balances = await getAllBalances(publicClient, ownerAddress);

  const positions: Position[] = [];
  let positionsUsd = 0;

  for (const [slug, { balance, usdValue }] of balances) {
    const token = BASE_TOKENS[slug];
    if (!token) continue;

    positions.push({
      slug,
      tokenAddress: token.address,
      amountHeld: balance,
      usdValueAtEntry: usdValue,
      entryTxHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      entryAt: new Date().toISOString(),
      thesis: "reconstructed from on-chain balance",
      invalidationCondition: "",
    });

    positionsUsd += usdValue;
  }

  return {
    usdcBalance,
    totalPortfolioUsd: usdcUsd + positionsUsd,
    positions,
    lastUpdatedAt: new Date().toISOString(),
  };
}

// ─── Approval ─────────────────────────────────────────────────────────────────

async function ensureApproval(params: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Address;
  tokenAddress: Address;
  spender: Address;
  amount: bigint;
}): Promise<Hash | null> {
  const { publicClient, walletClient, account, tokenAddress, spender, amount } =
    params;

  const allowance = (await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account, spender],
  })) as bigint;

  if (allowance >= amount) {
    return null;
  }

  const hash = await (
    walletClient as WalletClient & {
      writeContract: (args: unknown) => Promise<Hash>;
    }
  ).writeContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender, maxUint256],
    chain: baseSepolia,
  });

  await publicClient.waitForTransactionReceipt({
    hash,
    timeout: 60_000,
  });

  return hash;
}

// ─── Quote Providers ──────────────────────────────────────────────────────────

async function fetchTradingApiQuote(params: {
  apiKey: string;
  tokenIn: TokenMeta;
  tokenOut: TokenMeta;
  amountIn: bigint;
  swapperAddress: Address;
  slippageBps: number;
}): Promise<TradingApiQuoteResponse | null> {
  const { apiKey, tokenIn, tokenOut, amountIn, swapperAddress, slippageBps } =
    params;

  if (!apiKey) return null;

  const body: TradingApiQuoteRequest = {
    type: "EXACT_INPUT",
    amount: amountIn.toString(),
    tokenInChainId: baseSepolia.id,
    tokenOutChainId: baseSepolia.id,
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    swapper: swapperAddress,
    slippageTolerance: slippageBps / 100,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${UNISWAP_TRADING_API_URL}/quote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        origin: "https://app.uniswap.org",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      return null;
    }

    return (await res.json()) as TradingApiQuoteResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function getOnChainQuote(params: {
  publicClient: PublicClient;
  tokenIn: TokenMeta;
  tokenOut: TokenMeta;
  amountIn: bigint;
  fee: number;
}): Promise<{ amountOut: bigint; priceImpactPct: number } | null> {
  const { publicClient, tokenIn, tokenOut, amountIn, fee } = params;

  try {
    const result = await publicClient.simulateContract({
      address: UNISWAP_QUOTER_V2,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: tokenIn.address,
          tokenOut: tokenOut.address,
          amountIn,
          fee,
          sqrtPriceLimitX96: BigInt(0),
        },
      ],
    });

    const [amountOut] = result.result as [bigint, bigint, number, bigint];

    return {
      amountOut,
      priceImpactPct: 0,
    };
  } catch {
    return null;
  }
}

export async function getQuote(params: {
  uniswapApiKey: string;
  publicClient: PublicClient;
  tokenIn: TokenMeta;
  tokenOut: TokenMeta;
  amountIn: bigint;
  swapperAddress: Address;
  slippageBps: number;
  fee?: number;
}): Promise<UniswapQuote> {
  const {
    uniswapApiKey,
    publicClient,
    tokenIn,
    tokenOut,
    amountIn,
    swapperAddress,
    slippageBps,
    fee = POOL_FEE_MID,
  } = params;

  const quotedAt = new Date().toISOString();

  const apiQuote = await fetchTradingApiQuote({
    apiKey: uniswapApiKey,
    tokenIn,
    tokenOut,
    amountIn,
    swapperAddress,
    slippageBps,
  });

  if (apiQuote?.quote?.output?.amount) {
    return {
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      amountIn,
      amountOut: BigInt(apiQuote.quote.output.amount),
      priceImpactPct: apiQuote.quote.priceImpact ?? 0,
      route: apiQuote.routing ?? "uniswap-trading-api",
      quotedAt,
    };
  }

  const fees = [fee, POOL_FEE_LOW, POOL_FEE_MID, POOL_FEE_HIGH].filter(
    (value, index, array) => array.indexOf(value) === index,
  );

  for (const currentFee of fees) {
    const onChainQuote = await getOnChainQuote({
      publicClient,
      tokenIn,
      tokenOut,
      amountIn,
      fee: currentFee,
    });

    if (onChainQuote) {
      return {
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn,
        amountOut: onChainQuote.amountOut,
        priceImpactPct: onChainQuote.priceImpactPct,
        route: `uniswap-v3-onchain-fee-${currentFee}`,
        quotedAt,
      };
    }
  }

  throw new ExecutionError(
    `Could not obtain a quote for ${tokenIn.symbol} -> ${tokenOut.symbol}`,
    {
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      amountIn: amountIn.toString(),
    },
  );
}

// ─── Swap Execution ───────────────────────────────────────────────────────────

async function executeSwap(params: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Address;
  tokenIn: TokenMeta;
  tokenOut: TokenMeta;
  amountIn: bigint;
  amountOutMinimum: bigint;
  fee: number;
  vaultAddress: Address;
}): Promise<Hash> {
  const {
    publicClient,
    walletClient,
    account,
    tokenIn,
    tokenOut,
    amountIn,
    amountOutMinimum,
    fee,
    vaultAddress,
  } = params;

  // Build the router calldata — tokens go back to the vault
  const routerCalldata = encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        fee,
        recipient: vaultAddress,
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: BigInt(0),
      },
    ],
  });

  // Delegate execution to the vault — it handles approval internally
  const hash = await (
    walletClient as WalletClient & {
      writeContract: (args: unknown) => Promise<Hash>;
    }
  ).writeContract({
    address: vaultAddress,
    abi: TRADE_VAULT_ABI,
    functionName: "executeTrade",
    args: [tokenIn.address, amountIn, routerCalldata],
    chain: baseSepolia,
  });

  return hash;
}

async function waitForReceipt(
  publicClient: PublicClient,
  hash: Hash,
): Promise<{
  gasUsed: bigint;
  blockNumber: bigint;
  status: "success" | "reverted";
}> {
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: 120_000,
  });

  return {
    gasUsed: receipt.gasUsed,
    blockNumber: receipt.blockNumber,
    status: receipt.status,
  };
}

// ─── Amount Resolution ────────────────────────────────────────────────────────

function usdToTokenAmount(usdAmount: number, token: TokenMeta): bigint {
  return parseUnits(
    usdAmount.toFixed(Math.min(token.decimals, 6)),
    token.decimals,
  );
}

async function resolveAmountIn(params: {
  publicClient: PublicClient;
  owner: Address;
  decision: LLMDecision;
  riskGate: RiskGateResult;
  tokenIn: TokenMeta;
}): Promise<bigint> {
  const { publicClient, owner, decision, riskGate, tokenIn } = params;

  if (decision.action === "buy") {
    return usdToTokenAmount(riskGate.effectiveSizeUsd, tokenIn);
  }

  const balance = await getTokenBalance(publicClient, tokenIn.address, owner);

  if (decision.action === "exit") {
    return balance;
  }

  return balance / BigInt(2);
}

// ─── Main Execute ─────────────────────────────────────────────────────────────

export async function execute(params: {
  decision: LLMDecision;
  riskGate: RiskGateResult;
  uniswapApiKey: string;
  rpcUrl: string;
  privateKey: `0x${string}`;
  vaultAddress?: Address;
}): Promise<ExecutionResult> {
  const { decision, riskGate, uniswapApiKey, rpcUrl, privateKey, vaultAddress: vaultAddr } = params;
  const vault = vaultAddr ?? TRADE_VAULT_ADDRESS;

  if (decision.action === "hold") {
    throw new ExecutionError("Cannot execute a hold decision");
  }

  if (!riskGate.approved) {
    throw new ExecutionError("Risk gate did not approve this trade", {
      failedChecks: riskGate.checks
        .filter((c) => c.status === "fail")
        .map((c) => c.name),
    });
  }

  const { publicClient, walletClient, account } = createClients({
    rpcUrl,
    privateKey,
  });

  const action = decision.action as "buy" | "reduce" | "exit";
  const { tokenIn, tokenOut } = resolveTokens(action, decision.slug);
  const fee = resolvePoolFee(decision.slug);

  const amountIn = await resolveAmountIn({
    publicClient,
    owner: account.address,
    decision,
    riskGate,
    tokenIn,
  });

  if (amountIn <= BigInt(0)) {
    throw new ExecutionError("Resolved amountIn is zero", {
      action,
      slug: decision.slug,
    });
  }

  const quote = await getQuote({
    uniswapApiKey,
    publicClient,
    tokenIn,
    tokenOut,
    amountIn,
    swapperAddress: account.address,
    slippageBps: riskGate.maxSlippageBps,
    fee,
  });

  const maxImpactPct = riskGate.maxSlippageBps / 100;
  if (quote.priceImpactPct > maxImpactPct) {
    throw new ExecutionError("Quote price impact exceeds configured limit", {
      priceImpactPct: quote.priceImpactPct,
      maxImpactPct,
    });
  }

  const amountOutMinimum = applySlippage(
    quote.amountOut,
    riskGate.maxSlippageBps,
  );

  const txHash = await executeSwap({
    publicClient,
    walletClient,
    account: account.address,
    tokenIn,
    tokenOut,
    amountIn,
    amountOutMinimum,
    fee,
    vaultAddress: vault,
  });

  const receipt = await waitForReceipt(publicClient, txHash);

  if (receipt.status !== "success") {
    throw new ExecutionError("Swap transaction reverted", { txHash });
  }

  return {
    txHash,
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    amountIn,
    amountOut: quote.amountOut,
    priceImpactPct: quote.priceImpactPct,
    gasUsed: receipt.gasUsed,
    blockNumber: receipt.blockNumber,
    executedAt: new Date().toISOString(),
  };
}

// ─── Summaries ────────────────────────────────────────────────────────────────

export function summarizeQuote(
  quote: UniswapQuote,
  tokenInMeta: TokenMeta,
  tokenOutMeta: TokenMeta,
): string {
  return [
    `[Executor] Quote`,
    `  Route:       ${quote.route}`,
    `  Token In:    ${formatUnits(quote.amountIn, tokenInMeta.decimals)} ${tokenInMeta.symbol}`,
    `  Token Out:   ${formatUnits(quote.amountOut, tokenOutMeta.decimals)} ${tokenOutMeta.symbol}`,
    `  Impact:      ${quote.priceImpactPct.toFixed(4)}%`,
    `  Quoted At:   ${quote.quotedAt}`,
  ].join("\n");
}

export function summarizeExecution(
  result: ExecutionResult,
  tokenInMeta: TokenMeta,
  tokenOutMeta: TokenMeta,
): string {
  return [
    `[Executor] Execution`,
    `  Tx:          ${result.txHash}`,
    `  In:          ${formatUnits(result.amountIn, tokenInMeta.decimals)} ${tokenInMeta.symbol}`,
    `  Out:         ${formatUnits(result.amountOut, tokenOutMeta.decimals)} ${tokenOutMeta.symbol}`,
    `  Gas Used:    ${result.gasUsed.toString()}`,
    `  Block:       ${result.blockNumber.toString()}`,
    `  Impact:      ${result.priceImpactPct.toFixed(4)}%`,
    `  BaseScan:    https://sepolia.basescan.org/tx/${result.txHash}`,
  ].join("\n");
}
