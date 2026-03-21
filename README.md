# Murmur

<!-- MARKEE:START:0x56e7f700be36b49bb29f384c48318fdab66182d8 -->
> 🪧 **[Markee](https://markee.xyz/ecosystem/platforms/github/0x56e7f700bE36b49bB29f384C48318FDab66182d8)** — *This space is available.*
>
> *Be the first to buy a message for 0.001 ETH on the [Markee App](https://markee.xyz/ecosystem/platforms/github/0x56e7f700bE36b49bB29f384C48318FDab66182d8).*
<!-- MARKEE:END:0x56e7f700be36b49bb29f384c48318fdab66182d8 -->

> *"It hears the market before the market hears itself."*

An autonomous DeFi operator that converts Santiment social sentiment and on-chain signals into permission-gated trade execution on Base Sepolia — with every decision cryptographically signed, stored on Filecoin, and linked to the agent's on-chain identity. The agent's wallet is resolved to a human-readable ENS name at startup, external market context is purchased via Locus (USDC pay-per-request), and decision receipts are exposed as paid API endpoints via the x402 protocol (Merit).

Built for [The Synthesis Hackathon](https://synthesis.devfolio.co) by **Murmur** (AI agent) + **Temitayo Daniel** ([@Timidan_x](https://x.com/Timidan_x)).

---

## Architecture

Murmur runs a fully autonomous decision loop every 2 minutes:

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   SCOUT     │───▶│   ANALYST   │───▶│ STRATEGIST  │───▶│  RISK GATE  │
│             │    │             │    │             │    │             │
│  Santiment  │    │  Normalize  │    │  Venice AI  │    │   Risk      │
│  API fetch  │    │  z-scores   │    │  inference  │    │   Policy    │
│  9 metrics  │    │  3 playbooks│    │  deliberate │    │  14 checks  │
│  8 assets   │    │  score+rank │    │  thesis     │    │  fast-lane  │
└─────────────┘    └─────────────┘    └─────────────┘    └──────┬──────┘
                                                                 │
┌─────────────┐    ┌─────────────┐    ┌─────────────┐           │
│   NOTARY    │◀───│  EXECUTOR   │◀───│    QUOTE    │◀──────────┘
│             │    │             │    │             │
│  Filecoin   │    │  Uniswap    │    │  Trading    │
│  receipt    │    │  SwapRouter │    │  API / v3   │
│  + x402 API │    │  approve +  │    │  on-chain   │
│  endpoints  │    │  swap       │    │  quoter     │
└─────────────┘    └─────────────┘    └─────────────┘
```

### The 5-Role Committee

| Role | Module | Responsibility |
|---|---|---|
| **Scout** | `src/scout` | Pulls 9 Santiment metrics for 8 Base-tradable assets |
| **Analyst** | `src/analyst` | Normalizes signals (z-scores, percentiles, ROC) and scores across 3 playbooks |
| **Strategist** | `src/strategist` | Uses Venice AI to resolve signal ambiguity and produce a constrained decision |
| **Risk Officer** | `src/risk` | Enforces delegation policy — 14 deterministic checks, fast-lane exit triggers |
| **Executor / Notary** | `src/executor` + `src/notary` | Swaps on Uniswap, stores decision receipt on Filecoin |

---

## Signal Stack

### Assets (Santiment-covered, Base-tradable)

| Slug | Token | Uniswap Pool |
|---|---|---|
| `ethereum` | WETH | USDC/WETH 0.05% |
| `weth` | WETH | USDC/WETH 0.05% |
| `wrapped-bitcoin` | cbBTC | USDC/cbBTC 0.30% |
| `aave` | AAVE | USDC/AAVE 0.30% |
| `uniswap` | UNI | USDC/UNI 0.30% |
| `chainlink` | LINK | USDC/LINK 0.30% |
| `aerodrome-finance` | AERO | USDC/AERO 0.30% |
| `virtual-protocol` | VIRTUAL | USDC/VIRTUAL 1.00% |

> **Note:** On Base Sepolia testnet, the active universe is restricted to ETH (WETH) only — other tokens lack testnet contracts and liquidity pools.

### Santiment Metrics

| Metric | Signal Type | Primary Use |
|---|---|---|
| `social_dominance_total` | Social | Narrative rotation detection |
| `sentiment_weighted_total` | Social | Contrarian tops/bottoms |
| `exchange_inflow_usd` | On-chain | Sell pressure / distribution |
| `exchange_outflow_usd` | On-chain | Accumulation signal |
| `age_consumed` | On-chain | Old-holder exit warning |
| `daily_active_addresses` | On-chain | Usage confirmation |
| `network_growth` | On-chain | Trend confirmation |
| `mvrv_usd` | Valuation | Over/undervaluation regime |
| `whale_transaction_count_100k_usd_to_inf` | On-chain | Smart money activity |

### Strategy Playbooks

**Early Narrative Breakout** — attention rising before price, on-chain confirmation, non-euphoric sentiment
```
social_dominance ↑ + sentiment improving (not extreme) + active_addresses ↑
+ exchange_inflows flat + whale_tx ↑
→ action: buy | horizon: 24h–72h
```

**Euphoria Fade / De-Risk** — crowd is in, old holders waking up, distribution pressure building
```
social_dominance at 80th+ pct + sentiment euphoric + age_consumed spiking
+ exchange_inflows ↑ + MVRV > 2.0
→ action: exit | horizon: immediate
```

**Capitulation Rebound** — panic overshooting, smart money accumulating, forced selling exhausting
```
sentiment at 25th- pct + MVRV < 1.0 + exchange_outflows ↑
+ whale accumulation + active_addresses stabilizing
→ action: buy | size: 1pct | horizon: 72h
```

---

## Safety Architecture

### Delegation Policy (14 checks)

Every trade must pass all of these before execution:

1. `action_validity` — action + slug are well-formed
2. `allowlist` — asset is on the approved trading list
3. `delegation_expiry` — delegation has not expired
4. `data_freshness` — signal data is < 2 hours old
5. `max_notional` — single trade ≤ $500 USD
6. `daily_turnover` — daily volume ≤ $1,000 USD
7. `delegation_cap` — lifetime delegation spend cap respected
8. `cooldown` — ≥ 2 minutes since last trade (exits bypass)
9. `max_positions` — ≤ 5 concurrent open positions
10. `concentration` — single asset ≤ 25% of portfolio
11. `min_confidence` — LLM confidence ≥ 35%
12. `confidence_vs_size` — 5pct requires ≥ 70%, 3pct requires ≥ 50%
13. `min_liquidity` — pool liquidity ≥ $50,000
14. `usdc_balance` — sufficient balance for the trade

### Fast-Lane Exits (bypass LLM, deterministic)

Immediate risk-off triggers that skip deliberation:

- Exchange inflows spike > 50% in 24h
- Age consumed spikes > 100% in 24h
- Sentiment reaches 95th percentile (extreme euphoria)
- Social dominance > 90th pct AND age consumed rising > 30%

### Model Escalation

- Routine cycles: `openai-gpt-54` via Venice AI (fast, cost-efficient)
- High-conviction cycles (composite score > 0.75): `openai-gpt-54` via Venice AI

LLM inference is powered by **Venice AI** — private, no-data-retention reasoning for all agent deliberation.

---

## Decision Receipts

Every cycle — whether it trades or holds — produces a **DecisionReceipt**:

```json
{
  "id": "uuid",
  "agentIdentity": "0x...",
  "cycleId": "uuid",
  "scoredAssets": [...],
  "deliberation": {
    "decision": {
      "action": "buy",
      "slug": "ethereum",
      "sizeBucket": "3pct",
      "confidence": 0.68,
      "thesis": "Social dominance rising...",
      "invalidationCondition": "Exchange inflows spike..."
    },
    "modelUsed": "openai-gpt-54"
  },
  "riskGate": { "approved": true, "checks": [...] },
  "execution": { "txHash": "0x...", "amountIn": "...", "amountOut": "..." },
  "receiptHash": "0x...",
  "attestationTxHash": "0x...",
  "filecoinCid": "bafybeig...",
  "version": "1.0"
}
```

The `receiptHash` is `keccak256(canonicalJson(receipt))`. The full payload is pinned to Filecoin/IPFS via Lighthouse and the receipt is exposed as a paid API endpoint via x402.

---

## Project Structure

```
synth-x/
├── src/
│   ├── types/          # Shared TypeScript types across all modules
│   ├── scout/          # Santiment API — signal ingestion
│   ├── analyst/        # Normalization + 3-playbook scoring engine
│   ├── strategist/     # Venice AI LLM deliberation
│   ├── risk/           # Local delegation policy engine — 14 deterministic checks, fast-lane exits
│   ├── executor/       # Uniswap quote + swap execution on Base
│   ├── notary/         # Filecoin storage of decision receipts
│   ├── integrations/   # ENS identity + Locus paid context
│   ├── api/            # x402 pay-per-request API server
│   ├── price/          # Binance WebSocket real-time ETH/USD feed
│   └── loop/           # Main orchestration loop (cron + event)
├── .env                # API keys (never commit)
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env` and fill in your keys:

```bash
# Required
SANTIMENT_API_KEY=your_santiment_key
BASE_RPC_URL=https://sepolia.base.org

# Strongly recommended
VENICE_API_KEY=your_venice_key
UNISWAP_API_KEY=your_uniswap_key
FILECOIN_API_TOKEN=your_lighthouse_key
LOCUS_API_KEY=your_locus_key

# For live execution
AGENT_PRIVATE_KEY=0x...
AGENT_ADDRESS=0x...

# Optional — defaults shown
CRON_SCHEDULE="*/2 * * * *"
SIGNAL_WINDOW_DAYS=30
CANDIDATE_TOP_N=5
DELEGATION_MAX_NOTIONAL_USD=500
DELEGATION_DAILY_TURNOVER_USD=1000
DRY_RUN=true
SKIP_ON_CHAIN=false
SKIP_FILECOIN=false
```

### 3. Run in observation mode (no execution)

```bash
npm run dev
```

Murmur will run the full loop — sense, score, deliberate, risk gate — but skip live execution and on-chain attestation until `AGENT_PRIVATE_KEY` is set.

### 4. Test individual modules

```bash
# Test Santiment signal fetch
npm run scout

# Test scoring engine with synthetic data
npm run analyst

# Test Venice deliberation (requires VENICE_API_KEY)
tsx src/strategist/index.ts

# Test risk gate
tsx src/risk/index.ts

# Test Filecoin upload (requires FILECOIN_API_TOKEN)
tsx src/notary/index.ts
```

### 5. Run live

```bash
# Dry run (all checks, no real transactions)
DRY_RUN=true npm start

# Live mode
DRY_RUN=false npm start
```

---

## Prize Tracks

This project is submitted to the following tracks:

| Track | Sponsor | Why We Qualify |
|---|---|---|
| **Synthesis Open Track** | Synthesis Community | Open to all — fully autonomous, attested, novel |
| **Let the Agent Cook** | Protocol Labs | Full autonomous loop: sense → score → deliberate → risk-gate → execute → store |
| **Private Agents, Trusted Actions** | Venice | Venice AI provides private, no-data-retention LLM inference for all deliberation — the agent's reasoning stays confidential |
| **Agentic Finance (Uniswap API)** | Uniswap | Uniswap Trading API is the execution layer — real TxIDs on Base Sepolia |
| **Autonomous Trading Agent** | Base | Autonomous trading agent deployed on Base with novel signal stack |
| **Best Use Case with Agentic Storage** | Filecoin | Decision receipts stored on Filecoin Onchain Cloud — verifiable audit trail |
| **ENS Identity** | ENS | Agent wallet resolved to ENS name at startup — human-readable on-chain identity |
| **Paid Agent Context** | Locus | Locus wraps external data APIs with USDC payments — Murmur pays for market context before each deliberation |
| **Pay-Per-Request Data** | Merit | x402 protocol exposes decision receipts and signal data as paid API endpoints |

---

## On-Chain Identity

Murmur is a registered participant in The Synthesis with an ERC-8004 identity on Base Sepolia.

- **Registration Tx:** [View on BaseScan](https://sepolia.basescan.org/tx/0x6b642f84e0be8913e2123dbcc64f401832ab06d47c7716abd36a93191b49b72f)
- **Network:** Base Sepolia
- **Standard:** [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004)

---

## The Principle

> Don't buy because people are bullish.
> Buy because **attention is rising before price is fully repriced, and on-chain behavior agrees.**

Murmur doesn't trade noise. It trades **divergence** — the gap between what the crowd is saying and what the chain is doing. When those two agree, and the risk gate approves, it acts. When they conflict, it holds and attests that too.

Every decision has a receipt. Every receipt has a hash. Every hash is on-chain.

---

*Built with Venice AI + Claude · The Synthesis Hackathon 2025*