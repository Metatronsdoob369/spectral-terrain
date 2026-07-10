/**
 * SPECTRAL TERRAIN — Financial Terrain Refinery
 *
 * Nightly orchestrator for the finance-crypto domain.
 * Fetches pool state snapshots → embeds as 3072-D temporal vectors
 * → upserts to Qdrant → writes signed terrain pack.
 *
 * Run order within the circadian cycle:
 *   00:30 — refinery-finance.ts (this script)
 *   01:00 — engine/circadian.ts --domain finance-crypto
 *   02:00 — engine/navigate-finance.ts (agent instinct formation)
 *
 * Usage:
 *   npx tsx scripts/refinery-finance.ts [--dry-run]
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

import { fetchUniswapPools, fetchPolymarketMarkets } from "./fetch-finance-snapshot.js";
import { serializePoolState } from "../domains/finance-crypto-serialize.js";
import { predictFinanceTplus1 } from "../domains/finance-crypto-tplus1.js";
import { buildTemporalVector, computeHeat, computeShatter } from "../engine/embed.js";
import { loadCentroid } from "../engine/calibrate.js";
import type { PoolState, FinancialStateRecord } from "../contracts/finance-crypto.domain.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const QDRANT_URL        = "http://127.0.0.1:6340";
const HEATMAP_COLLECTION = "spectral-heatmap";   // 3072-D — shared with roblox-luau
const STORE_DIR         = join(ROOT, "store");
const TELEMETRY_DIR     = join(ROOT, "telemetry");

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
}

function ensureDirs() {
  for (const d of [STORE_DIR, TELEMETRY_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

function log(msg: string, meta: Record<string, unknown> = {}) {
  const entry = { ts: new Date().toISOString(), ...meta, msg };
  appendFileSync(
    join(TELEMETRY_DIR, "finance-refinery.jsonl"),
    JSON.stringify(entry) + "\n",
  );
  console.log(`  ${msg}`);
}

/** Load yesterday's pack to get t_minus1 for each pool */
function loadPreviousPack(date: string): Map<string, PoolState> {
  const prev = new Date(date);
  prev.setDate(prev.getDate() - 1);
  const prevDate = prev.toISOString().slice(0, 10);
  const packPath = join(STORE_DIR, `finance-crypto-${prevDate}.jsonl`);

  if (!existsSync(packPath)) return new Map();

  const map = new Map<string, PoolState>();
  const lines = readFileSync(packPath, "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as FinancialStateRecord;
      map.set(record.pool_id, record.t_now);
    } catch { /* skip malformed lines */ }
  }
  return map;
}

/** BLAKE2b-256 signature of a file's content */
function signPack(packPath: string): string {
  const content = readFileSync(packPath);
  const hash = createHash("blake2b512").update(content).digest("hex");
  return hash;
}

/** Ensure the spectral-heatmap collection exists in Qdrant */
async function ensureCollection() {
  const res = await fetch(`${QDRANT_URL}/collections/${HEATMAP_COLLECTION}`);
  if (res.ok) return;

  await fetch(`${QDRANT_URL}/collections/${HEATMAP_COLLECTION}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vectors: { size: 3072, distance: "Cosine" } }),
  });
  log(`Created Qdrant collection: ${HEATMAP_COLLECTION} (dim=3072)`);
}

/** Upsert a single terrain point to Qdrant */
async function upsertPoint(
  id: string,
  vector: number[],
  payload: Record<string, unknown>,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return;
  const res = await fetch(`${QDRANT_URL}/collections/${HEATMAP_COLLECTION}/points`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      points: [{ id, vector, payload }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Qdrant upsert failed: ${res.status} ${text}`);
  }
}

// ─────────────────────────────────────────────────────────────────
// MAIN REFINERY
// ─────────────────────────────────────────────────────────────────

async function runRefinery(dryRun: boolean) {
  ensureDirs();
  const date = today();
  const packPath = join(STORE_DIR, `finance-crypto-${date}.jsonl`);
  const sigPath  = join(STORE_DIR, `finance-crypto-${date}.sig`);

  log(`Starting finance refinery — ${date}`, { dry_run: dryRun });

  // Load prior day's states for t_minus1
  const prevPack = loadPreviousPack(date);
  log(`Loaded ${prevPack.size} prior pool states for temporal delta`);

  // Fetch today's snapshots
  const [uniPools, polyMarkets] = await Promise.allSettled([
    fetchUniswapPools(),
    fetchPolymarketMarkets(),
  ]);

  const allPools: PoolState[] = [
    ...(uniPools.status   === "fulfilled" ? uniPools.value   : (log("Uniswap fetch failed: " + (uniPools as PromiseRejectedResult).reason?.message), [])),
    ...(polyMarkets.status === "fulfilled" ? polyMarkets.value : (log("Polymarket fetch failed: " + (polyMarkets as PromiseRejectedResult).reason?.message), [])),
  ];

  log(`Fetched ${allPools.length} pools/markets total`);

  if (allPools.length === 0) {
    log("No pools fetched — aborting refinery run", { status: "abort" });
    return;
  }

  if (!dryRun) await ensureCollection();

  const centroid = loadCentroid("finance-crypto");
  if (!centroid) log("No centroid yet — shatter will be 0 until calibration run");

  let upserted = 0;
  let errors   = 0;
  const packLines: string[] = [];

  for (const pool of allPools) {
    try {
      const tMinus1 = prevPack.get(pool.pool_id) ?? null;

      // Serialize all three time slots as prose
      const tMinus1Text = tMinus1
        ? serializePoolState(tMinus1)
        : serializePoolState({ ...pool, timestamp: pool.timestamp - 86400 }); // neutral prior
      const tNowText   = serializePoolState(pool);
      const tPlus1Text = predictFinanceTplus1(pool, tMinus1);

      // Embed → 3072-D temporal vector
      const tv = await buildTemporalVector(tMinus1Text, tNowText, tPlus1Text);

      const heat    = computeHeat(tv.concat);
      const shatter = centroid ? computeShatter(tv.concat, centroid) : 0;

      // Deterministic UUID from pool_id + date
      const pointId = createHash("sha256")
        .update(`finance-crypto:${pool.pool_id}:${date}`)
        .digest("hex")
        .slice(0, 32);

      const payload = {
        domain:      "finance-crypto",
        pool_id:     pool.pool_id,
        source:      pool.source,
        timestamp:   pool.timestamp,
        date,
        heat,
        shatter,
        tplus1_method: "delta-extrapolation-v1",
        kind:        "canonical",
      };

      await upsertPoint(pointId, tv.concat, payload, dryRun);

      // Write to pack (for tomorrow's t_minus1)
      const record: FinancialStateRecord = {
        domain:       "finance-crypto",
        pool_id:      pool.pool_id,
        timestamp:    pool.timestamp,
        t_now:        pool,
        t_minus1:     tMinus1,
        raw_snapshot: pool,
      };
      packLines.push(JSON.stringify(record));

      upserted++;
      if (dryRun) {
        console.log(`  [DRY] ${pool.pool_id} — heat=${heat.toFixed(2)} shatter=${shatter.toFixed(4)}`);
      }
    } catch (e) {
      errors++;
      log(`Error processing ${pool.pool_id}: ${(e as Error).message}`, { pool_id: pool.pool_id, error: true });
    }
  }

  // Write terrain pack
  if (!dryRun && packLines.length > 0) {
    writeFileSync(packPath, packLines.join("\n") + "\n");

    // BLAKE2b sign the pack
    const sig = signPack(packPath);
    writeFileSync(sigPath, JSON.stringify({ date, sig, algo: "blake2b512", points: upserted }));

    log(`Pack written: ${packPath} (${packLines.length} records)`, { pack: packPath });
    log(`Pack signed:  ${sigPath}`, { sig: sig.slice(0, 16) + "..." });
  }

  log(`Refinery complete — ${upserted} upserted, ${errors} errors`, {
    status: "done", upserted, errors, dry_run: dryRun,
  });
}

// ─────────────────────────────────────────────────────────────────
// CLI ENTRY
// ─────────────────────────────────────────────────────────────────

const dryRun = process.argv.includes("--dry-run");
if (dryRun) console.log("\n⚠️  DRY RUN — no Qdrant writes, no pack written\n");

await runRefinery(dryRun);
