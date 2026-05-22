/**
 * SPECTRAL TERRAIN — CENTROID CALIBRATION
 *
 * Run once per domain after initial canonical ingest.
 * Computes the Diamond-Stable centroid from all canonical terrain points.
 *
 * Usage: npx tsx engine/calibrate.ts --domain roblox-luau
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { Domain, Centroid } from "../contracts/terrain.contract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QDRANT_URL = "http://127.0.0.1:6340";
const HEATMAP_COLLECTION = "spectral-heatmap";

// ─────────────────────────────────────────────────────────────────
// LOAD CENTROID (used by query.ts and ingest.ts)
// ─────────────────────────────────────────────────────────────────

export function loadCentroid(domain: Domain): number[] | null {
  const p = join(__dirname, `../calibration/${domain}-centroid.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")).vector;
}

// ─────────────────────────────────────────────────────────────────
// FETCH ALL CANONICAL VECTORS FROM QDRANT
// ─────────────────────────────────────────────────────────────────

async function fetchCanonicalVectors(domain: Domain): Promise<number[][]> {
  const vectors: number[][] = [];
  let offset: string | null = null;

  while (true) {
    const body: any = {
      limit: 100,
      with_vector: true,
      with_payload: false,
      filter: {
        must: [
          { key: "domain", match: { value: domain } },
          { key: "kind",   match: { value: "canonical" } },
        ],
      },
    };
    if (offset) body.offset = offset;

    const res = await fetch(`${QDRANT_URL}/collections/${HEATMAP_COLLECTION}/points/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Qdrant scroll failed: ${res.statusText}`);
    const data = await res.json() as { result: { points: { vector: number[]; id: string }[]; next_page_offset: string | null } };

    for (const p of data.result.points) {
      if (p.vector) vectors.push(p.vector);
    }

    if (!data.result.next_page_offset) break;
    offset = data.result.next_page_offset;
  }

  return vectors;
}

// ─────────────────────────────────────────────────────────────────
// COMPUTE CENTROID
// ─────────────────────────────────────────────────────────────────

function computeCentroid(vectors: number[][]): number[] {
  if (vectors.length === 0) throw new Error("No vectors to compute centroid from");
  const dim = vectors[0].length;
  const centroid = new Array(dim).fill(0);

  for (const vec of vectors) {
    for (let i = 0; i < dim; i++) {
      centroid[i] += vec[i];
    }
  }

  return centroid.map(v => v / vectors.length);
}

function computeStability(newCentroid: number[], oldCentroid: number[] | null): number {
  if (!oldCentroid) return 0;
  return Math.sqrt(
    newCentroid.reduce((acc, v, i) => acc + Math.pow(v - oldCentroid[i], 2), 0)
  );
}

// ─────────────────────────────────────────────────────────────────
// MAIN CALIBRATE
// ─────────────────────────────────────────────────────────────────

export async function calibrate(domain: Domain): Promise<Centroid> {
  console.log(`\n🔬 Calibrating Diamond-Stable centroid for domain: ${domain}`);

  const vectors = await fetchCanonicalVectors(domain);
  if (vectors.length < 5) {
    throw new Error(`Insufficient canonical points: ${vectors.length}. Need at least 5.`);
  }

  console.log(`   Found ${vectors.length} canonical vectors`);

  const oldCentroid = loadCentroid(domain);
  const newCentroid = computeCentroid(vectors);
  const stability   = computeStability(newCentroid, oldCentroid);

  const centroid: Centroid = {
    domain,
    vector:      newCentroid,
    computedAt:  new Date().toISOString(),
    corpusSize:  vectors.length,
    stability,
    label:       `Diamond-Stable-${domain}-${new Date().toISOString().split("T")[0]}`,
  };

  const outPath = join(__dirname, `../calibration/${domain}-centroid.json`);
  writeFileSync(outPath, JSON.stringify(centroid, null, 2));

  console.log(`   ✅ Centroid saved: ${outPath}`);
  console.log(`   📐 Dimensions: ${newCentroid.length}`);
  console.log(`   📊 Corpus size: ${vectors.length}`);
  console.log(`   🎯 Stability drift: ${stability.toFixed(6)} ${stability < 0.01 ? "(STABLE)" : "(DRIFTING)"}`);

  return centroid;
}

// CLI
if (process.argv[1]?.includes("calibrate")) {
  const domain = (process.argv[process.argv.indexOf("--domain") + 1] ?? "general") as Domain;
  calibrate(domain).catch(console.error);
}
