/**
 * FINANCE-CRYPTO — Data Fetchers
 *
 * Fetches pool state snapshots from:
 *   - Uniswap v3 subgraph (The Graph, free tier)
 *   - Polymarket CLOB REST API (no auth required for market data)
 *
 * Both return PoolState[] with all fields normalized to [0,1].
 * Called by scripts/refinery-finance.ts during the nightly circadian cycle.
 *
 * Usage (standalone, dry-run):
 *   npx tsx scripts/fetch-finance-snapshot.ts --dry-run
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import { logNorm, neutralPoolState } from "../contracts/finance-crypto.domain.js";
import type { PoolState } from "../contracts/finance-crypto.domain.js";

// ─────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────

// Uniswap v3 REST API (no API key required, replaces deprecated The Graph free tier)
const UNISWAP_API = "https://api.uniswap.org/v1/pools";

// Polymarket Gamma API — active markets with live prices and volume
const POLYMARKET_GAMMA = "https://gamma-api.polymarket.com";

// Top N pools by TVL to ingest per run
const UNISWAP_POOL_LIMIT = 20;
// Top N markets by volume to ingest per run
const POLYMARKET_MARKET_LIMIT = 20;

// Normalization scales
const LIQ_SCALE = 12;    // log10($1T) ≈ 12
const VOL_SCALE = 10;    // log10($10B) ≈ 10
const DEPTH_SCALE = 9;   // log10($1B) ≈ 9

// ─────────────────────────────────────────────────────────────────
// UNISWAP V3 REST API FETCHER
// ─────────────────────────────────────────────────────────────────

export async function fetchUniswapPools(): Promise<PoolState[]> {
  const url = `${UNISWAP_API}?chainId=1&sortBy=tvlUSD&sortDirection=desc&limit=${UNISWAP_POOL_LIMIT}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", Origin: "https://app.uniswap.org" },
  });

  if (!res.ok) {
    throw new Error(`Uniswap API fetch failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json() as {
    pools?: Array<{
      id: string;
      token0: { symbol: string };
      token1: { symbol: string };
      feeTier: string;
      token1Price: string;
      totalValueLockedUSD: string;
      volumeUSD: string;
    }>;
  };

  const pools = json.pools ?? [];
  const now   = Math.floor(Date.now() / 1000);

  return pools.map(p => {
    const tvl   = parseFloat(p.totalValueLockedUSD ?? "0");
    const vol24 = parseFloat(p.volumeUSD ?? "0");
    const price = parseFloat(p.token1Price ?? "0");
    const fee   = parseInt(p.feeTier ?? "3000") / 1_000_000;

    return {
      pool_id:      `uniswap-v3:${p.token0.symbol}-${p.token1.symbol}-${p.feeTier}`,
      source:       "uniswap-v3" as const,
      timestamp:    now,
      price:        Math.min(1, price / (1 + Math.abs(price))),
      liquidity:    logNorm(tvl, LIQ_SCALE),
      volume_24h:   logNorm(vol24, VOL_SCALE),
      spread:       0,
      depth_bid:    0,
      depth_ask:    0,
      fee_tier:     fee,
      source_has_spread: false,
    } satisfies PoolState;
  });
}

// ─────────────────────────────────────────────────────────────────
// POLYMARKET GAMMA API FETCHER
// ─────────────────────────────────────────────────────────────────

interface GammaMarket {
  id: string;
  slug: string;
  conditionId?: string;
  question?: string;
  active: boolean;
  closed: boolean;
  volume: string;          // total volume as decimal string
  volume24hr?: number;
  outcomePrices: string;   // JSON array string e.g. "[\"0.325\", \"0.675\"]"
  spread?: number;
  endDate?: string;
}

export async function fetchPolymarketMarkets(): Promise<PoolState[]> {
  const res = await fetch(
    `${POLYMARKET_GAMMA}/markets?active=true&closed=false&limit=${POLYMARKET_MARKET_LIMIT}&order=volume24hr&ascending=false`,
    { headers: { Accept: "application/json" } },
  );

  if (!res.ok) {
    throw new Error(`Polymarket Gamma fetch failed: ${res.status} ${res.statusText}`);
  }

  // Gamma returns an array directly, not {data: [...]}
  const markets = await res.json() as GammaMarket[];
  const now = Math.floor(Date.now() / 1000);

  return markets
    .filter(m => m.active && !m.closed && m.outcomePrices)
    .map(m => {
      // outcomePrices is a JSON-encoded string array: "[\"0.325\", \"0.675\"]"
      let prices: number[] = [0.5, 0.5];
      try {
        prices = (JSON.parse(m.outcomePrices) as string[]).map(Number);
      } catch { /* use default */ }

      // First outcome price = leading token (YES equivalent)
      const leadPrice = prices[0] ?? 0.5;
      const vol = parseFloat(m.volume ?? "0");

      // Polymarket binary prices always sum to exactly 1.0, so
      // raw (1 - p1 - p2) = 0 for every market. Use effective spread proxy:
      // how much price uncertainty remains — inverse of market conviction.
      //   spread = 1 - |leadPrice - 0.5| * 2
      // A market at [0.97, 0.03] → spread ≈ 0.06 (resolved, tight — canonical)
      // A market at [0.52, 0.48] → spread ≈ 0.96 (uncertain, wide — arb surface)
      // classifyPool: canonical if spread<0.15, shattered if spread>0.3
      const conviction = Math.abs(leadPrice - 0.5) * 2; // 0=uncertain, 1=resolved
      const spread = 1 - conviction;                     // 0=resolved, 1=maximally uncertain
      const vol24 = m.volume24hr ?? 0;

      return {
        pool_id:      `polymarket-clob:${m.conditionId ?? m.id}`,
        source:       "polymarket-clob" as const,
        timestamp:    now,
        price:        Math.min(1, Math.max(0, leadPrice)),
        liquidity:    logNorm(vol, VOL_SCALE),
        volume_24h:   logNorm(vol24, VOL_SCALE),
        spread:       Math.min(1, spread),
        depth_bid:    0,
        depth_ask:    0,
        fee_tier:     0,
        source_has_spread: true,
      } satisfies PoolState;
    });
}

// ─────────────────────────────────────────────────────────────────
// CLI ENTRY (dry-run mode)
// ─────────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith("fetch-finance-snapshot.ts") ||
    process.argv[1]?.endsWith("fetch-finance-snapshot.js")) {
  const dryRun = process.argv.includes("--dry-run");

  console.log("Fetching Uniswap v3 pools...");
  const uniPools = await fetchUniswapPools().catch(e => {
    console.error("  Uniswap fetch error:", e.message);
    return [] as PoolState[];
  });
  console.log(`  ${uniPools.length} pools fetched`);

  console.log("Fetching Polymarket markets...");
  const polyMarkets = await fetchPolymarketMarkets().catch(e => {
    console.error("  Polymarket fetch error:", e.message);
    return [] as PoolState[];
  });
  console.log(`  ${polyMarkets.length} markets fetched`);

  const all = [...uniPools, ...polyMarkets];
  console.log(`\nTotal: ${all.length} pools/markets`);

  if (dryRun) {
    console.log("\n--- DRY RUN: first 3 pools ---");
    console.log(JSON.stringify(all.slice(0, 3), null, 2));
    console.log("\nDry run complete. No Qdrant writes.");
  }
}
