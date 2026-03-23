# Murmur

<!-- MARKEE:START:0x56e7f700be36b49bb29f384c48318fdab66182d8 -->
> 🪧 **[Markee](https://markee.xyz/ecosystem/platforms/github/0x56e7f700be36b49bb29f384c48318fdab66182d8)** — *This space is available.*
>
> *Be the first to buy a message for 0.001 ETH on the [Markee App](https://markee.xyz/ecosystem/platforms/github/0x56e7f700be36b49bb29f384c48318fdab66182d8).*
<!-- MARKEE:END:0x56e7f700be36b49bb29f384c48318fdab66182d8 -->

```
  ▓▓▓   ▓▓▓
  ▓▓▓▓ ▓▓▓▓ █ █ █▀▄ █▄ ▄█ █ █ █▀▄
  ▓▓ ▓▓▓ ▓▓ █ █ ██▀ █ ▀ █ █ █ ██▀
  ▓▓  ▓  ▓▓ ▀▀▀ ▀ ▀ ▀   ▀ ▀▀▀ ▀ ▀
  ░░     ░░ ░░░░░░░░░░░░░░░░░░░░░░░
        ═══ LISTEN. TRADE. REPEAT. ═══
```

> *"It hears the market before the market hears itself."*

Murmur is an autonomous DeFi trading agent that converts real-time social sentiment and onchain signals into permission-gated trade execution on Base Sepolia. Every decision is cryptographically signed, stored on Filecoin, and linked to the agent's onchain identity via ERC-8004.

Users connect their wallet, deposit USDC into a non-custodial TradeVault, and set trading limits. The agent trades autonomously through `vault.executeTrade()` within those onchain-enforced bounds. No custody. No trust assumptions. Full audit trail.

Built for [The Synthesis Hackathon](https://synthesis.devfolio.co) by **Murmur** (AI agent) + **Temitayo Daniel** ([@Timidan_x](https://x.com/Timidan_x)).

---

## Deployed Contracts (Base Sepolia)

| Contract | Address | BaseScan |
|----------|---------|----------|
| **VaultFactory** | `0x4cc4e528Ee35Ee11CB1b7843882fdaDb332fF183` | [View](https://sepolia.basescan.org/address/0x4cc4e528Ee35Ee11CB1b7843882fdaDb332fF183) |
| **TradeVault** (legacy demo) | `0x14114283D2f1471344907061BF49EB15daF9cB1E` | [View](https://sepolia.basescan.org/address/0x14114283D2f1471344907061BF49EB15daF9cB1E) |
| **Agent Wallet** | `0x0a3C305cC7645241AEdE654C75341a3b98aF7d66` | [View](https://sepolia.basescan.org/address/0x0a3C305cC7645241AEdE654C75341a3b98aF7d66) |
| **USDC (Base Sepolia)** | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | [View](https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e) |
| **Uniswap SwapRouter02** | `0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4` | [View](https://sepolia.basescan.org/address/0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4) |
| **ERC-8004 Registration** | — | [Tx](https://sepolia.basescan.org/tx/0x6b642f84e0be8913e2123dbcc64f401832ab06d47c7716abd36a93191b49b72f) |

The VaultFactory deploys a unique TradeVault per user on first deposit. Each vault is owned by the user — the agent has permission only to call `executeTrade()`, bounded by onchain limits.

---

## How It Works

```
1. Connect Wallet          RainbowKit on Base Sepolia. Sign-in-with-wallet.
2. Deposit USDC            First deposit deploys your personal TradeVault via VaultFactory.
3. Configure               Max trade size, risk profile, daily trade cap. Autopilot ON by default.
4. Agent Trades            Every 2 min: Scout → Analyst → Strategist → Risk Gate → executeTrade()
5. Full Audit Trail        Every decision attested on Filecoin. Receipts available via x402 API.
```

---

## Architecture

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   SCOUT     │───▶│   ANALYST   │───▶│ STRATEGIST  │───▶│  RISK GATE  │
│             │    │             │    │             │    │             │
│  Santiment  │    │  Normalize  │    │  Venice AI  │    │   Risk      │
│  API fetch  │    │  z-scores   │    │  llama-3.3  │    │   Policy    │
│  9 metrics  │    │  3 playbooks│    │  -70b infer │    │  14 checks  │
│  8 assets   │    │  score+rank │    │  thesis     │    │  fast-lane  │
└─────────────┘    └─────────────┘    └─────────────┘    └──────┬──────┘
                                                                │
                                                   ┌────────────▼────────────┐
                                                   │      TRADEVAULT         │
                                                   │                         │
                                                   │  Per-user non-custodial │
                                                   │  vault via VaultFactory │
                                                   │  executeTrade() gated   │
                                                   │  by max size + daily cap│
                                                   └────────────┬────────────┘
                                                                │
┌─────────────┐    ┌─────────────┐    ┌─────────────┐          │
│   NOTARY    │◀───│  EXECUTOR   │◀───│    QUOTE    │◀─────────┘
│             │    │             │    │             │
│  Filecoin   │    │  Uniswap    │    │  Trading    │
│  receipt    │    │  SwapRouter │    │  API / v3   │
│  + x402 API │    │  via vault  │    │  on-chain   │
│  endpoints  │    │  executeTrade   │  quoter     │
└─────────────┘    └─────────────┘    └─────────────┘
```

### The Agent Committee

| Role | Module | What It Does |
|---|---|---|
| **Scout** | `src/scout` | Pulls 9 Santiment metrics for 8 Base-tradable assets every cycle |
| **Analyst** | `src/analyst` | Normalizes signals (z-scores, percentiles, ROC), scores across 3 playbooks |
| **Strategist** | `src/strategist` | Venice AI (`llama-3.3-70b`) resolves signal ambiguity, produces a constrained buy/reduce/exit/hold decision |
| **Risk Officer** | `src/risk` | 14 deterministic checks + fast-lane exit triggers. No LLM involved — pure policy enforcement |
| **Executor** | `src/executor` | Quotes via Uniswap, swaps through user's TradeVault on Base Sepolia |
| **Notary** | `src/notary` | Stores decision receipts on Filecoin, exposes them via x402 paid API |

---

## Signal Stack

### Santiment Metrics (9 per asset, per cycle)

| Metric | Type | Use |
|---|---|---|
| `social_dominance_total` | Social | Narrative rotation detection |
| `sentiment_weighted_total` | Social | Contrarian tops/bottoms |
| `exchange_inflow_usd` | Onchain | Sell pressure / distribution |
| `exchange_outflow_usd` | Onchain | Accumulation signal |
| `age_consumed` | Onchain | Old-holder exit warning |
| `daily_active_addresses` | Onchain | Usage confirmation |
| `network_growth` | Onchain | Trend confirmation |
| `mvrv_usd` | Valuation | Over/undervaluation regime |
| `whale_transaction_count_100k_usd_to_inf` | Onchain | Smart money activity |

### Strategy Playbooks

- **Early Narrative Breakout** — Attention rising before price. Onchain confirms. Not euphoric yet. Action: buy.
- **Euphoria Fade** — Crowd is in, old holders waking, distribution building. Action: exit.
- **Capitulation Rebound** — Panic overshooting, smart money accumulating. Action: buy small.

---

## Safety Architecture

### 14-Check Delegation Policy

Every trade passes all checks before execution:

`action_validity` · `allowlist` · `delegation_expiry` · `data_freshness` · `max_notional` · `daily_turnover` · `delegation_cap` · `cooldown` · `max_positions` · `concentration` · `min_confidence` · `confidence_vs_size` · `min_liquidity` · `usdc_balance`

### Fast-Lane Exits (deterministic, bypass LLM)

- Exchange inflow spike > 50% in 24h
- Age consumed spike > 100% in 24h
- Sentiment at 95th percentile (extreme euphoria)
- Social dominance > 90th pct + age consumed rising > 30%

---

## Decision Receipts

Every cycle produces a cryptographically attested receipt:

```json
{
  "agentIdentity": "0x...",
  "decision": { "action": "buy", "slug": "ethereum", "confidence": 0.68 },
  "riskGate": { "approved": true, "checks": [...] },
  "execution": { "txHash": "0x..." },
  "receiptHash": "keccak256(...)",
  "filecoinCid": "bafybeig..."
}
```

Full payload pinned to Filecoin via Lighthouse. Receipts exposed as paid API endpoints via x402 (Merit).

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Chain** | Base Sepolia (EVM L2) |
| **Contracts** | Solidity — VaultFactory + TradeVault |
| **Agent LLM** | Venice AI (`llama-3.3-70b`) — private, no-data-retention inference |
| **Signals** | Santiment API (9 social + onchain metrics) |
| **DEX** | Uniswap V3 SwapRouter on Base Sepolia |
| **Storage** | Filecoin / IPFS via Lighthouse |
| **Identity** | ERC-8004 onchain agent registry + ENS resolution |
| **Multi-agent** | OpenServ SDK — capabilities exposed as callable agent service |
| **Paid API** | x402 protocol (Merit) — decision receipts as pay-per-request endpoints |
| **Frontend** | React + Vite + RainbowKit + wagmi + GSAP |
| **Backend** | Node.js + Express + WebSocket |

---

## Project Structure

```
synth-x/
├── contracts/src/
│   ├── TradeVault.sol       # Non-custodial vault — user USDC, agent trade access, onchain limits
│   └── VaultFactory.sol     # Deploys one TradeVault per user
├── dashboard/src/
│   ├── pages/Landing.tsx    # Landing page with glitch ASCII logo + GSAP animations
│   ├── components/          # ConfigPanel, Header, Summary, CurrentDecision, DecisionLog, etc.
│   ├── hooks/useSocket.ts   # WebSocket for real-time dashboard updates
│   └── styles/terminal.css  # Terminal-themed UI
├── src/
│   ├── scout/               # Santiment signal ingestion
│   ├── analyst/             # Normalization + playbook scoring
│   ├── strategist/          # Venice AI deliberation
│   ├── risk/                # 14-check delegation policy
│   ├── executor/            # Uniswap quote + swap via TradeVault
│   ├── notary/              # Filecoin receipt storage + ERC-8004 attestation
│   ├── session/             # Wallet auth (SIWE)
│   ├── integrations/        # ENS, OpenServ, Locus
│   ├── api/                 # x402 paid API server
│   ├── price/               # Binance WebSocket ETH/USD feed
│   └── loop/                # Main orchestration loop (cron + WebSocket broadcast)
├── Dockerfile
├── render.yaml
└── package.json
```

---

## Setup

```bash
npm install
cp .env.example .env   # Fill in API keys
npm run dev             # Start agent + dashboard
```

Dashboard runs at `http://localhost:5173` (landing page at `/`, app at `#/app`).

---

## Prize Tracks

| Track | Sponsor | Integration |
|---|---|---|
| **Synthesis Open Track** | Synthesis | Fully autonomous, attested, novel |
| **Let the Agent Cook** | Protocol Labs | Full autonomous loop: sense → score → deliberate → risk-gate → execute → store |
| **Private Agents, Trusted Actions** | Venice | Private LLM inference — agent reasoning stays confidential |
| **Agentic Finance** | Uniswap | Uniswap V3 is the execution layer — real swaps on Base Sepolia |
| **Autonomous Trading Agent** | Base | Autonomous agent deployed on Base with novel signal stack |
| **Agentic Storage** | Filecoin | Decision receipts stored on Filecoin — verifiable audit trail |
| **ENS Identity** | ENS | Agent wallet resolved to ENS name — human-readable onchain identity |
| **Multi-Agent Service** | OpenServ | Capabilities exposed as callable OpenServ agent service |
| **Pay-Per-Request Data** | Merit | x402 protocol exposes receipts as paid API endpoints |

---

## The Principle

> Don't buy because people are bullish.
> Buy because **attention is rising before price is fully repriced, and onchain behavior agrees.**

Murmur trades divergence — the gap between what the crowd says and what the chain does. When those align and the risk gate approves, it acts. When they conflict, it holds. Every decision has a receipt. Every receipt has a hash. Every hash is onchain.

---

*Built with Venice AI + Claude for The Synthesis Hackathon 2025*
