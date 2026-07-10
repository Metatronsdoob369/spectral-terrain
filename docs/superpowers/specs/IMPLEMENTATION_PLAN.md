# Financial Terrain Refinery — Line-by-Line Implementation Plan

**Working directory:** `/Users/joewales/spectral-terrain/`
**Spec:** `docs/superpowers/specs/2026-06-15-financial-terrain-refinery-design.md`
**Domain:** `finance-crypto` (already in `DOMAIN_GEOMETRY` as temporal: true, dim: 3072)
**Pattern to follow:** `domains/roblox-luau-tplus1.ts` → `engine/ingest.ts` → `engine/circadian.ts`

---

## Constraint Checklist (verify before each step)

- [ ] All embedding goes through local Ollama (`http://127.0.0.1:11434`) — no external embedding APIs
- [ ] Qdrant target: `spectral-heatmap` collection (3072-D, already exists for roblox-luau domain)
- [ ] Terrain packs BLAKE2b signed before circadian loads them
- [ ] Refinery is a script (run-and-exit), not a daemon
- [ ] Financial domain logic lives in `domains/finance-crypto/` — engine stays untouched
- [ ] Agent never navigates live terrain — only yesterday's signed pack

---

## Step 1 — Domain Contract

**File to create:** `contracts/finance-crypto.domain.ts`

Pattern: follow `contracts/roblox-luau.domain.ts` structure.

Define the `FinancialStateRecord` type that the refinery produces and the ingest engine consumes:

```typescript
export interface PoolState {
  pool_id: string;         // deterministic: "uniswap-v3:<token0>-<token1>-<fee>"
  source: "uniswap-v3" | "uniswap-v4" | "polymarket-clob";
  timestamp: number;       // unix seconds — block timestamp or snapshot time
  price: number;           // normalized token ratio (token1/token0) or YES price [0,1]
  liquidity: number;       // total liquidity (log-scaled to [0,1])
  volume_24h: number;      // log-scaled to [0,1]
  spread: number;          // bid-ask spread as fraction of mid
  depth_bid: number;       // depth within 1% of mid, bid side, log-scaled
  depth_ask: number;       // depth within 1% of mid, ask side, log-scaled
  fee_tier: number;        // pool fee tier (e.g. 0.003 for 0.3%)
  block_number?: number;   // for on-chain sources — used to compute delta precision
}

export interface FinancialStateRecord {
  domain: "finance-crypto";
  pool_id: string;
  timestamp: number;
  t_now: PoolState;
  t_minus1: PoolState | null;   // null on first ingest of a pool
  raw_snapshot: unknown;        // original API response — stored for audit, not embedded
}
```

**Verification:** TypeScript compiles with `npx tsx --check contracts/finance-crypto.domain.ts`

---

## Step 2 — t+1 Predictor (Learned Residual, v1.0)

**File to create:** `domains/finance-crypto-tplus1.ts`

Pattern: follow `domains/roblox-luau-tplus1.ts`.

The Roblox predictor applies deterministic physics. Finance has no deterministic next state — the v1.0 predictor uses **delta extrapolation**: if price moved +2% from t-1 to t, the t+1 text encodes "continuing upward momentum, +2% projected." This is explicitly approximate and labeled as such in the terrain point metadata.

```typescript
import type { PoolState } from "../contracts/finance-crypto.domain.js";

/**
 * FINANCE-CRYPTO — Residual Delta t+1 Predictor (v1.0)
 *
 * Method: linear delta extrapolation from (t-1, t).
 * Not a price prediction. A geometric direction signal.
 * High uncertainty is encoded in the text — the embedder
 * places high-uncertainty states in a wider cloud, which
 * correctly raises their shatter score relative to canonical.
 *
 * v1.1 target: replace with a learned residual model trained
 * on pool state sequences.
 */
export function predictFinanceTplus1(
  t_now: PoolState,
  t_minus1: PoolState | null,
): string {
  // If no prior state, return a stable placeholder description
  if (!t_minus1) {
    return `pool ${t_now.pool_id} initial state: price ${t_now.price.toFixed(6)}, ` +
           `liquidity ${t_now.liquidity.toFixed(4)}, spread ${t_now.spread.toFixed(4)}, ` +
           `no prior state — direction unknown`;
  }

  const dPrice = t_now.price - t_minus1.price;
  const dLiq   = t_now.liquidity - t_minus1.liquidity;
  const dSpread = t_now.spread - t_minus1.spread;

  const direction = dPrice > 0.001 ? "upward" : dPrice < -0.001 ? "downward" : "stable";
  const liqTrend  = dLiq > 0.01 ? "deepening" : dLiq < -0.01 ? "draining" : "holding";
  const spreadTrend = dSpread > 0.001 ? "widening" : dSpread < -0.001 ? "tightening" : "stable";

  return `pool ${t_now.pool_id} projected next state: price ${direction} ` +
         `(delta ${dPrice > 0 ? "+" : ""}${dPrice.toFixed(6)}), ` +
         `liquidity ${liqTrend} (delta ${dLiq > 0 ? "+" : ""}${dLiq.toFixed(4)}), ` +
         `spread ${spreadTrend} (delta ${dSpread > 0 ? "+" : ""}${dSpread.toFixed(4)}), ` +
         `fee_tier ${t_now.fee_tier}, source ${t_now.source}`;
}
```

**Verification:** Unit test with two PoolState fixtures — confirm output is a non-empty string, confirm `null` t_minus1 produces stable placeholder.

---

## Step 3 — State Serializer (t_now → embeddable text)

**File to create:** `domains/finance-crypto-serialize.ts`

The ingest engine calls `preIngestFilter()` on raw text. Before that, we need a function that converts `PoolState` into structured prose that `mxbai-embed-large` can embed meaningfully — not raw JSON, not a number dump.

```typescript
import type { PoolState } from "../contracts/finance-crypto.domain.js";

/**
 * Serialize a PoolState into structured prose for embedding.
 *
 * Design principle: the embedder was trained on natural language.
 * Structured prose ("price is 0.9823, spread is tight at 0.0012")
 * produces more semantically meaningful embeddings than raw JSON or
 * a flat number array. Field names become semantic anchors.
 */
export function serializePoolState(s: PoolState): string {
  return (
    `Financial pool state. Pool: ${s.pool_id}. Source: ${s.source}. ` +
    `Timestamp: ${new Date(s.timestamp * 1000).toISOString()}. ` +
    `Price: ${s.price.toFixed(6)}. ` +
    `Liquidity depth: ${s.liquidity.toFixed(4)} (log-scaled). ` +
    `24-hour volume: ${s.volume_24h.toFixed(4)} (log-scaled). ` +
    `Bid-ask spread: ${s.spread.toFixed(6)}. ` +
    `Bid depth within 1 percent: ${s.depth_bid.toFixed(4)}. ` +
    `Ask depth within 1 percent: ${s.depth_ask.toFixed(4)}. ` +
    `Fee tier: ${(s.fee_tier * 100).toFixed(2)} percent. ` +
    `Block: ${s.block_number ?? "off-chain snapshot"}.`
  );
}
```

**Verification:** Output passes `preIngestFilter()` with 0 stripped characters (no non-ASCII).

---

## Step 4 — Data Fetchers

**File to create:** `scripts/fetch-finance-snapshot.ts`

Two fetchers, same output type (`PoolState[]`), same normalization layer. Run independently or together.

### 4a — Uniswap v3 Subgraph Fetcher

```typescript
// Target: Uniswap v3 subgraph (The Graph, free tier)
// Endpoint: https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3
// Query: top 20 pools by TVL, last 24h volume

const UNISWAP_SUBGRAPH = "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3";

async function fetchUniswapPools(): Promise<PoolState[]>
```

Normalization:
- `price` = `token1Price` (already a ratio in subgraph)
- `liquidity` = `log10(totalValueLockedUSD + 1) / 12` (clamped [0,1], 12 = log10($1T))
- `volume_24h` = `log10(volumeUSD_24h + 1) / 10` (clamped [0,1])
- `spread` = `0.0` (subgraph doesn't provide spread — mark as `source_has_spread: false` in metadata)
- `depth_bid`, `depth_ask` = `0.0` (not available from subgraph, filled by Polymarket fetcher)
- `fee_tier` = `feeTier / 1_000_000`
- `block_number` = `poolDayData[0].date` converted to nearest block estimate

### 4b — Polymarket CLOB Fetcher

```typescript
// Target: Polymarket CLOB REST API
// Endpoint: https://clob.polymarket.com/markets (no auth required for market data)
// Filter: active markets, YES token price, spread, volume

const POLYMARKET_CLOB = "https://clob.polymarket.com";

async function fetchPolymarketMarkets(): Promise<PoolState[]>
```

Normalization:
- `pool_id` = `"polymarket-clob:" + market.condition_id`
- `price` = `market.tokens[0].price` (YES token price, [0,1])
- `liquidity` = normalized open interest
- `volume_24h` = normalized 24h volume
- `spread` = `market.spread` (direct from API)
- `depth_bid`, `depth_ask` = from orderbook depth endpoint
- `fee_tier` = `0.0` (Polymarket takes no fee on prediction markets)

**Verification:** Both fetchers return `PoolState[]` with all required fields. Run against live APIs in `--dry-run` mode that prints without writing to Qdrant.

---

## Step 5 — Refinery Script (orchestrator)

**File to create:** `scripts/refinery-finance.ts`

This is the script that runs nightly. Orchestrates Steps 3 + 4 + embed + upsert:

```
Usage: npx tsx scripts/refinery-finance.ts [--dry-run] [--domain finance-crypto]

Flow:
1. fetchUniswapPools()   → PoolState[]
2. fetchPolymarketMarkets() → PoolState[]
3. For each pool:
   a. Load t_minus1 from previous pack (or null if first ingest)
   b. serializePoolState(t_now)         → prose string for v_t embed
   c. predictFinanceTplus1(t_now, t_minus1) → prose string for v_t+1 embed
   d. Embed t_minus1 (prose), t_now (prose), t_plus1 (prose) → 3 × 1024-D vectors
   e. Concatenate → 3072-D TemporalVector (matches terrain.contract.ts)
   f. Compute heat (Manhattan resonance) and shatter (vs. current centroid)
   g. Upsert to Qdrant spectral-heatmap with domain="finance-crypto"
4. Write state pack: store/finance-crypto-YYYY-MM-DD.jsonl (t_now for each pool)
   → this becomes t_minus1 for tomorrow's run
5. BLAKE2b sign the pack → store/finance-crypto-YYYY-MM-DD.sig
6. Log summary to telemetry/finance-refinery.jsonl
```

**Verification:** `--dry-run` prints all pools, no Qdrant writes. Live run upserts at least 1 point and writes pack + sig.

---

## Step 6 — Calibration Run

**File to create:** `calibration/finance-crypto-centroid.json` (output, not source)

After Step 5 produces at least 5 days of terrain points:

```bash
npx tsx engine/calibrate.ts --domain finance-crypto
```

This uses the existing `calibrate.ts` engine to compute the Diamond-Stable centroid over all `finance-crypto` points in Qdrant.

**What "canonical" means for first calibration:** All points ingested in the first 5 days with shatter < 0.05 relative to the initial mean are considered canonical. This seeds a sparse, conservative centroid. It grows through observed stability, not volume.

**Verification:** `calibration/finance-crypto-centroid.json` exists with valid 3072-D vector. Run `engine/circadian.ts --domain finance-crypto` without error.

---

## Step 7 — Circadian Integration

**File to modify:** `engine/circadian.ts`

Add a pre-step hook: before the existing Step 1 (monitor drift check), check if the financial refinery pack for today exists. If not, run the refinery.

```typescript
// At top of main():
if (domain === "finance-crypto" || !domain) {
  const todayPack = `store/finance-crypto-${today}.jsonl`;
  if (!existsSync(todayPack)) {
    console.log("⚙️  Running financial refinery pre-step...");
    // spawn refinery-finance.ts as subprocess
  }
}
```

The circadian engine already handles centroid recompute and profile update in Steps 2 + 3 — no changes needed there once the calibration from Step 6 exists.

**Verification:** `npx tsx engine/circadian.ts --domain finance-crypto` runs without error, recalibrates centroid, writes updated profile.

---

## Step 8 — Navigation Loop (Agent Instinct Formation)

**File to create:** `engine/navigate-finance.ts`

The capital agent's overnight traversal. Not a query — a path through terrain.

```
Flow:
1. Load yesterday's signed terrain pack (verify BLAKE2b before mounting)
2. Find entry point: 5 lowest-shatter pools (most canonical = most stable)
3. From each entry, walk toward high-heat, low-shatter neighbors (Qdrant KNN)
4. Record path as a sequence of (pool_id, shatter, heat, direction) tuples
5. Compute instinct weights: pools visited more = higher agent attention weight
6. Write instinct weights to store/finance-instinct-YYYY-MM-DD.json
7. Gate: instinct weights only applied to live capital agent if operator approval received
   (write to store/pending-instinct.json → human reviews → mv to store/active-instinct.json)
```

**Verification:** Navigation produces a non-empty path. Instinct weights are bounded [0,1] and sum to ≤ 1.0. Pending gate file exists before any weights are active.

---

## Step 9 — LaunchAgent (Nightly Automation)

**File to create:** `/Users/joewales/Library/LaunchAgents/com.spectral.finance-refinery.plist`

Runs at 00:30 local time (after midnight, before the existing circadian agent):

```xml
<key>StartCalendarInterval</key>
<dict>
  <key>Hour</key><integer>0</integer>
  <key>Minute</key><integer>30</integer>
</dict>
```

PATH must be fully specified (macOS LaunchAgent PATH stripping issue — same fix as paper-arena plist).

**Verification:** `launchctl list | grep spectral` shows the agent. Check `telemetry/finance-refinery.jsonl` the morning after first run.

---

## File Map (all new files)

```
spectral-terrain/
├── contracts/
│   └── finance-crypto.domain.ts          [Step 1]
├── domains/
│   ├── finance-crypto-tplus1.ts           [Step 2]
│   └── finance-crypto-serialize.ts        [Step 3]
├── scripts/
│   └── fetch-finance-snapshot.ts          [Step 4]
│   └── refinery-finance.ts               [Step 5]
├── calibration/
│   └── finance-crypto-centroid.json       [Step 6, output]
├── engine/
│   └── circadian.ts                       [Step 7, modify]
│   └── navigate-finance.ts               [Step 8]
├── store/
│   └── finance-crypto-YYYY-MM-DD.jsonl    [runtime output]
│   └── finance-crypto-YYYY-MM-DD.sig      [BLAKE2b signature]
│   └── finance-instinct-YYYY-MM-DD.json   [navigation output]
│   └── pending-instinct.json              [human gate]
│   └── active-instinct.json               [approved weights]
└── telemetry/
    └── finance-refinery.jsonl             [runtime log]
```

---

## Integration Point with Capital Agent

Once `active-instinct.json` exists and is approved:

The capital agent (WeaponsGradeAMEM in `financial-intel-mcp`) reads `active-instinct.json` before quoting. Pools with high instinct weight get tighter spreads (agent knows the geometry). Pools with low instinct weight get wider spreads or are skipped. The terrain shapes the quoting behavior — the agent doesn't query terrain live, it acts from weights it formed overnight.

This is the connection between the terrain factory and the capital system. The terrain is upstream. The capital decisions are downstream. They never run simultaneously.

---

## van Rijsbergen Alignment

This architecture implements his core claim — relevance as a Hermitian observable, document (here: pool state) as a vector in Hilbert space — except the space is financial state, the retrieval system is the capital agent, and relevance is opportunity geometry rather than document relevance. The same mathematical apparatus. A different domain. The book's DNA is the theoretical grounding for why this works.
