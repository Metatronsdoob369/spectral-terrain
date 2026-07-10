/**
 * SPECTRAL HEATMAP — Finance-Crypto Ingest
 *
 * Finance-domain port of the Eve_v2 pipeline (Eve_v2 w text-embeddings-3).
 * Produces identical Qdrant payload shape so SpectralHeatmap.tsx renders
 * finance-crypto terrain in all 5 modes without modification.
 *
 * Pipeline:
 *   1. Fetch Polymarket + Uniswap pool states
 *   2. Serialize each pool → prose → OpenAI text-embedding-3-large (3072-D)
 *   3. Compute centroid from liquid/canonical pools
 *   4. Per-point: heat, shatter, sectorScores, nearestCanonical
 *   5. Graph: adjacency (RBF cosine), Laplacian, heat kernel (Taylor), Jacobi eigenvalues
 *   6. PCA 3D projection via Gram matrix
 *   7. deltaVector3d for shattered pools
 *   8. Upsert to Qdrant spectral-heatmap + graph_metadata point (id=200)
 *
 * Finance sector weights (parallel to OMC sectors in Roblox domain):
 *   Liquidity       0.95  — pool depth (bid/ask/volume)
 *   Spread          0.90  — price efficiency, tight spread = canonical
 *   Momentum        0.75  — price velocity signal
 *   Stability       0.98  — variance from centroid, low shatter = reliable
 *   Arb_Signal      0.85  — cross-protocol opportunity geometry
 *
 * "Canonical" in finance = high-volume, tight-spread, low-shatter pool
 * observed for 5+ days. Shattered = spread collapse or sudden volume spike
 * indicating potential exploit or manipulation.
 *
 * Usage:
 *   npx tsx scripts/ingest-finance-heatmap.ts [--dry-run]
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";

import { fetchUniswapPools, fetchPolymarketMarkets } from "./fetch-finance-snapshot.js";
import { serializePoolState } from "../domains/finance-crypto-serialize.js";
import { predictFinanceTplus1 } from "../domains/finance-crypto-tplus1.js";
import { buildTemporalVector, embed } from "../engine/embed.js";
import { adaptivePool, printPoolStats } from "../engine/embed-pool.js";
import type { PoolState } from "../contracts/finance-crypto.domain.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const QDRANT_URL    = "http://localhost:6340";
const COLLECTION    = "spectral-heatmap";
const DIMS          = 3072;   // [1024 t-1 | 1024 t | 1024 t+1] — local Ollama mxbai-embed-large
const GRAPH_META_ID = 200;    // Roblox uses id=100; finance uses 200 to coexist

// ─────────────────────────────────────────────────────────────────
// FINANCE SECTOR CONFIG (mirrors EVE sectorWeights structure)
// ─────────────────────────────────────────────────────────────────

const FINANCE_EVE = {
  heat_tau: 0.1,    // heat kernel diffusion time
  tau:      0.85,   // RBF bandwidth for adjacency
  sectorWeights: {
    Liquidity:   0.95,   // Pool depth — volume + bid/ask
    Spread:      0.90,   // Price efficiency — tight spread = healthy
    Momentum:    0.75,   // Price velocity / directional signal
    Stability:   0.98,   // Low shatter = reliable canonical geometry
    Arb_Signal:  0.85,   // Cross-protocol opportunity geometry
  } as Record<string, number>,
};

const SECTORS = Object.keys(FINANCE_EVE.sectorWeights);

// ─────────────────────────────────────────────────────────────────
// VECTOR MATH
// ─────────────────────────────────────────────────────────────────

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function l2(a: number[]): number {
  return Math.sqrt(dot(a, a));
}

function cosine(a: number[], b: number[]): number {
  const na = l2(a), nb = l2(b);
  return na > 0 && nb > 0 ? dot(a, b) / (na * nb) : 0;
}

function vecSub(a: number[], b: number[]): number[] {
  return a.map((v, i) => v - b[i]);
}

function normalize(a: number[]): number[] {
  const n = l2(a);
  return n > 0 ? a.map(v => v / n) : a;
}

// ─────────────────────────────────────────────────────────────────
// MATRIX MATH (small NxN)
// ─────────────────────────────────────────────────────────────────

type Mat = number[][];

function zeros(n: number): Mat {
  return Array.from({ length: n }, () => new Array(n).fill(0));
}

function eye(n: number): Mat {
  const m = zeros(n);
  for (let i = 0; i < n; i++) m[i][i] = 1;
  return m;
}

function matMul(A: Mat, B: Mat): Mat {
  const n = A.length, m = B[0].length, k = B.length;
  const C = zeros(n);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++)
      for (let p = 0; p < k; p++)
        C[i][j] += A[i][p] * B[p][j];
  return C;
}

function matAdd(A: Mat, B: Mat): Mat {
  return A.map((r, i) => r.map((v, j) => v + B[i][j]));
}

function matScale(A: Mat, s: number): Mat {
  return A.map(r => r.map(v => v * s));
}

// ─────────────────────────────────────────────────────────────────
// JACOBI EIGENVALUE (symmetric matrices — identical to Eve_v2)
// ─────────────────────────────────────────────────────────────────

function jacobi(M: Mat): { values: number[]; vectors: Mat } {
  const n = M.length;
  let A = M.map(r => [...r]);
  let V = eye(n);

  for (let iter = 0; iter < 200; iter++) {
    let mx = 0, p = 0, q = 1;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++)
        if (Math.abs(A[i][j]) > mx) { mx = Math.abs(A[i][j]); p = i; q = j; }

    if (mx < 1e-12) break;

    const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
    const t = Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
    const c = 1 / Math.sqrt(t * t + 1);
    const s = t * c;

    const nA = A.map(r => [...r]);
    for (let i = 0; i < n; i++) {
      if (i !== p && i !== q) {
        nA[i][p] = c * A[i][p] - s * A[i][q]; nA[p][i] = nA[i][p];
        nA[i][q] = s * A[i][p] + c * A[i][q]; nA[q][i] = nA[i][q];
      }
    }
    nA[p][p] = c * c * A[p][p] - 2 * s * c * A[p][q] + s * s * A[q][q];
    nA[q][q] = s * s * A[p][p] + 2 * s * c * A[p][q] + c * c * A[q][q];
    nA[p][q] = 0; nA[q][p] = 0;
    A = nA;

    const nV = V.map(r => [...r]);
    for (let i = 0; i < n; i++) {
      nV[i][p] = c * V[i][p] - s * V[i][q];
      nV[i][q] = s * V[i][p] + c * V[i][q];
    }
    V = nV;
  }

  return { values: A.map((r, i) => r[i]), vectors: V };
}

// ─────────────────────────────────────────────────────────────────
// HEAT KERNEL: H(t) = exp(-t·L) via Taylor series (identical to Eve_v2)
// ─────────────────────────────────────────────────────────────────

function heatKernel(L: Mat, t: number): Mat {
  const n = L.length;
  const negTL = matScale(L, -t);
  let result = eye(n);
  let term = eye(n);
  for (let k = 1; k <= 20; k++) {
    term = matScale(matMul(term, negTL), 1 / k);
    result = matAdd(result, term);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────
// PCA 3D VIA GRAM MATRIX (identical to Eve_v2)
// ─────────────────────────────────────────────────────────────────

function pcaProject3D(vecs: number[][]): number[][] {
  const n = vecs.length;
  const mean = new Array(DIMS).fill(0);
  for (const v of vecs) for (let i = 0; i < DIMS; i++) mean[i] += v[i] / n;
  const centered = vecs.map(v => v.map((x, i) => x - mean[i]));

  const G = zeros(n);
  for (let i = 0; i < n; i++)
    for (let j = i; j < n; j++) {
      const d = dot(centered[i], centered[j]);
      G[i][j] = d; G[j][i] = d;
    }

  const { values, vectors } = jacobi(G);
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const top3 = order.slice(0, 3);

  const scale = 8; // Three.js scene scale
  return Array.from({ length: n }, (_, i) =>
    top3.map(({ v, i: idx }) => {
      const ev = Math.sqrt(Math.max(0, v));
      return vectors[i][idx] * ev * scale;
    })
  );
}

// ─────────────────────────────────────────────────────────────────
// FINANCE SECTOR SCORES
//
// The 3072-D temporal vector is [t-1 (1024) | t_now (1024) | t+1 (1024)].
// Sector scores are computed from the t_now slice (indices 1024–2047) —
// the live state — so scores reflect actual current pool health geometry,
// not the full temporal concatenation.
//
// Per sector: slice t_now sub-vector → Euclidean dist from centroid t_now slice.
// Higher score = closer to centroid = healthier pool in that dimension band.
// ─────────────────────────────────────────────────────────────────

const T_NOW_OFFSET = 1024;              // t_now starts at index 1024
const T_NOW_DIM    = 1024;             // 1024-D per time slot
const SECTOR_DIM   = Math.floor(T_NOW_DIM / SECTORS.length); // ~204-D per sector

function computeSectorScores(vec: number[], centroid: number[]): Record<string, number> {
  const scores: Record<string, number> = {};
  for (let s = 0; s < SECTORS.length; s++) {
    const start = T_NOW_OFFSET + s * SECTOR_DIM;
    const end   = s === SECTORS.length - 1
      ? T_NOW_OFFSET + T_NOW_DIM
      : T_NOW_OFFSET + (s + 1) * SECTOR_DIM;
    let distSq = 0;
    for (let i = start; i < end; i++) distSq += (vec[i] - centroid[i]) ** 2;
    const dist = Math.sqrt(distSq);
    scores[SECTORS[s]] = Math.max(0, 1 - dist) * FINANCE_EVE.sectorWeights[SECTORS[s]];
  }
  return scores;
}

// ─────────────────────────────────────────────────────────────────
// CANONICAL CLASSIFICATION
// A pool is canonical if it has meaningful volume (liquidity > 0.05)
// and a tight spread (spread < 0.1 or source_has_spread is false).
// Shattered = spread > 0.3 or zero volume — indicates disruption.
// ─────────────────────────────────────────────────────────────────

function classifyPool(pool: PoolState): "canonical" | "shattered" | "pending" {
  if (pool.liquidity > 0.1 && (!pool.source_has_spread || pool.spread < 0.15)) {
    return "canonical";
  }
  if (pool.source_has_spread && pool.spread > 0.3) {
    return "shattered";
  }
  return "pending";
}

// ─────────────────────────────────────────────────────────────────
// QDRANT HELPERS
// ─────────────────────────────────────────────────────────────────

async function ensureCollection() {
  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`);
  if (res.ok) {
    console.log(`     ✓ Collection ${COLLECTION} exists`);
    return;
  }
  const create = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vectors: { size: DIMS, distance: "Cosine" } }),
  });
  if (!create.ok) throw new Error(`Failed to create collection: ${await create.text()}`);
  console.log(`     ✓ Collection created (dim=${DIMS})`);
}

async function upsertPoints(points: unknown[]) {
  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ points }),
  });
  if (!res.ok) throw new Error(`Qdrant upsert failed: ${await res.text()}`);
}

// ─────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────

async function main(dryRun: boolean) {
  console.log(`\n═══ SPECTRAL HEATMAP — Finance-Crypto Ingest ═══`);
  if (dryRun) console.log("⚠️  DRY RUN — no Qdrant writes\n");

  // 1. Fetch pool states
  console.log("1/6  Fetching pool states...");
  const [uniResult, polyResult] = await Promise.allSettled([
    fetchUniswapPools(),
    fetchPolymarketMarkets(),
  ]);

  const pools: PoolState[] = [
    ...(uniResult.status === "fulfilled" ? uniResult.value : (console.log(`     ⚠  Uniswap: ${(uniResult as PromiseRejectedResult).reason?.message}`), [])),
    ...(polyResult.status === "fulfilled" ? polyResult.value : (console.log(`     ⚠  Polymarket: ${(polyResult as PromiseRejectedResult).reason?.message}`), [])),
  ];

  if (pools.length === 0) {
    console.error("FATAL: No pools fetched — aborting");
    process.exit(1);
  }

  for (const p of pools) {
    const k = classifyPool(p);
    console.log(`     ${k === "canonical" ? "✅" : k === "shattered" ? "💥" : "⏳"} ${p.pool_id} (liq=${p.liquidity.toFixed(3)} spread=${p.spread.toFixed(3)})`);
  }

  // 2. Embed via local Ollama mxbai-embed-large — temporal [t-1 | t | t+1] → 3072-D
  console.log(`\n2/6  Embedding ${pools.length} pools via mxbai-embed-large (3×1024-D temporal)...`);

  // Build a lookup of prior pool states (t-1) — today we have none, so neutral prior
  // On subsequent nightly runs, refinery-finance.ts pack provides real t-1 values.
  // Adaptive pool — finds optimal concurrency for this machine automatically.
  // Starts at 2 concurrent embed jobs, widens if latency is stable, shrinks on saturation.
  // Each job = 3 Ollama calls (t-1, t, t+1) run in parallel within the job.
  let poolStats: any;
  const vectors: number[][] = await adaptivePool(
    pools,
    async (pool) => {
      const tNowText   = serializePoolState(pool);
      const tPlus1Text = predictFinanceTplus1(pool, null);

      // Bootstrap: no prior day pack yet, so t-1 = t_now (placeholder).
      // We only call Ollama TWICE (t_now + t_plus1), then reuse t_now embed
      // for t_minus1 — identical text = identical vector, no wasted call.
      // Once refinery-finance.ts has a prior pack, real t-1 prose differs
      // and all three slots carry distinct signal.
      const [vNow, vNext] = await Promise.all([embed(tNowText), embed(tPlus1Text)]);
      return [...vNow, ...vNow, ...vNext]; // [t-1=vNow | t=vNow | t+1=vNext]
    },
    (done, total, stats) => {
      poolStats = stats;
      console.log(`     ✓ ${pools[done - 1].pool_id} [${done}/${total} | concurrency=${stats.concurrency}]`);
    },
  );
  if (poolStats) printPoolStats(poolStats, "EmbedPool");

  // 3. Centroid from canonical pools
  console.log("\n3/6  Computing canonical centroid + per-point metrics...");
  const canonicalIndices = pools
    .map((p, i) => classifyPool(p) === "canonical" ? i : -1)
    .filter(i => i >= 0);

  if (canonicalIndices.length === 0) {
    // Fallback: use all pools as pseudo-canonical
    console.log("     ⚠  No canonical pools — using all as pseudo-centroid");
    canonicalIndices.push(...pools.map((_, i) => i));
  }

  const centroid = new Array(DIMS).fill(0);
  for (const idx of canonicalIndices)
    for (let d = 0; d < DIMS; d++)
      centroid[d] += vectors[idx][d] / canonicalIndices.length;

  // Per-point metrics
  const pointData = pools.map((pool, i) => {
    const vec = vectors[i];
    const kind = classifyPool(pool);

    // Heat: Manhattan resonance (L1 distance from centroid, normalized)
    let manhattan = 0;
    for (let d = 0; d < DIMS; d++) manhattan += Math.abs(vec[d] - centroid[d]);
    const heat = manhattan / DIMS;

    // Shatter: Euclidean distance from centroid
    const shatter = l2(vecSub(vec, centroid));

    // Sector scores (finance domain)
    const sectors = computeSectorScores(vec, centroid);

    // Nearest canonical (by cosine similarity)
    let bestSim = -1, bestIdx = 0;
    for (const ci of canonicalIndices) {
      if (ci === i) continue;
      const sim = cosine(vec, vectors[ci]);
      if (sim > bestSim) { bestSim = sim; bestIdx = ci; }
    }

    console.log(`     ${pool.pool_id}: heat=${heat.toFixed(4)} shatter=${shatter.toFixed(4)} nearest=${pools[bestIdx]?.pool_id ?? "self"} (cos=${bestSim.toFixed(4)})`);

    return { pool, kind, heat, shatter, sectors, nearestCanonical: { idx: bestIdx, similarity: bestSim } };
  });

  // 4. Graph-level computations
  console.log("\n4/6  Computing graph Laplacian, heat kernel, eigenvalues...");
  const n = pools.length;

  // Adjacency matrix — RBF kernel on cosine distance (same as Eve_v2)
  const W = zeros(n);
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const sim = cosine(vectors[i], vectors[j]);
      const dist = Math.sqrt(2 * Math.max(0, 1 - sim));
      const w = Math.exp(-(dist * dist) / (2 * FINANCE_EVE.tau * FINANCE_EVE.tau));
      W[i][j] = w; W[j][i] = w;
    }

  // Laplacian
  const L = zeros(n);
  for (let i = 0; i < n; i++) {
    let deg = 0;
    for (let j = 0; j < n; j++) {
      if (i !== j) { L[i][j] = -W[i][j]; deg += W[i][j]; }
    }
    L[i][i] = deg;
  }

  // Heat kernel H(t) = exp(-t·L)
  const H = heatKernel(L, FINANCE_EVE.heat_tau);
  console.log(`     ✓ Heat kernel computed (tau=${FINANCE_EVE.heat_tau})`);

  // Eigenvalues
  const { values: eigenvalues } = jacobi(L);
  const sortedEigen = [...eigenvalues].sort((a, b) => a - b);
  console.log(`     ✓ Eigenvalues: ${sortedEigen.map(v => v.toFixed(4)).join(", ")}`);

  // 5. PCA 3D projection
  console.log("\n5/6  PCA projection to 3D...");
  const positions3d = pcaProject3D(vectors);
  for (let i = 0; i < n; i++) {
    console.log(`     ${pools[i].pool_id}: [${positions3d[i].map(v => v.toFixed(2)).join(", ")}]`);
  }

  // Delta vectors for shattered pools
  const deltas: (number[] | null)[] = pools.map((pool, i) => {
    if (classifyPool(pool) !== "shattered") return null;
    const targetIdx = pointData[i].nearestCanonical.idx;
    return vecSub(positions3d[targetIdx], positions3d[i]);
  });

  // 6. Store in Qdrant
  if (!dryRun) {
    console.log("\n6/6  Storing in Qdrant...");
    await ensureCollection();

    // Deterministic point IDs: SHA-256(finance-crypto:{pool_id}:{date}) → integer
    // We use a numeric ID by taking first 8 hex chars as base-16 integer (max ~4B)
    // to stay within Qdrant's unsigned 64-bit range while avoiding collision with
    // Roblox points (id 1-8) and graph metadata (id 100).
    const today = new Date().toISOString().slice(0, 10);
    const points = pointData.map((pd, i) => {
      const hashHex = createHash("sha256")
        .update(`finance-crypto:${pd.pool.pool_id}:${today}`)
        .digest("hex");
      // Take first 12 hex chars → max 2^48 ≈ 281T, well within uint64
      const numericId = parseInt(hashHex.slice(0, 12), 16);

      return {
        id: numericId,
        vector: vectors[i],
        payload: {
          file:             pd.pool.pool_id,   // "file" = pool_id for finance domain
          genre:            pd.pool.source,     // "genre" = source (uniswap-v3, polymarket-clob)
          kind:             pd.kind,
          domain:           "finance-crypto",
          position3d:       positions3d[i],
          heat:             pd.heat,
          shatter:          pd.shatter,
          sectorScores:     pd.sectors,
          nearestCanonical: {
            file:       pools[pd.nearestCanonical.idx]?.pool_id ?? "",
            similarity: pd.nearestCanonical.similarity,
          },
          heatKernelRow:    H[i],
          eigenvalues:      sortedEigen,
          deltaVector3d:    deltas[i],
          deltaTarget:      deltas[i] ? pools[pd.nearestCanonical.idx]?.pool_id ?? null : null,
          // Finance-specific metadata
          price:            pd.pool.price,
          liquidity:        pd.pool.liquidity,
          volume_24h:       pd.pool.volume_24h,
          spread:           pd.pool.spread,
          timestamp:        pd.pool.timestamp,
          ingestedAt:       new Date().toISOString(),
        },
      };
    });

    await upsertPoints(points);
    console.log(`     ✓ ${points.length} finance pools upserted`);

    // Graph metadata as separate point (id=200, coexists with Roblox id=100)
    const centroidHashHex = createHash("sha256")
      .update(`finance-crypto:graph_metadata:${today}`)
      .digest("hex");
    const graphMetaId = parseInt(centroidHashHex.slice(0, 12), 16) + 1; // +1 to avoid collision

    await upsertPoints([{
      id: GRAPH_META_ID,
      vector: centroid,
      payload: {
        kind:            "graph_metadata",
        domain:          "finance-crypto",
        adjacencyMatrix:  W,
        laplacian:        L,
        heatKernelMatrix: H,
        eigenvalues:      sortedEigen,
        centroid3d:       [0, 0, 0], // centroid projects to origin after PCA centering
        fileOrder:        pools.map(p => p.pool_id),
        sectorWeights:    FINANCE_EVE.sectorWeights,
        date:             today,
      },
    }]);
    console.log("     ✓ Graph metadata stored (id=200)");
  } else {
    console.log("\n6/6  [DRY RUN] — skipping Qdrant writes");
    console.log("     Points that would be written:");
    for (let i = 0; i < n; i++) {
      console.log(`       ${pools[i].pool_id}: kind=${pointData[i].kind} heat=${pointData[i].heat.toFixed(4)} shatter=${pointData[i].shatter.toFixed(4)}`);
    }
  }

  console.log("\n═══ COMPLETE ═══");
  console.log(`Collection: ${COLLECTION}`);
  console.log(`Points: ${n} finance pools + 1 graph metadata`);
  console.log(`Modes ready: Thermal Distance, Sector Radar, Heat Diffusion, Eigenvalue Terrain, Delta Vector Field`);
  console.log(`Dashboard: http://localhost:3000\n`);
}

// ─────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────

const dryRun = process.argv.includes("--dry-run");
main(dryRun).catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
