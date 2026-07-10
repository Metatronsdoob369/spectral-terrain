/**
 * FINANCE-CRYPTO DOMAIN CONTRACT
 *
 * v_t+1 method: LEARNED-RESIDUAL (v1.0: delta extrapolation)
 * Financial state has no deterministic next tick — direction is
 * extrapolated from (t-1, t) delta. v1.1 target: learned residual model.
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────
// POOL STATE (What gets embedded as v_t)
// All numeric fields normalized to [0,1] or log-scaled to [0,1]
// so the embedding space is geometrically consistent across pools.
// ─────────────────────────────────────────────────────────────────

export const PoolStateSchema = z.object({
  pool_id:      z.string(),   // "uniswap-v3:<token0>-<token1>-<fee>" or "polymarket-clob:<condition_id>"
  source:       z.enum(["uniswap-v3", "uniswap-v4", "polymarket-clob"]),
  timestamp:    z.number(),   // unix seconds — block timestamp or snapshot time

  // Normalized state fields (all [0,1])
  price:        z.number(),   // token1/token0 ratio (uniswap) or YES price (polymarket)
  liquidity:    z.number(),   // log10(TVL_USD + 1) / 12 — clamped [0,1]
  volume_24h:   z.number(),   // log10(volume_USD + 1) / 10 — clamped [0,1]
  spread:       z.number(),   // bid-ask spread as fraction of mid price
  depth_bid:    z.number(),   // depth within 1% of mid, bid side, log-scaled [0,1]
  depth_ask:    z.number(),   // depth within 1% of mid, ask side, log-scaled [0,1]
  fee_tier:     z.number(),   // pool fee as decimal (e.g. 0.003 for 0.3%)

  // Optional — not available from all sources
  block_number: z.number().optional(),
  source_has_spread: z.boolean().default(true),  // false when spread not in source API
});

export type PoolState = z.infer<typeof PoolStateSchema>;

// ─────────────────────────────────────────────────────────────────
// FINANCIAL STATE RECORD (What the refinery produces per pool per day)
// ─────────────────────────────────────────────────────────────────

export const FinancialStateRecordSchema = z.object({
  domain:      z.literal("finance-crypto"),
  pool_id:     z.string(),
  timestamp:   z.number(),
  t_now:       PoolStateSchema,
  t_minus1:    PoolStateSchema.nullable(),  // null on first ingest of a pool
  raw_snapshot: z.unknown(),                // original API response — audit only, not embedded
});

export type FinancialStateRecord = z.infer<typeof FinancialStateRecordSchema>;

// ─────────────────────────────────────────────────────────────────
// NORMALIZATION HELPERS
// ─────────────────────────────────────────────────────────────────

/** log10(value + 1) / scale, clamped to [0, 1] */
export function logNorm(value: number, scale: number): number {
  return Math.min(1, Math.max(0, Math.log10(value + 1) / scale));
}

/**
 * Canonical pool state with zero signal — used as a safe placeholder
 * when t_minus1 is unavailable. Produces a stable mid-space embedding
 * rather than a zero vector (which would falsely anchor the centroid).
 */
export function neutralPoolState(pool_id: string, source: PoolState["source"]): PoolState {
  return {
    pool_id,
    source,
    timestamp: 0,
    price:     0.5,
    liquidity: 0.5,
    volume_24h: 0.5,
    spread:    0.005,
    depth_bid: 0.5,
    depth_ask: 0.5,
    fee_tier:  0.003,
    source_has_spread: false,
  };
}
