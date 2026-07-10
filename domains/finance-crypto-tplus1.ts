/**
 * FINANCE-CRYPTO — Residual Delta t+1 Predictor (v1.0)
 *
 * Method: linear delta extrapolation from (t-1, t).
 *
 * This is NOT a price prediction. It is a geometric direction signal.
 * The purpose is to give the terrain point a third dimensional slot
 * that encodes momentum and trajectory — so a pool accelerating toward
 * a liquidity drain occupies different geometry than one holding stable.
 *
 * High uncertainty is encoded in the prose — the embedder places
 * high-uncertainty states in a wider cloud, which correctly raises
 * their shatter score relative to canonical stable pools.
 *
 * v1.1 target: replace delta extrapolation with a learned residual
 * model trained on pool state sequences from store/finance-crypto-*.jsonl
 *
 * Called by refinery-finance.ts before embedding — produces the v_t+1
 * prose that gets embedded as the third 1024-D slot of the TemporalVector.
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import type { PoolState } from "../contracts/finance-crypto.domain.js";
import { neutralPoolState } from "../contracts/finance-crypto.domain.js";

// ─────────────────────────────────────────────────────────────────
// DIRECTION CLASSIFIERS
// ─────────────────────────────────────────────────────────────────

function priceDirection(delta: number): string {
  if (delta > 0.01)  return "strong upward movement";
  if (delta > 0.002) return "mild upward drift";
  if (delta < -0.01) return "strong downward movement";
  if (delta < -0.002) return "mild downward drift";
  return "stable";
}

function liquidityTrend(delta: number): string {
  if (delta > 0.05)  return "rapidly deepening";
  if (delta > 0.01)  return "deepening";
  if (delta < -0.05) return "rapidly draining";
  if (delta < -0.01) return "draining";
  return "holding";
}

function spreadTrend(delta: number): string {
  if (delta > 0.002) return "widening — possible stress";
  if (delta < -0.002) return "tightening — increasing confidence";
  return "stable";
}

function volumeTrend(delta: number): string {
  if (delta > 0.1)  return "surging";
  if (delta > 0.02) return "increasing";
  if (delta < -0.1) return "collapsing";
  if (delta < -0.02) return "declining";
  return "steady";
}

// ─────────────────────────────────────────────────────────────────
// CORE PREDICTOR
// ─────────────────────────────────────────────────────────────────

/**
 * Predict the next state of a financial pool as structured prose.
 *
 * Returns a string that gets embedded as v_t+1 in the TemporalVector.
 * When t_minus1 is null (first ingest), uses a neutral prior that
 * correctly places the point in mid-space with high uncertainty.
 */
export function predictFinanceTplus1(
  t_now: PoolState,
  t_minus1: PoolState | null,
): string {
  // First ingest — no delta available, encode high uncertainty
  if (!t_minus1) {
    return (
      `Pool ${t_now.pool_id} projected next state: direction unknown, no prior observation. ` +
      `Current price ${t_now.price.toFixed(6)}, ` +
      `liquidity ${t_now.liquidity.toFixed(4)}, ` +
      `spread ${t_now.spread.toFixed(6)}, ` +
      `source ${t_now.source}, fee tier ${(t_now.fee_tier * 100).toFixed(2)} percent. ` +
      `High uncertainty — first terrain observation for this pool.`
    );
  }

  const dPrice    = t_now.price     - t_minus1.price;
  const dLiq      = t_now.liquidity - t_minus1.liquidity;
  const dSpread   = t_now.spread    - t_minus1.spread;
  const dVolume   = t_now.volume_24h - t_minus1.volume_24h;
  const dDepthBid = t_now.depth_bid - t_minus1.depth_bid;
  const dDepthAsk = t_now.depth_ask - t_minus1.depth_ask;

  const projPrice    = Math.min(1, Math.max(0, t_now.price     + dPrice));
  const projLiq      = Math.min(1, Math.max(0, t_now.liquidity + dLiq));
  const projSpread   = Math.min(1, Math.max(0, t_now.spread    + dSpread));

  return (
    `Pool ${t_now.pool_id} projected next state: ` +
    `price ${priceDirection(dPrice)} toward ${projPrice.toFixed(6)}, ` +
    `liquidity ${liquidityTrend(dLiq)} toward ${projLiq.toFixed(4)}, ` +
    `spread ${spreadTrend(dSpread)} toward ${projSpread.toFixed(6)}, ` +
    `volume ${volumeTrend(dVolume)}, ` +
    `bid depth ${dDepthBid >= 0 ? "growing" : "shrinking"}, ` +
    `ask depth ${dDepthAsk >= 0 ? "growing" : "shrinking"}, ` +
    `source ${t_now.source}, fee tier ${(t_now.fee_tier * 100).toFixed(2)} percent. ` +
    `Delta extrapolation — v1.0 residual predictor.`
  );
}
