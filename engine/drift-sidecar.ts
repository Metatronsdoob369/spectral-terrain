/**
 * SPECTRAL TERRAIN — UNICODE DRIFT SIDECAR
 *
 * Runs after any ingest. Finds all terrain points flagged with
 * unicode_drift_risk: true, re-embeds the original source through
 * nomic-embed-text (768-D, Unicode-native), and computes the cosine
 * delta between the stripped embedding (what mxbai saw) and the
 * full-fidelity embedding (what nomic sees on unstripped source).
 *
 * That delta — unicode_drift_magnitude — is written back to the
 * Qdrant payload. It is the exact geometric cost of the stripping.
 *
 * 0.0 = no drift (stripping changed nothing semantically)
 * 1.0 = maximum drift (vectors are orthogonal — completely different geometry)
 *
 * Usage:
 *   npx tsx engine/drift-sidecar.ts [--domain source-audit]
 *
 * Runs automatically after ingest when flagged points exist.
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { Domain } from "../contracts/terrain.contract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const QDRANT_URL        = "http://127.0.0.1:6340";
const HEATMAP_COLLECTION = "spectral-heatmap";
const OLLAMA_URL        = "http://127.0.0.1:11434";
const NOMIC_MODEL       = "nomic-embed-text";
const NOMIC_DIM         = 768;

// ─────────────────────────────────────────────────────────────────
// NOMIC EMBEDDER — Unicode-native, no stripping
//
// nomic-embed-text has a 512-token context window.
// Code files tokenize at 2–4× word ratio, so we chunk by word count
// (same ceiling as embed.ts / mxbai) and pool with max-magnitude.
// ─────────────────────────────────────────────────────────────────

const NOMIC_WORDS_PER_CHUNK = 100;  // code-safe ceiling (same as embed.ts)
const NOMIC_MIN_WORDS       = 20;   // discard tiny fragments

function sanitizeForNomic(text: string): string {
  // Only strip true pathological bytes — null bytes and lone surrogates.
  // nomic handles box-drawing, math symbols, arrows natively.
  return text
    .replace(/[\uD800-\uDFFF]/g, " ")
    .replace(/\0/g, " ");
}

function chunkTextNomic(text: string): string[] {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  if (words.length < NOMIC_MIN_WORDS) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += NOMIC_WORDS_PER_CHUNK) {
    const chunk = words.slice(i, i + NOMIC_WORDS_PER_CHUNK).join(" ");
    if (chunk.split(/\s+/).length >= NOMIC_MIN_WORDS) chunks.push(chunk);
  }
  return chunks.length > 0 ? chunks : [text];
}

function maxMagnitudePoolNomic(vecs: number[][]): number[] {
  const dim = vecs[0].length;
  const pooled = new Array(dim).fill(0);
  for (let i = 0; i < dim; i++) {
    let maxAbs = 0, maxVal = 0;
    for (const vec of vecs) {
      if (Math.abs(vec[i]) > maxAbs) { maxAbs = Math.abs(vec[i]); maxVal = vec[i]; }
    }
    pooled[i] = maxVal;
  }
  return l2Normalize(pooled);
}

async function embedNomicChunk(text: string): Promise<number[]> {
  const safe = sanitizeForNomic(text);
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: NOMIC_MODEL, input: safe }),
  });
  if (!res.ok) throw new Error(`nomic embed failed: ${res.statusText}`);
  const data = await res.json() as { embeddings: number[][] };
  const vec = data.embeddings[0];
  if (vec.length !== NOMIC_DIM) throw new Error(`Expected ${NOMIC_DIM}-D, got ${vec.length}-D`);
  return l2Normalize(vec);
}

async function embedNomic(text: string): Promise<number[]> {
  const chunks = chunkTextNomic(text);
  if (chunks.length === 1) return embedNomicChunk(chunks[0]);
  const vecs = await Promise.all(chunks.map(embedNomicChunk));
  return maxMagnitudePoolNomic(vecs);
}

// ─────────────────────────────────────────────────────────────────
// COSINE SIMILARITY — same-dimension vectors only
// ─────────────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  // Both vectors are l2-normalized, so magnitudes = 1 and dot = cosine
  return dot;
}

// ─────────────────────────────────────────────────────────────────
// CROSS-MODEL COSINE DELTA
//
// mxbai and nomic live in different vector spaces — you can't
// subtract them directly. Instead we compute the drift entirely
// within nomic's space:
//
//   stripped_text  --nomic--> v_stripped_nomic
//   original_text  --nomic--> v_original_nomic
//   drift = 1 - cosine(v_stripped_nomic, v_original_nomic)
//
// This is the exact geometric cost of the stripping in a
// Unicode-aware space. 0.0 = stripping changed nothing.
// ─────────────────────────────────────────────────────────────────

function stripForMxbai(text: string): string {
  return text
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, " ")
    .replace(/[ \t]{3,}/g, "  ")
    .trim();
}

async function computeDriftMagnitude(originalSource: string): Promise<{
  magnitude: number;
  strippedChars: number;
  v_stripped: number[];
  v_original: number[];
}> {
  const stripped = stripForMxbai(originalSource);
  const strippedChars = originalSource.length - stripped.length;

  const [v_stripped, v_original] = await Promise.all([
    embedNomic(stripped),
    embedNomic(originalSource),
  ]);

  const similarity = cosineSimilarity(v_stripped, v_original);
  const magnitude  = 1 - similarity; // 0 = no drift, 1 = max drift

  return { magnitude, strippedChars, v_stripped, v_original };
}

// ─────────────────────────────────────────────────────────────────
// L2 NORMALIZE
// ─────────────────────────────────────────────────────────────────

function l2Normalize(vec: number[]): number[] {
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (mag < 1e-6) throw new Error("Zero vector");
  return vec.map(v => v / mag);
}

// ─────────────────────────────────────────────────────────────────
// FETCH FLAGGED POINTS FROM QDRANT
// ─────────────────────────────────────────────────────────────────

interface FlaggedPoint {
  id: string;
  file: string;
  domain: string;
  unicode_drift_magnitude?: number;
}

async function fetchFlaggedPoints(domain?: Domain): Promise<FlaggedPoint[]> {
  const points: FlaggedPoint[] = [];
  let offset: string | null = null;

  const domainFilter = domain ? [{ key: "domain", match: { value: domain } }] : [];

  while (true) {
    const body: any = {
      limit: 100,
      with_vector: false,
      with_payload: true,
      filter: {
        must: [
          { key: "unicode_drift_risk",   match: { value: true } },
          { key: "source_resolvable",    match: { value: true } },
          ...domainFilter,
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
    const data = await res.json() as {
      result: {
        points: { id: string; payload: any }[];
        next_page_offset: string | null;
      };
    };

    for (const p of data.result.points) {
      points.push({
        id:                    p.id,
        file:                  p.payload.file,
        domain:                p.payload.domain,
        unicode_drift_magnitude: p.payload.unicode_drift_magnitude,
      });
    }

    if (!data.result.next_page_offset) break;
    offset = data.result.next_page_offset;
  }

  return points;
}

// ─────────────────────────────────────────────────────────────────
// PATCH DRIFT MAGNITUDE BACK TO QDRANT PAYLOAD
// ─────────────────────────────────────────────────────────────────

async function patchDriftMagnitude(id: string, magnitude: number): Promise<void> {
  const res = await fetch(`${QDRANT_URL}/collections/${HEATMAP_COLLECTION}/points/payload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      payload: { unicode_drift_magnitude: magnitude },
      points:  [id],
    }),
  });
  if (!res.ok) throw new Error(`Qdrant patch failed: ${res.statusText}`);
}

// ─────────────────────────────────────────────────────────────────
// RESOLVE FILE SOURCE FROM QDRANT PAYLOAD
// The terrain point stores file as a relative path.
// We need to find the actual file on disk to re-read it.
// ─────────────────────────────────────────────────────────────────

const KNOWN_ROOTS = [
  "/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk",
  "/Users/joewales/NODE_OUT_Master/spectral-terrain",
  process.cwd(),
];

function resolveSource(relFile: string): string | null {
  for (const root of KNOWN_ROOTS) {
    const full = join(root, relFile);
    if (existsSync(full)) return readFileSync(full, "utf-8");
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────

export async function runDriftSidecar(domain?: Domain): Promise<void> {
  console.log("\n[drift-sidecar] Scanning for unicode_drift_risk points...");

  // Confirm nomic is available
  const check = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!check?.ok) throw new Error("Ollama not responding — is it running?");
  const tags = await check.json() as { models: { name: string }[] };
  const hasNomic = tags.models.some(m => m.name.startsWith("nomic-embed-text"));
  if (!hasNomic) throw new Error("nomic-embed-text not found in Ollama — run: ollama pull nomic-embed-text");

  const flagged = await fetchFlaggedPoints(domain);

  if (flagged.length === 0) {
    console.log("[drift-sidecar] No flagged points found. Terrain is clean.");
    return;
  }

  console.log(`[drift-sidecar] Found ${flagged.length} flagged point(s). Computing drift...\n`);

  const scored:  { file: string; magnitude: number; strippedChars: number }[] = [];
  let nSkipped  = 0;
  let nMiss     = 0;
  let nError    = 0;

  for (const point of flagged) {
    // Skip if already computed (idempotent re-runs)
    // Note: magnitude === 0.0 is a valid result (CLEAN), so we gate on !== undefined only
    if (point.unicode_drift_magnitude !== undefined) {
      nSkipped++;
      continue;
    }

    const source = resolveSource(point.file);
    if (!source) {
      nMiss++;
      // Only log misses — they shouldn't exist if source_resolvable filter is working,
      // but surface them if they slip through so the filter gap is visible.
      console.error(`  [miss] ${point.file} — source not found on disk`);
      continue;
    }

    try {
      const { magnitude, strippedChars } = await computeDriftMagnitude(source);
      await patchDriftMagnitude(point.id, magnitude);

      const severity = magnitude < 0.001 ? "CLEAN" : magnitude < 0.01 ? "MINOR" : magnitude < 0.05 ? "NOTABLE" : "HIGH";
      console.log(`  [${severity}] ${point.file} | drift: ${magnitude.toFixed(6)} | stripped: ${strippedChars} chars`);
      scored.push({ file: point.file, magnitude, strippedChars });
    } catch (err: any) {
      nError++;
      console.error(`  [error] ${point.file}: ${err.message}`);
    }
  }

  // Summary — always print so run quality is auditable even on all-skip runs
  const max = scored.length > 0 ? scored.reduce((a, b) => a.magnitude > b.magnitude ? a : b) : null;
  const avg = scored.length > 0 ? scored.reduce((s, r) => s + r.magnitude, 0) / scored.length : 0;
  console.log(`\n[drift-sidecar] Summary:`);
  console.log(`  Queued:   ${flagged.length}`);
  console.log(`  Scored:   ${scored.length}`);
  console.log(`  Skipped:  ${nSkipped}  (already scored, idempotent)`);
  console.log(`  Miss:     ${nMiss}  (source not on disk — check source_resolvable filter)`);
  console.log(`  Error:    ${nError}  (embed or patch failed)`);
  if (max) {
    console.log(`  Avg drift:  ${avg.toFixed(6)}`);
    console.log(`  Max drift:  ${max.magnitude.toFixed(6)} (${max.file})`);
    console.log(`  Threshold:  > 0.05 = HIGH — prioritize for re-embed in spectral-terrain-768`);
  }

  // Persist run artifact — trendable over time, one JSON file per run
  //
  // status field — fast branch signal for agents and dashboards:
  //   clean    — queue healthy, nothing failed (miss/error === 0)
  //   degraded — miss or error > 0, but run completed (partial data)
  //   error    — all scored attempts failed (error === queued - skipped, nothing got through)
  const attempted = flagged.length - nSkipped;
  const status: "clean" | "degraded" | "error" =
    nError > 0 && nError === attempted ? "error"
    : nMiss > 0 || nError > 0          ? "degraded"
    :                                    "clean";

  const artifact = {
    timestamp:  new Date().toISOString(),
    domain:     domain ?? null,
    status,
    counters: {
      queued:   flagged.length,
      scored:   scored.length,
      skipped:  nSkipped,
      miss:     nMiss,
      error:    nError,
    },
    drift: scored.length > 0 ? {
      avg:     avg,
      max:     max!.magnitude,
      maxFile: max!.file,
      high:    scored.filter(r => r.magnitude >= 0.05).map(r => ({ file: r.file, magnitude: r.magnitude })),
    } : null,
  };

  const telemetryDir = join(__dirname, "../telemetry");
  mkdirSync(telemetryDir, { recursive: true });

  // Retention: keep last 30 timestamped artifacts, prune the rest
  const RETENTION_LIMIT = 30;
  const existing = readdirSync(telemetryDir)
    .filter(f => f.startsWith("drift-run-") && f.endsWith(".json"))
    .sort();  // lexicographic = chronological (epoch ms filenames)
  if (existing.length >= RETENTION_LIMIT) {
    const toPrune = existing.slice(0, existing.length - RETENTION_LIMIT + 1);
    for (const f of toPrune) {
      try { unlinkSync(join(telemetryDir, f)); } catch {}
    }
  }

  const artifactPath = join(telemetryDir, `drift-run-${Date.now()}.json`);
  const serialized   = JSON.stringify(artifact, null, 2);
  writeFileSync(artifactPath, serialized);
  writeFileSync(join(telemetryDir, "latest-drift-run.json"), serialized);
  console.log(`  Status:     ${status}`);
  console.log(`  Artifact:   ${artifactPath}`);
}

// CLI
if (process.argv[1]?.includes("drift-sidecar")) {
  const domainIdx = process.argv.indexOf("--domain");
  const domainArg = domainIdx !== -1 ? process.argv[domainIdx + 1] as Domain : undefined;
  runDriftSidecar(domainArg).catch(console.error);
}
