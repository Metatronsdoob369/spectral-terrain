/**
 * FINANCE-CRYPTO — Pool State Serializer
 *
 * Converts a PoolState into structured prose for embedding via mxbai-embed-large.
 *
 * Design principle: mxbai-embed-large was trained on natural language.
 * Structured prose ("price is 0.9823, spread is tight at 0.0012") produces
 * more semantically meaningful embeddings than raw JSON or a flat number array.
 * Field names become semantic anchors in the embedding space — "spread widening"
 * and "spread tightening" land in geometrically distinct neighborhoods.
 *
 * Output is guaranteed ASCII-clean (no non-ASCII chars) — passes
 * preIngestFilter() in engine/ingest.ts with 0 stripped characters.
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import type { PoolState } from "../contracts/finance-crypto.domain.js";

// ─────────────────────────────────────────────────────────────────
// QUALITATIVE DESCRIPTORS
// These are semantic handles that help the embedder place the point
// in a meaningful neighborhood rather than a purely numeric one.
// ─────────────────────────────────────────────────────────────────

function liquidityLabel(v: number): string {
  if (v > 0.8) return "very deep";
  if (v > 0.6) return "deep";
  if (v > 0.4) return "moderate";
  if (v > 0.2) return "shallow";
  return "thin";
}

function spreadLabel(v: number): string {
  if (v < 0.001) return "extremely tight";
  if (v < 0.005) return "tight";
  if (v < 0.02)  return "normal";
  if (v < 0.05)  return "wide";
  return "very wide";
}

function priceLabel(v: number, source: PoolState["source"]): string {
  if (source === "polymarket-clob") {
    if (v > 0.85) return "high confidence YES";
    if (v > 0.65) return "leaning YES";
    if (v > 0.35) return "uncertain";
    if (v > 0.15) return "leaning NO";
    return "high confidence NO";
  }
  return `ratio ${v.toFixed(6)}`;
}

// ─────────────────────────────────────────────────────────────────
// SERIALIZER
// ─────────────────────────────────────────────────────────────────

/**
 * Serialize a PoolState into structured prose for mxbai-embed-large.
 * Output is deterministic given the same input — same pool state
 * always produces the same text, which produces the same embedding.
 */
export function serializePoolState(s: PoolState): string {
  const ts = new Date(s.timestamp * 1000).toISOString();
  const spreadDesc = s.source_has_spread
    ? `Bid-ask spread is ${spreadLabel(s.spread)} at ${s.spread.toFixed(6)}.`
    : `Bid-ask spread not available for this source.`;

  return (
    `Financial pool state. ` +
    `Pool identifier: ${s.pool_id}. ` +
    `Data source: ${s.source}. ` +
    `Snapshot time: ${ts}. ` +
    `Price: ${priceLabel(s.spread, s.source)} at ${s.price.toFixed(6)}. ` +
    `Liquidity depth is ${liquidityLabel(s.liquidity)}, normalized value ${s.liquidity.toFixed(4)}. ` +
    `24-hour trading volume normalized ${s.volume_24h.toFixed(4)}. ` +
    spreadDesc + ` ` +
    `Bid side depth within 1 percent of mid: ${s.depth_bid.toFixed(4)}. ` +
    `Ask side depth within 1 percent of mid: ${s.depth_ask.toFixed(4)}. ` +
    `Pool fee tier: ${(s.fee_tier * 100).toFixed(2)} percent. ` +
    (s.block_number ? `On-chain block: ${s.block_number}.` : `Off-chain snapshot.`)
  ).trim();
}
