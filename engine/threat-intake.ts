/**
 * SPECTRAL TERRAIN — THREAT INTAKE PIPELINE
 *
 * Layer 2 of the blue-team autonomous defense system.
 * Triggered by the watchdog when a geometric alarm fires.
 *
 * Pipeline:
 *   ARTIFACT IN
 *     → preKNNGate  (O(1) policy checks before any vector operation)
 *     → embed       (mxbai 1024-D)
 *     → shatter     (Euclidean distance from domain centroid)
 *     → classify:
 *         < watchThreshold  → FALSE_ALARM (log and release)
 *         watchThreshold–alarmThreshold → WATCH (flag for review)
 *         > alarmThreshold  → THREAT (proceed to delta analysis)
 *     → delta       (artifact_vec - nearest_canonical_vec)
 *                   Direction in 1024-D space describing what the artifact
 *                   is trying to become relative to canonical code.
 *     → ThreatReport (consumed by defense-writer.ts)
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { embed, buildPlaceholderVector, computeShatter } from "./embed.js";
import { loadCentroid } from "./calibrate.js";
import { DOMAIN_GEOMETRY } from "../contracts/terrain.contract.js";
import type { Domain } from "../contracts/terrain.contract.js";

async function embedForDomain(text: string, domain: Domain): Promise<number[]> {
  const geometry = DOMAIN_GEOMETRY[domain];
  if (geometry?.temporal) {
    const tv = await buildPlaceholderVector(text);
    return tv.concat;
  }
  return embed(text);
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const QDRANT_URL     = "http://127.0.0.1:6340";
const HEATMAP_COLL   = "spectral-heatmap";
const EMBED_DIM      = 1024;

// ─────────────────────────────────────────────────────────────────
// DOMAIN PROFILE — loaded from calibration/{domain}-profile.json
// ─────────────────────────────────────────────────────────────────

export interface DomainProfile {
  domain:           string;
  watchThreshold:   number;  // shatter below = false alarm
  alarmThreshold:   number;  // shatter above = threat intake opens
  slopQueryCutoff:  number;  // cosine above = slop-canon hold
}

export function loadDomainProfile(domain: Domain): DomainProfile {
  const p = join(__dirname, `../calibration/${domain}-profile.json`);
  if (!existsSync(p)) {
    // Safe fallback — wide thresholds to avoid false positives during calibration
    console.warn(`[threat-intake] No profile for domain ${domain} — using conservative defaults`);
    return { domain, watchThreshold: 1.30, alarmThreshold: 1.45, slopQueryCutoff: 0.85 };
  }
  return JSON.parse(readFileSync(p, "utf-8")) as DomainProfile;
}

// ─────────────────────────────────────────────────────────────────
// THREAT REPORT — output of this pipeline, input to defense-writer
// ─────────────────────────────────────────────────────────────────

export type ThreatClassification = "FALSE_ALARM" | "WATCH" | "THREAT";

export interface ThreatReport {
  id:                  string;          // uuid for this intake run
  timestamp:           string;
  classification:      ThreatClassification;
  domain:              Domain;
  artifactText:        string;
  shatter:             number;
  nearestCanonicalId:  string | null;   // Qdrant point ID
  nearestCanonicalFile: string | null;
  nearestCanonicalSim: number | null;   // cosine similarity (0–1)
  delta:               number[] | null; // artifact_vec - canonical_vec (1024-D)
  deltaMagnitude:      number | null;   // ℓ2 norm of delta
  artifactVec:         number[];
  profile:             DomainProfile;
}

// ─────────────────────────────────────────────────────────────────
// PRE-KNN GATE — O(1) policy checks before any vector operation
//
// These run on the artifact itself, before any Qdrant query.
// Short-circuits vectors that can't be usefully compared:
//   - domain not in scope
//   - text too short to embed meaningfully
//   - text too long (would exceed chunking ceiling, possible poisoned input)
//   - no centroid available for domain
// ─────────────────────────────────────────────────────────────────

const ALLOWED_DOMAINS: Set<string> = new Set(["source-audit", "roblox-luau", "general", "reddit"]);
const MIN_CHARS  = 20;
const MAX_CHARS  = 200_000;  // ~50K words — above embed ceiling, likely poisoned

export interface PreKNNGateResult {
  pass:   boolean;
  reason: string;
}

export function preKNNGate(text: string, domain: Domain): PreKNNGateResult {
  if (!ALLOWED_DOMAINS.has(domain)) {
    return { pass: false, reason: `domain '${domain}' not in threat-intake scope` };
  }
  if (text.length < MIN_CHARS) {
    return { pass: false, reason: `artifact too short (${text.length} chars < ${MIN_CHARS})` };
  }
  if (text.length > MAX_CHARS) {
    return { pass: false, reason: `artifact too large (${text.length} chars > ${MAX_CHARS}) — possible poisoned input` };
  }
  const centroid = loadCentroid(domain);
  if (!centroid) {
    return { pass: false, reason: `no centroid for domain '${domain}' — run npm run calibrate first` };
  }
  return { pass: true, reason: "ok" };
}

// ─────────────────────────────────────────────────────────────────
// NEAREST CANONICAL QUERY — KNN=1 in spectral-heatmap
// ─────────────────────────────────────────────────────────────────

interface CanonicalNeighbor {
  id:     string;
  file:   string;
  score:  number;
  vector: number[];
}

async function nearestCanonical(vec: number[], domain: Domain): Promise<CanonicalNeighbor | null> {
  try {
    const res = await fetch(`${QDRANT_URL}/collections/${HEATMAP_COLL}/points/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vector:      vec,
        limit:       1,
        with_vector: true,
        with_payload: true,
        filter: {
          must: [
            { key: "domain",            match: { value: domain } },
            { key: "kind",              match: { value: "canonical" } },
            { key: "source_resolvable", match: { value: true } },
          ],
        },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      result: { id: string; score: number; payload: Record<string, unknown>; vector: number[] }[];
    };
    if (!data.result.length) return null;
    const top = data.result[0];
    return {
      id:     String(top.id),
      file:   String(top.payload["file"] ?? "(unknown)"),
      score:  top.score,
      vector: top.vector,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// DELTA COMPUTE — artifact_vec - canonical_vec
//
// This is not a diff. It's a direction in 1024-D space.
// High-magnitude dimensions in delta = semantic features being distorted.
// The defense-writer uses this to write targeted hardening at those dimensions.
// ─────────────────────────────────────────────────────────────────

function computeDelta(artifactVec: number[], canonicalVec: number[]): number[] {
  if (artifactVec.length !== canonicalVec.length) {
    throw new Error(`Delta dimension mismatch: ${artifactVec.length} vs ${canonicalVec.length}`);
  }
  return artifactVec.map((v, i) => v - canonicalVec[i]);
}

function l2Norm(vec: number[]): number {
  return Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
}

// ─────────────────────────────────────────────────────────────────
// MAIN INTAKE FUNCTION
// ─────────────────────────────────────────────────────────────────

export async function runThreatIntake(
  artifactText: string,
  domain: Domain,
): Promise<ThreatReport> {
  const id        = `ti-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = new Date().toISOString();
  const profile   = loadDomainProfile(domain);

  // 1. Pre-KNN gate
  const gate = preKNNGate(artifactText, domain);
  if (!gate.pass) {
    const vec = new Array(EMBED_DIM).fill(0);
    return {
      id, timestamp, domain, artifactText, profile,
      classification:       "FALSE_ALARM",
      shatter:              0,
      nearestCanonicalId:   null,
      nearestCanonicalFile: null,
      nearestCanonicalSim:  null,
      delta:                null,
      deltaMagnitude:       null,
      artifactVec:          vec,
    };
  }

  // 2. Embed artifact
  let artifactVec: number[];
  try {
    artifactVec = await embedForDomain(artifactText, domain);
  } catch (err: unknown) {
    throw new Error(`[threat-intake] embed failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Shatter check against domain centroid
  const centroid = loadCentroid(domain)!;
  if (artifactVec.length !== centroid.length) {
    throw new Error(
      `[threat-intake] Centroid dimension mismatch for ${domain}: vec=${artifactVec.length} centroid=${centroid.length}. ` +
      `Run npm run calibrate -- --domain ${domain} after ingesting source-audit corpus.`
    );
  }
  const shatter  = computeShatter(artifactVec, centroid);

  // 4. Classify
  const classification: ThreatClassification =
    shatter < profile.watchThreshold  ? "FALSE_ALARM"
    : shatter < profile.alarmThreshold ? "WATCH"
    :                                    "THREAT";

  // 5. For WATCH and THREAT: find nearest canonical + compute delta
  let neighbor:             CanonicalNeighbor | null = null;
  let delta:                number[] | null          = null;
  let deltaMagnitude:       number   | null          = null;

  if (classification !== "FALSE_ALARM") {
    neighbor = await nearestCanonical(artifactVec, domain);
    if (neighbor) {
      delta          = computeDelta(artifactVec, neighbor.vector);
      deltaMagnitude = l2Norm(delta);
    }
  }

  const report: ThreatReport = {
    id,
    timestamp,
    classification,
    domain,
    artifactText,
    shatter,
    nearestCanonicalId:   neighbor?.id   ?? null,
    nearestCanonicalFile: neighbor?.file ?? null,
    nearestCanonicalSim:  neighbor?.score ?? null,
    delta,
    deltaMagnitude,
    artifactVec,
    profile,
  };

  // Console summary
  const tag = classification === "THREAT"      ? "[THREAT]"
            : classification === "WATCH"        ? "[WATCH]"
            :                                     "[false alarm]";
  console.log(`${tag} shatter: ${shatter.toFixed(4)} | nearest: ${neighbor?.file ?? "—"} (sim: ${neighbor?.score?.toFixed(4) ?? "—"}) | delta‖: ${deltaMagnitude?.toFixed(4) ?? "—"}`);

  return report;
}
