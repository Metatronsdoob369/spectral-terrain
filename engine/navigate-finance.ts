/**
 * SPECTRAL TERRAIN — Finance Domain Navigation Loop
 *
 * The capital agent's overnight instinct formation pass.
 * Navigates yesterday's signed terrain pack — never live terrain.
 *
 * What this does:
 *   1. Verify BLAKE2b signature of today's terrain pack
 *   2. Find entry points: 5 lowest-shatter pools (most canonical = most stable)
 *   3. From each entry, walk toward high-heat, low-shatter neighbors (Qdrant KNN)
 *   4. Record path as (pool_id, shatter, heat, direction) tuples
 *   5. Compute instinct weights: pools visited more → higher attention weight
 *   6. Write to store/finance-instinct-YYYY-MM-DD.json
 *   7. Gate: weights go to store/pending-instinct.json — human approves before active
 *
 * The agent never queries terrain live. It acts from weights formed here.
 *
 * Usage:
 *   npx tsx engine/navigate-finance.ts [--dry-run]
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT       = join(__dirname, "..");
const STORE_DIR  = join(ROOT, "store");
const TELEMETRY  = join(ROOT, "telemetry");
const QDRANT_URL = "http://127.0.0.1:6340";
const HEATMAP    = "spectral-heatmap";

// Navigation config
const ENTRY_POINTS      = 5;    // lowest-shatter pools to enter from
const WALK_DEPTH        = 4;    // KNN hops per entry point
const KNN_NEIGHBORS     = 6;    // neighbors to consider at each step
const MIN_HEAT_THRESHOLD = 0.3; // ignore low-energy neighborhoods
const MAX_SHATTER_FOLLOW = 0.12; // don't follow into high-shatter territory

// ─────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────

interface TerrainPoint {
  id: string;
  pool_id: string;
  shatter: number;
  heat: number;
  source: string;
  date: string;
  vector?: number[];
}

interface PathStep {
  pool_id: string;
  shatter: number;
  heat:    number;
  hop:     number;
  entry:   string;   // which entry point this path started from
}

interface InstinctWeights {
  date:         string;
  generated_at: string;
  pools: Record<string, {
    weight:     number;   // [0,1] — higher = tighter quotes / more attention
    visit_count: number;
    avg_shatter: number;
    avg_heat:    number;
    source:      string;
  }>;
  navigation_summary: {
    entry_points:  number;
    total_steps:   number;
    paths_walked:  number;
    pack_verified: boolean;
  };
}

// ─────────────────────────────────────────────────────────────────
// PACK VERIFICATION
// ─────────────────────────────────────────────────────────────────

function verifyPack(date: string): boolean {
  const packPath = join(STORE_DIR, `finance-crypto-${date}.jsonl`);
  const sigPath  = join(STORE_DIR, `finance-crypto-${date}.sig`);

  if (!existsSync(packPath) || !existsSync(sigPath)) return false;

  const content  = readFileSync(packPath);
  const actualSig = createHash("blake2b512").update(content).digest("hex");
  const stored   = JSON.parse(readFileSync(sigPath, "utf-8")) as { sig: string };

  return actualSig === stored.sig;
}

// ─────────────────────────────────────────────────────────────────
// QDRANT QUERIES
// ─────────────────────────────────────────────────────────────────

async function fetchLowestShatter(limit: number): Promise<TerrainPoint[]> {
  const res = await fetch(`${QDRANT_URL}/collections/${HEATMAP}/points/scroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      limit,
      with_vector: true,
      with_payload: true,
      filter: {
        must: [
          { key: "domain", match: { value: "finance-crypto" } },
          { key: "kind",   match: { value: "canonical" } },
        ],
      },
      order_by: { key: "shatter", direction: "asc" },
    }),
  });

  if (!res.ok) return [];
  const data = await res.json() as {
    result: { points: Array<{ id: string; payload: Record<string, unknown>; vector?: number[] }> };
  };

  return data.result.points.map(p => ({
    id:      String(p.id),
    pool_id: String(p.payload["pool_id"] ?? "unknown"),
    shatter: Number(p.payload["shatter"] ?? 0),
    heat:    Number(p.payload["heat"] ?? 0),
    source:  String(p.payload["source"] ?? "unknown"),
    date:    String(p.payload["date"] ?? ""),
    vector:  p.vector,
  }));
}

async function fetchKNN(vector: number[], excludeIds: Set<string>): Promise<TerrainPoint[]> {
  const res = await fetch(`${QDRANT_URL}/collections/${HEATMAP}/points/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vector,
      limit: KNN_NEIGHBORS + excludeIds.size,
      with_payload: true,
      with_vector: true,
      filter: {
        must: [
          { key: "domain", match: { value: "finance-crypto" } },
        ],
      },
    }),
  });

  if (!res.ok) return [];
  const data = await res.json() as {
    result: Array<{ id: string; score: number; payload: Record<string, unknown>; vector?: number[] }>;
  };

  return data.result
    .filter(p => !excludeIds.has(String(p.id)))
    .slice(0, KNN_NEIGHBORS)
    .map(p => ({
      id:      String(p.id),
      pool_id: String(p.payload["pool_id"] ?? "unknown"),
      shatter: Number(p.payload["shatter"] ?? 0),
      heat:    Number(p.payload["heat"] ?? 0),
      source:  String(p.payload["source"] ?? "unknown"),
      date:    String(p.payload["date"] ?? ""),
      vector:  p.vector,
    }));
}

// ─────────────────────────────────────────────────────────────────
// NAVIGATION
// ─────────────────────────────────────────────────────────────────

async function walkPath(
  entry: TerrainPoint,
  depth: number,
  dryRun: boolean,
): Promise<PathStep[]> {
  const path: PathStep[] = [];
  const visited = new Set<string>([entry.id]);
  let current = entry;

  path.push({
    pool_id: current.pool_id,
    shatter: current.shatter,
    heat:    current.heat,
    hop:     0,
    entry:   entry.pool_id,
  });

  for (let hop = 1; hop <= depth; hop++) {
    if (!current.vector) break;

    const neighbors = await fetchKNN(current.vector, visited);

    // Navigate toward high-heat, low-shatter — the geometry of opportunity
    const next = neighbors
      .filter(n => n.shatter < MAX_SHATTER_FOLLOW && n.heat > MIN_HEAT_THRESHOLD)
      .sort((a, b) => {
        // Score: high heat + low shatter = best neighbor
        const scoreA = a.heat - a.shatter * 2;
        const scoreB = b.heat - b.shatter * 2;
        return scoreB - scoreA;
      })[0];

    if (!next) break;

    visited.add(next.id);
    path.push({
      pool_id: next.pool_id,
      shatter: next.shatter,
      heat:    next.heat,
      hop,
      entry:   entry.pool_id,
    });

    if (dryRun) {
      console.log(
        `    hop ${hop}: ${next.pool_id} — heat=${next.heat.toFixed(2)} shatter=${next.shatter.toFixed(4)}`,
      );
    }

    current = next;
  }

  return path;
}

// ─────────────────────────────────────────────────────────────────
// INSTINCT WEIGHT COMPUTATION
// ─────────────────────────────────────────────────────────────────

function computeInstinctWeights(allPaths: PathStep[]): InstinctWeights["pools"] {
  const visits: Record<string, { count: number; shatterSum: number; heatSum: number; source: string }> = {};

  for (const step of allPaths) {
    if (!visits[step.pool_id]) {
      visits[step.pool_id] = { count: 0, shatterSum: 0, heatSum: 0, source: "" };
    }
    visits[step.pool_id].count++;
    visits[step.pool_id].shatterSum += step.shatter;
    visits[step.pool_id].heatSum    += step.heat;
  }

  const maxVisits = Math.max(...Object.values(visits).map(v => v.count), 1);

  const result: InstinctWeights["pools"] = {};
  for (const [pool_id, v] of Object.entries(visits)) {
    result[pool_id] = {
      weight:      v.count / maxVisits,   // normalized [0,1]
      visit_count: v.count,
      avg_shatter: v.shatterSum / v.count,
      avg_heat:    v.heatSum    / v.count,
      source:      v.source,
    };
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────

async function runNavigation(dryRun: boolean) {
  mkdirSync(STORE_DIR,  { recursive: true });
  mkdirSync(TELEMETRY, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);

  console.log(`\n[navigate-finance] Instinct formation — ${date}`);
  if (dryRun) console.log("  DRY RUN — no files written\n");

  // Verify pack signature before navigating
  const packVerified = verifyPack(date);
  if (!packVerified) {
    console.warn("  WARNING: terrain pack missing or signature mismatch — navigating unverified terrain");
  } else {
    console.log("  Pack signature verified");
  }

  // Find entry points (lowest shatter = most canonical)
  console.log(`\n  Finding ${ENTRY_POINTS} lowest-shatter entry points...`);
  const entries = await fetchLowestShatter(ENTRY_POINTS);

  if (entries.length === 0) {
    console.log("  No finance-crypto terrain points found — calibration run needed first");
    console.log("  Run: npm run calibrate:finance");
    return;
  }

  console.log(`  ${entries.length} entry points found`);

  // Walk paths from each entry
  const allPaths: PathStep[] = [];

  for (const entry of entries) {
    console.log(`\n  Entering from: ${entry.pool_id} (shatter=${entry.shatter.toFixed(4)})`);
    const path = await walkPath(entry, WALK_DEPTH, dryRun);
    allPaths.push(...path);
    console.log(`  Path length: ${path.length} steps`);
  }

  // Compute instinct weights
  const pools = computeInstinctWeights(allPaths);
  const weightCount = Object.keys(pools).length;
  console.log(`\n  Instinct weights computed for ${weightCount} pools`);

  const instinct: InstinctWeights = {
    date,
    generated_at: new Date().toISOString(),
    pools,
    navigation_summary: {
      entry_points:  entries.length,
      total_steps:   allPaths.length,
      paths_walked:  entries.length,
      pack_verified: packVerified,
    },
  };

  if (dryRun) {
    console.log("\n  Top 5 pools by instinct weight:");
    const sorted = Object.entries(pools)
      .sort(([,a], [,b]) => b.weight - a.weight)
      .slice(0, 5);
    for (const [pool_id, w] of sorted) {
      console.log(`    ${pool_id}: weight=${w.weight.toFixed(3)} visits=${w.visit_count}`);
    }
    console.log("\n  Dry run complete — no files written");
    return;
  }

  // Write instinct file
  const instinctPath = join(STORE_DIR, `finance-instinct-${date}.json`);
  writeFileSync(instinctPath, JSON.stringify(instinct, null, 2));
  console.log(`\n  Instinct file written: ${instinctPath}`);

  // Write to pending gate — human must approve before weights go active
  const pendingPath = join(STORE_DIR, "pending-instinct.json");
  writeFileSync(pendingPath, JSON.stringify({
    ...instinct,
    pending_since: new Date().toISOString(),
    instruction: "Review and rename to active-instinct.json to activate. Capital agent reads active-instinct.json only.",
  }, null, 2));
  console.log(`  Pending gate written: ${pendingPath}`);
  console.log("  ⚠️  Weights are PENDING — rename pending-instinct.json → active-instinct.json to activate");

  // Telemetry
  appendFileSync(
    join(TELEMETRY, "finance-navigation.jsonl"),
    JSON.stringify({
      ts: new Date().toISOString(),
      date,
      entries: entries.length,
      steps:   allPaths.length,
      pools:   weightCount,
      pack_verified: packVerified,
    }) + "\n",
  );

  console.log("\n[navigate-finance] Complete");
}

// ─────────────────────────────────────────────────────────────────
// CLI ENTRY
// ─────────────────────────────────────────────────────────────────

const dryRun = process.argv.includes("--dry-run");
await runNavigation(dryRun);
