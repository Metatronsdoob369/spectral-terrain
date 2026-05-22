/**
 * SPECTRAL TERRAIN — QUERY ENGINE
 *
 * First thing any agent calls upon entry.
 * "What already exists near my intent?"
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import { embed, buildPlaceholderVector, computeHeat, computeShatter } from "./embed.js";
import type { ShatterReport, Domain } from "../contracts/terrain.contract.js";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const QDRANT_URL = "http://127.0.0.1:6340";
const HEATMAP_COLLECTION = "spectral-heatmap";
const SLOP_COLLECTION = "slop-canon";

// ─────────────────────────────────────────────────────────────────
// LOAD CENTROID
// ─────────────────────────────────────────────────────────────────

function loadCentroid(domain: Domain): number[] | null {
  const p = join(__dirname, `../calibration/${domain}-centroid.json`);
  if (!existsSync(p)) return null;
  const data = JSON.parse(readFileSync(p, "utf-8"));
  return data.vector;
}

// ─────────────────────────────────────────────────────────────────
// NEAREST CANONICAL QUERY
// ─────────────────────────────────────────────────────────────────

export async function queryNearest(
  text: string,
  domain: Domain,
  topK = 3,
): Promise<{ id: string; file: string; shatter: number; score: number }[]> {
  const tv = await buildPlaceholderVector(text);
  const vector = tv.concat;

  const res = await fetch(`${QDRANT_URL}/collections/${HEATMAP_COLLECTION}/points/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vector,
      limit: topK,
      with_payload: true,
      filter: {
        must: [
          { key: "domain", match: { value: domain } },
          { key: "kind",   match: { value: "canonical" } },
        ],
      },
    }),
  });

  if (!res.ok) throw new Error(`Qdrant query failed: ${res.statusText}`);
  const data = await res.json() as { result: { id: string; payload: any; score: number }[] };

  return data.result.map(r => ({
    id:      r.id,
    file:    r.payload.file,
    shatter: r.payload.shatter,
    score:   r.score,
  }));
}

// ─────────────────────────────────────────────────────────────────
// SHATTER REPORT (Full diagnostic on a code snippet)
// ─────────────────────────────────────────────────────────────────

export async function getShatterReport(
  file: string,
  text: string,
  domain: Domain,
): Promise<ShatterReport> {
  const tv = await buildPlaceholderVector(text);
  const centroid = loadCentroid(domain);

  const heat    = computeHeat(tv.concat);
  const shatter = centroid ? computeShatter(tv.concat, centroid) : -1;

  const nearest = await queryNearest(text, domain, 1);
  const nearestCanonical = nearest.length > 0
    ? { file: nearest[0].file, shatter: nearest[0].shatter, distance: 1 - nearest[0].score }
    : null;

  let recommendation: ShatterReport["recommendation"];
  if (shatter < 0)                recommendation = "SLOP_CHECK"; // no centroid yet
  else if (shatter < 0.05)        recommendation = "ANCHOR";
  else if (shatter < 0.15)        recommendation = "REVIEW";
  else                             recommendation = "SHATTER_RESOLVE";

  return {
    queryFile: file,
    domain,
    shatter,
    heat,
    kind: shatter < 0.05 ? "canonical" : "shattered",
    nearestCanonical,
    recommendation,
    timestamp: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────
// SLOP CANON QUERY (Check failure memory before acting)
// ─────────────────────────────────────────────────────────────────

export async function querySlop(
  pattern: string,
  topK = 3,
): Promise<{ title: string; errorType: string; correction: string; score: number }[]> {
  const vec = await embed(pattern);

  const res = await fetch(`${QDRANT_URL}/collections/${SLOP_COLLECTION}/points/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vector: vec, limit: topK, with_payload: true }),
  });

  if (!res.ok) return []; // slop-canon may be empty early on — that's fine
  const data = await res.json() as { result: { payload: any; score: number }[] };

  return data.result.map(r => {
    const p = r.payload;
    // Support both generic slop entries and LuauShatterCertificate format
    return {
      title:      p.title      ?? p.moduleName ?? p.source ?? "unknown",
      errorType:  p.errorType  ?? p.errorSignature ?? "",
      correction: p.correction ?? p.verifiedFix ?? "",
      score:      r.score,
    };
  });
}
