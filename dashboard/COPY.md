# murmur dashboard — copy rules and approved terms

This file is the copy contract for every user-facing string in `dashboard/`.
If you write a label, a button, an empty state, an error, or a tooltip, it
must obey the rules below and use the words in the tables below.

Internal comments, code identifiers, wire-field names, and API paths are **not**
covered. Only what a reader sees.

---

## 1. The rules (ASD-STE100 Simplified Technical English, distilled)

1. **One idea per sentence. 20 words or fewer.**
2. **Active voice.** "The venue publishes the outcome", not "the outcome is
   published by the venue".
3. **Imperative for instructions.** "Enter your handle." "Copy the key."
4. **Use articles.** "the key", "a market" — not "key", "market".
5. **One word, one meaning, everywhere.** A call is never also a "submission",
   an "entry", or a "prediction row". See the retired list in §3.
6. **Expand cryptic abbreviations** unless the term is universal (ID, URL, API,
   USD) **or** the column is too narrow **and** a tooltip defines it in plain
   words right there. Narrow ladder columns use the tooltip pattern; ribbon
   cells and panels have room, so they spell the word out.
7. **Buttons are verb + object.** "Copy the key", "Mint a runtime key",
   "Show all assets".
8. **Status, empty, and error text is a short active sentence.**
   "No market results yet." — not "no per-market data".
9. **Keep the owned domain terms.** verdict, call, market, seal, reveal, agent,
   leaderboard, ladder, venue, Fhenix. Define each once; then reuse it.
10. **Do not pad to sound friendly.** Banned: seamlessly, simply, just,
    powerful, leverage, effortless, unlock (as a verb for features).
11. **Icons beat prose** where an icon plus one word says it. Icons come from
    the shared `Ik` / `IkNav` set (16px inline, 24px nav).
12. **The type floor is 12px** and a smoke enforces it. Never shrink text to fit
    a longer word. Shorten the word, or move the meaning into the tooltip.

---

## 2. Approved terms

### 2.1 The core objects

| Term | Definition (say it this way) | Retired forms |
|---|---|---|
| **call** | One sealed prediction an agent sends to a market. | submission, entry, prediction (as a noun for the row), "the sealed thing" |
| **verdict** | The public, scored result of a call after the reveal. | — |
| **market** | A market on an external venue that murmur referees. Murmur never writes or settles one. | native market, our market |
| **window** | The five-minute period that one group of markets shares. They open, seal, and settle together. | horizon (for venue markets), cohort |
| **agent** | The bot that submits calls. It has a handle and a public record. | bot (in labels), player |
| **venue** | The external market site that publishes the outcome. Polymarket today. | oracle, price feed, source of truth |
| **leaderboard** / **ladder** | The ranked list of agents. "leaderboard" is the page; "ladder" is the table on it. | board, rankings |
| **runtime key** | The secret an agent sends on every gateway request. | api key (they are different things), token |
| **controller wallet** | The human-held wallet that signs authorizations for one agent. | owner wallet, signer |

### 2.2 The lifecycle (use these verbs, in this order)

| Term | Definition | Retired forms |
|---|---|---|
| **seal** / **sealed** | Encrypted at submission. Nobody can read the call until the reveal. | committed, locked, encrypted (as a state word), blind |
| **taking calls** | The market or window accepts new calls right now. | open (for a market), calls open, live (for a market) |
| **closed** | The market or window no longer accepts calls. | frozen |
| **reveal** | Publish the sealed call after the market closes. | decrypt, unseal |
| **resolve** / **resolved** | The venue publishes the outcome. Murmur then scores the call. | settle (as the murmur action), grade |
| **scored** | The call resolved and earned a score. | res, resolved_calls, graded |
| **open** (a call) | The call is sealed and has not resolved yet. | pending, pend, p, awaiting resolution |
| **void** | The call settled with no winner, so it earns no score. | — |

> `open` describes a **call**. `taking calls` describes a **market or window**.
> They never swap.

### 2.3 The numbers

| Shown as | Definition | Tooltip must say | Retired forms |
|---|---|---|---|
| **score** | The agent's headline score. Mean call score, less a penalty for uneven results. | "score — the agent's average call score, less a penalty for uneven results. Higher is better." | vs, verdict_score (as a label), verdict·recent |
| **floor** | The careful score. It is the lowest score the record supports, so 20 lucky calls cannot beat 200 steady ones. **The board ranks on this.** | "floor — the lowest score this record supports. The board ranks agents on it." | lb, vs·lb, lower bound |
| **win %** | Wins as a share of wins plus losses. Void calls are left out. | "win % — wins as a share of wins plus losses." | wr, win_rate |
| **scored** | How many calls finished with a win or a loss. | "scored — calls that finished and earned a score." | res |
| **open** | How many calls are still sealed and waiting. | "open — calls that are sealed and have not resolved yet." | p, pend, pending |
| **trend** | The agent's last few call scores, oldest to newest. | "trend — the last few call scores, oldest first." | — |
| **calls** | Every call on this market, open and scored together. | "calls — every call on this market, open and scored." | vol·open |
| **traded** | Money traded on the venue for this market, in USD. | exact USD, plus liquidity when known | vol (for venue volume) |
| **top score** | The best agent score on this market. | — | lead·vs |
| **avg score** | The average score across this agent's scored calls. | — | verdict, avg·wr for scores |
| **win streak** | Wins in a row, counting back from the newest call. | — | streak, "3w" |

### 2.4 Tiers

| Shown as | Definition | Retired forms |
|---|---|---|
| **·ranked** | The agent has 20 or more scored calls, so it holds a rank. | ·main, main tier |
| **·unranked** | The agent has fewer than 20 scored calls. | ·prov, provisional |

### 2.5 Numbers, never padded

Counts and ranks render as plain numbers: `1`, `7`, `42`. Never `01` or `001` —
a zero-padded count reads as an identifier.

---

## 3. Retired words — grep these to zero in user-facing strings

| Retired | Use instead |
|---|---|
| `vs`, `verdict_score` (label) | score |
| `lb`, `vs·lb` | floor |
| `wr` | win % |
| `res` | scored |
| `p`, `pend`, `pending` | open |
| `vol·open` | calls |
| `vol` (venue money) | traded |
| `lead·vs` | top score |
| `hzn` | horizon (non-venue markets only) |
| `·main` / `·prov` | ·ranked / ·unranked |
| `frozen` (market status) | closed |
| `submission` (panel title, prose) | the call |
| `encrypted` (as a row value) | sealed |
| `operator-blind` (as a bare value) | sealed, with the tooltip that explains who can read what |
| `market config` | more about this market |
| `feed unavailable` | the leaderboard is unavailable right now |
| `no per-market data` | no market results yet |
| `Chainlink`, `Pyth`, `oracle` (as the resolver) | the venue publishes the outcome |
| `t0`, `p0`, `t0_feed`, `t1_feed`, `void·band` | hidden on venue calls — they are native-price fields and do not apply |

---

## 4. Facts that must stay true

Murmur is a **pure referee**. It never writes a market and never resolves one.
The venue publishes the outcome; murmur scores the call against it. Copy must
never say murmur resolves, settles, or prices anything.

| Fact | The truth |
|---|---|
| Assets | BTC, ETH, SOL, XRP, DOGE — five, derived from the live board, never hardcoded in copy |
| Window length | five minutes |
| Horizons | there are no 1h / 1d / 1w horizons on venue markets |
| Resolver | the venue (Polymarket today), not an oracle, not Chainlink, not Pyth |
| Scoring window | all time. There is no rolling 30-day board. |
| Sealing | Fhenix FHE. On the standard path the agent seals in its own browser and murmur never holds the plain text. On the optional `/seal` path murmur does hold it, by design. Say both. |
| Chain | Base |
| Submit path | `POST /v2/gateway/calls` with `X-Murmur-Runtime-Key`. Not `/v2/gateway/calls/seal`. |

---

## 5. House patterns

- **Empty state:** `[a short active sentence]` in `ck-mono ck-dim`, inside
  square brackets. Example: `[no calls on this market yet]`.
- **Inline error:** `<InlineError/>` prefixes `[error]`. Pass a plain sentence,
  never a bare status code.
- **Page error / not found:** `<ErrorState/>`. The raw string goes in the
  collapsed "technical detail" block, never in the headline.
- **Tooltip pattern:** a short header is allowed when the tooltip defines it in
  plain words on the same row. Plain sentence first, formula second.
- **Help marker:** `ⓘ` after a column header opens the definition on hover and
  on focus. Never `?` — a reader takes `?` for a missing value.
- **Bracket buttons:** `ck-btn ck-btn-bracket`, lowercase, verb first.
