/**
 * SPECTRAL TERRAIN — EMBEDDING ENGINE
 *
 * Converts code/state into temporal 3072-D vectors.
 * All embedding is local via Ollama. Never external.
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import type { TemporalVector } from "../contracts/terrain.contract.js";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const EMBED_MODEL = process.env.EMBED_MODEL || "mxbai-embed-large";
const EMBED_DIM = parseInt(process.env.EMBED_DIM || "1024", 10);
const EMBED_PROVIDER = process.env.EMBED_PROVIDER || "ollama"; // ollama | hf
const HF_API_URL = process.env.HF_API_URL || "https://api-inference.huggingface.co/pipeline/feature-extraction";
const HF_TOKEN = process.env.HF_TOKEN;

// ─────────────────────────────────────────────────────────────────
// CORE EMBEDDER
// ─────────────────────────────────────────────────────────────────

// WhiteGlove Weft Protocol — word-based chunking (ported from rechunk_medical.py)
// Code tokenizes at 2–4x word ratio vs prose due to method chains, string literals, identifiers.
// mxbai-embed-large has a 512-token context. 100 words of Lua ≈ 300–400 tokens = safe.
const WORDS_PER_CHUNK = 100;  // code-safe ceiling
const MIN_WORDS       = 20;   // discard fragments shorter than this

/** Chunk text by word count — semantic boundaries, not arbitrary char slices */
function chunkText(text: string): string[] {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  if (words.length < MIN_WORDS) return [text]; // too short to chunk
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += WORDS_PER_CHUNK) {
    const chunk = words.slice(i, i + WORDS_PER_CHUNK).join(" ");
    if (chunk.split(/\s+/).length >= MIN_WORDS) chunks.push(chunk);
  }
  return chunks.length > 0 ? chunks : [text];
}

/** Embed with automatic word-based chunking + max-magnitude pooling */
export async function embed(text: string): Promise<number[]> {
  const chunks = chunkText(text);
  if (chunks.length === 1) return embedChunk(chunks[0]);
  const vecs = await Promise.all(chunks.map(embedChunk));
  return maxMagnitudePool(vecs);
}

/** Strip all non-ASCII except tab, LF, CR — matches ingest.ts preIngestFilter exactly */
function sanitizeForEmbed(text: string): string {
  return text.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, " ");
}

async function embedChunk(text: string): Promise<number[]> {
  const safe = sanitizeForEmbed(text);
  if (EMBED_PROVIDER === "hf") {
    return embedChunkHF(safe);
  }
  return embedChunkOllama(safe);
}

async function embedChunkOllama(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`Ollama embed failed: ${res.statusText}`);
  const data = await res.json() as { embeddings: number[][] };
  const vec = data.embeddings[0];
  if (vec.length !== EMBED_DIM) throw new Error(`Expected ${EMBED_DIM}-D, got ${vec.length}-D`);
  return l2Normalize(vec);
}

async function embedChunkHF(text: string): Promise<number[]> {
  if (!HF_TOKEN) throw new Error("HF_TOKEN not set");
  const res = await fetch(`${HF_API_URL}/${EMBED_MODEL}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${HF_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inputs: text }),
  });
  if (!res.ok) throw new Error(`HF embed failed: ${res.status} ${res.statusText}`);
  const data = await res.json() as number[] | number[][];
  // HF returns either [number[]] for single input or number[] directly
  const vec = Array.isArray(data[0]) ? (data as number[][])[0] : (data as number[]);
  if (vec.length !== EMBED_DIM) throw new Error(`Expected ${EMBED_DIM}-D, got ${vec.length}-D`);
  return l2Normalize(vec);
}

/** Max-magnitude pooling — preserves strongest signal per dimension across chunks */
function maxMagnitudePool(vecs: number[][]): number[] {
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

// ─────────────────────────────────────────────────────────────────
// TEMPORAL VECTOR BUILDER
// ─────────────────────────────────────────────────────────────────

/**
 * Build a 3072-D temporal vector [v_t-1 | v_t | v_t+1].
 *
 * @param tMinus1 - Text/code representing previous state
 * @param tNow    - Text/code representing current state
 * @param tPlus1  - Text/code representing predicted next state
 *                  (from physics engine, learned model, or placeholder)
 */
export async function buildTemporalVector(
  tMinus1: string,
  tNow: string,
  tPlus1: string,
): Promise<TemporalVector> {
  const [vPrev, vNow, vNext] = await Promise.all([
    embed(tMinus1),
    embed(tNow),
    embed(tPlus1),
  ]);

  return {
    t_minus1: vPrev as [number, ...number[]] & { length: 1024 },
    t_now:    vNow  as [number, ...number[]] & { length: 1024 },
    t_plus1:  vNext as [number, ...number[]] & { length: 1024 },
    concat:   [...vPrev, ...vNow, ...vNext],
  };
}

/**
 * Bootstrap placeholder — uses same vector for all three time slots.
 * LEGACY: only valid for temporal domains (roblox-luau, finance-crypto) during bootstrap.
 * Do NOT use for static domains — use buildSingleEmbed() instead (contract-enforced).
 * Mark terrain points built this way as kind="pending".
 */
export async function buildPlaceholderVector(text: string): Promise<TemporalVector> {
  const v = await embed(text);
  return {
    t_minus1: v as [number, ...number[]] & { length: 1024 },
    t_now:    v as [number, ...number[]] & { length: 1024 },
    t_plus1:  v as [number, ...number[]] & { length: 1024 },
    concat:   [...v, ...v, ...v],
  };
}

/**
 * Single 1024-D embed for static domains (source-audit, general, memory).
 *
 * CONTRACT: Use this — never buildPlaceholderVector — for domains where
 * DOMAIN_GEOMETRY[domain].temporal === false. Concatenation for these domains
 * produces [v|v|v] with zero temporal signal and 3× unnecessary embed cost.
 *
 * Returns { concat: number[] } with length 1024 for Qdrant upsert compatibility.
 * The Qdrant collection for static domains must be sized 1024, not 3072.
 */
export async function buildSingleEmbed(text: string): Promise<number[]> {
  return embed(text);
}

// ─────────────────────────────────────────────────────────────────
// GEOMETRY SCORING
// ─────────────────────────────────────────────────────────────────

/** Manhattan resonance — total energy of the 3072-D vector */
export function computeHeat(vec: number[]): number {
  return vec.reduce((acc, v) => acc + Math.abs(v), 0) / vec.length;
}

/** Euclidean distance from Diamond-Stable centroid */
export function computeShatter(vec: number[], centroid: number[]): number {
  if (vec.length !== centroid.length) throw new Error("Dimension mismatch");
  return Math.sqrt(
    vec.reduce((acc, v, i) => acc + Math.pow(v - centroid[i], 2), 0)
  );
}

/** ℓ₂ normalization with Kahan summation for numerical stability */
export function l2Normalize(vec: number[]): number[] {
  // Kahan summation
  let sum = 0, c = 0;
  for (const v of vec) {
    const y = v * v - c;
    const t = sum + y;
    c = (t - sum) - y;
    sum = t;
  }
  const mag = Math.sqrt(sum);
  if (mag < 1e-6) throw new Error("Zero vector — cannot normalize");
  return vec.map(v => v / mag);
}

/** REFRAG select-k: retain top-k dimensions by absolute magnitude */
export function refragSelectK(vec: number[], k = 256): { indices: number[]; values: number[]; energyRetained: number } {
  const indexed = vec.map((v, i) => ({ i, v, abs: Math.abs(v) }));
  indexed.sort((a, b) => b.abs - a.abs);
  const topK = indexed.slice(0, k);

  const totalEnergy = vec.reduce((acc, v) => acc + v * v, 0);
  const kEnergy = topK.reduce((acc, { v }) => acc + v * v, 0);

  return {
    indices: topK.map(x => x.i),
    values:  topK.map(x => x.v),
    energyRetained: totalEnergy > 0 ? kEnergy / totalEnergy : 0,
  };
}
