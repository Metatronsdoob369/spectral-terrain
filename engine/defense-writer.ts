/**
 * SPECTRAL TERRAIN — AUTONOMOUS DEFENSE WRITER
 *
 * Layer 3 of the blue-team autonomous defense system.
 * Receives a ThreatReport from threat-intake.ts and writes three artifacts:
 *
 *   Artifact 1 — Targeted Monitor  (defense/monitors/{id}.monitor.json)
 *     A watcher spec scoped to the canonical file being targeted.
 *     Records the tightened shatter threshold for that specific file
 *     (alarmThreshold * 0.6 — stricter than the domain-wide gate).
 *
 *   Artifact 2 — Hardening Patch   (defense/patches/{canonical-file}.patch.json)
 *     Documents the top-N delta dimensions (highest absolute magnitude),
 *     which correspond to the semantic features being distorted.
 *     Used by the developer to know exactly where to harden the canonical file.
 *
 *   Artifact 3 — Slop-Canon Entry  (written to Qdrant slop-canon collection)
 *     The threat vector permanently encoded as a failure memory.
 *     Future similar threats hit Channel C before threat-intake opens.
 *
 * Defense outputs are verified before writing:
 *   The defense-writer embeds its own output and shatter-checks it before
 *   activating. If the generated defense drifts geometrically from the stack
 *   (hallucinated content that doesn't fit), it is discarded and flagged.
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { embed, computeShatter } from "./embed.js";
import { loadCentroid } from "./calibrate.js";
import type { ThreatReport } from "./threat-intake.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const QDRANT_URL   = "http://127.0.0.1:6340";
const SLOP_COLL    = "slop-canon";

// Top-N delta dimensions to surface in the hardening patch report
const TOP_DELTA_DIMS = 20;

// Defense monitor uses a tighter threshold than the domain-wide alarm:
// the targeted watch is per-file, so we can afford stricter geometry.
const MONITOR_THRESHOLD_FACTOR = 0.6;

// ─────────────────────────────────────────────────────────────────
// OUTPUT TYPES
// ─────────────────────────────────────────────────────────────────

export interface MonitorSpec {
  id:               string;
  createdAt:        string;
  threatId:         string;
  domain:           string;
  watchFile:        string;   // canonical file being targeted
  tightenedThreshold: number; // alarmThreshold * MONITOR_THRESHOLD_FACTOR
  triggerOnShatter: number;   // same value — explicit for consumers
  deltaMagnitude:   number;
  status:           "active" | "superseded";
}

export interface HardeningPatch {
  id:                   string;
  createdAt:            string;
  threatId:             string;
  canonicalFile:        string;
  shatter:              number;
  deltaMagnitude:       number;
  topDeltaDimensions:   { dim: number; delta: number; abs: number }[];
  interpretation:       string;
  selfCheckShatter:     number | null;   // shatter of patch doc itself — confirms it fits the stack
  selfCheckPass:        boolean;
}

export interface SlopEntry {
  threatId:   string;
  errorType:  string;
  badPattern: string;
  correction: string;
  domain:     string;
  shatter:    number;
  file:       string;
}

export interface DefenseBundle {
  monitor:    MonitorSpec;
  patch:      HardeningPatch;
  slopEntry:  SlopEntry;
  reportPath: string;
}

// ─────────────────────────────────────────────────────────────────
// DELTA ANALYSIS — find top-N dimensions by absolute magnitude
// ─────────────────────────────────────────────────────────────────

function topDeltaDimensions(delta: number[], n: number): { dim: number; delta: number; abs: number }[] {
  return delta
    .map((v, i) => ({ dim: i, delta: v, abs: Math.abs(v) }))
    .sort((a, b) => b.abs - a.abs)
    .slice(0, n);
}

// ─────────────────────────────────────────────────────────────────
// SLOP-CANON WRITE — permanent failure memory entry in Qdrant
// ─────────────────────────────────────────────────────────────────

async function writeSlopCanonEntry(entry: SlopEntry, vec: number[]): Promise<boolean> {
  try {
    const res = await fetch(`${QDRANT_URL}/collections/${SLOP_COLL}/points`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: [{
          id:      entry.threatId,
          vector:  vec,
          payload: {
            errorType:  entry.errorType,
            badPattern: entry.badPattern.slice(0, 500),  // truncate — slop-canon stores pattern fingerprint, not full text
            correction: entry.correction,
            domain:     entry.domain,
            shatter:    entry.shatter,
            file:       entry.file,
            title:      `THREAT-${entry.errorType} on ${entry.file}`,
            createdAt:  new Date().toISOString(),
          },
        }],
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────
// SELF-CHECK — verify defense output fits the stack geometry
//
// Embeds a summary of the defense artifacts and shatter-checks it.
// If shatter > alarmThreshold the defense itself has drifted from
// canonical ground — discard and flag rather than activating bad output.
// ─────────────────────────────────────────────────────────────────

async function selfCheckDefense(
  patch: HardeningPatch,
  report: ThreatReport,
): Promise<number | null> {
  try {
    const summary = [
      `HARDENING PATCH for ${patch.canonicalFile}`,
      `Threat shatter: ${patch.shatter.toFixed(4)}`,
      `Top delta dimensions: ${patch.topDeltaDimensions.slice(0, 5).map(d => `dim${d.dim}(${d.delta.toFixed(4)})`).join(", ")}`,
      `Domain: ${report.domain}`,
    ].join(" | ");

    const vec = await embed(summary);
    const centroid = loadCentroid(report.domain);
    if (!centroid) return null;
    return computeShatter(vec, centroid);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// MAIN WRITER
// ─────────────────────────────────────────────────────────────────

export async function writeDefense(report: ThreatReport): Promise<DefenseBundle | null> {
  if (report.classification === "FALSE_ALARM") {
    console.log(`[defense-writer] FALSE_ALARM — no defense artifacts written for ${report.id}`);
    return null;
  }

  if (!report.delta || report.deltaMagnitude === null) {
    console.warn(`[defense-writer] No delta available for ${report.id} — skipping artifact generation`);
    return null;
  }

  const defenseDir  = join(__dirname, "../defense");
  const monitorsDir = join(defenseDir, "monitors");
  const patchesDir  = join(defenseDir, "patches");
  const reportsDir  = join(defenseDir, "reports");
  for (const d of [monitorsDir, patchesDir, reportsDir]) mkdirSync(d, { recursive: true });

  // ── Artifact 1: Targeted Monitor ──────────────────────────────
  const tightenedThreshold = report.profile.alarmThreshold * MONITOR_THRESHOLD_FACTOR;
  const monitor: MonitorSpec = {
    id:                 `mon-${report.id}`,
    createdAt:          report.timestamp,
    threatId:           report.id,
    domain:             report.domain,
    watchFile:          report.nearestCanonicalFile ?? "(unknown)",
    tightenedThreshold,
    triggerOnShatter:   tightenedThreshold,
    deltaMagnitude:     report.deltaMagnitude,
    status:             "active",
  };

  // ── Artifact 2: Hardening Patch ───────────────────────────────
  const topDims = topDeltaDimensions(report.delta, TOP_DELTA_DIMS);

  const patch: HardeningPatch = {
    id:                 `patch-${report.id}`,
    createdAt:          report.timestamp,
    threatId:           report.id,
    canonicalFile:      report.nearestCanonicalFile ?? "(unknown)",
    shatter:            report.shatter,
    deltaMagnitude:     report.deltaMagnitude,
    topDeltaDimensions: topDims,
    interpretation:     buildInterpretation(topDims, report),
    selfCheckShatter:   null,
    selfCheckPass:      false,
  };

  // Self-check: verify patch document fits canonical geometry
  patch.selfCheckShatter = await selfCheckDefense(patch, report);
  patch.selfCheckPass    = patch.selfCheckShatter !== null
                         ? patch.selfCheckShatter < report.profile.alarmThreshold
                         : false;

  if (!patch.selfCheckPass) {
    console.warn(`[defense-writer] Self-check failed for patch ${patch.id} (selfCheckShatter: ${patch.selfCheckShatter?.toFixed(4) ?? "null"}) — patch written but flagged`);
  }

  // ── Artifact 3: Slop-Canon Entry ──────────────────────────────
  const errorType = `SHATTER-${report.classification}-${report.domain.toUpperCase()}`;
  const slopEntry: SlopEntry = {
    threatId:   report.id,
    errorType,
    badPattern: report.artifactText,
    correction: `Harden ${report.nearestCanonicalFile ?? "target"} at top delta dimensions: ${topDims.slice(0, 5).map(d => `dim${d.dim}`).join(", ")}`,
    domain:     report.domain,
    shatter:    report.shatter,
    file:       report.nearestCanonicalFile ?? "(unknown)",
  };

  const slopWritten = await writeSlopCanonEntry(slopEntry, report.artifactVec);

  // ── Write to disk ──────────────────────────────────────────────
  const monitorPath = join(monitorsDir, `${report.id}.monitor.json`);
  const patchPath   = join(patchesDir,  `${report.id}.patch.json`);
  const reportPath  = join(reportsDir,  `${report.id}.report.json`);

  writeFileSync(monitorPath, JSON.stringify(monitor,   null, 2));
  writeFileSync(patchPath,   JSON.stringify(patch,     null, 2));

  const fullReport = {
    intake:     report,
    monitor,
    patch,
    slopEntry,
    slopWritten,
    selfCheckPass: patch.selfCheckPass,
  };
  writeFileSync(reportPath, JSON.stringify(fullReport, null, 2));

  // Summary
  const selfTag  = patch.selfCheckPass ? "✓" : "⚠ self-check failed";
  const slopTag  = slopWritten ? "✓ written to slop-canon" : "✗ slop-canon write failed";
  console.log(`[defense-writer] ${report.classification} — defense bundle written`);
  console.log(`  Monitor:   ${monitorPath} (threshold: ${tightenedThreshold.toFixed(4)})`);
  console.log(`  Patch:     ${patchPath} (self-check: ${selfTag})`);
  console.log(`  Slop-canon: ${slopTag}`);
  console.log(`  Report:    ${reportPath}`);

  return { monitor, patch, slopEntry, reportPath };
}

// ─────────────────────────────────────────────────────────────────
// INTERPRETATION — human-readable summary of top delta dimensions
//
// The delta is a 1024-D direction vector. High-magnitude dimensions
// correspond to semantic features being distorted. This builds a
// plain-English summary anchored to what we know about the domain.
// ─────────────────────────────────────────────────────────────────

function buildInterpretation(
  topDims: { dim: number; delta: number; abs: number }[],
  report: ThreatReport,
): string {
  const topN = topDims.slice(0, 5);
  const direction = topN.map(d =>
    `dim${d.dim} ${d.delta >= 0 ? "+" : ""}${d.delta.toFixed(4)}`
  ).join(", ");

  const shatterBand = report.shatter >= report.profile.alarmThreshold
    ? `HIGH-SHATTER (${report.shatter.toFixed(4)} >= alarm threshold ${report.profile.alarmThreshold})`
    : `WATCH-SHATTER (${report.shatter.toFixed(4)} >= watch threshold ${report.profile.watchThreshold})`;

  return [
    `${shatterBand} on domain ${report.domain}.`,
    `Nearest canonical: ${report.nearestCanonicalFile ?? "unknown"} (similarity: ${report.nearestCanonicalSim?.toFixed(4) ?? "—"}).`,
    `Delta magnitude: ${report.deltaMagnitude?.toFixed(4) ?? "—"} — top distorted dimensions: [${direction}].`,
    `Harden entry points in ${report.nearestCanonicalFile ?? "target file"} that correspond to the semantic features encoded at those dimensions.`,
  ].join(" ");
}

// ─────────────────────────────────────────────────────────────────
// CLI ENTRY — for manual testing
//   npx tsx engine/defense-writer.ts --threat defense/reports/{id}.report.json
// ─────────────────────────────────────────────────────────────────

if (process.argv[1]?.includes("defense-writer")) {
  const args      = process.argv.slice(2);
  const threatIdx = args.indexOf("--threat");
  if (threatIdx === -1 || !args[threatIdx + 1]) {
    console.error("Usage: tsx engine/defense-writer.ts --threat defense/reports/{id}.report.json");
    process.exit(1);
  }
  const reportPath = args[threatIdx + 1];
  if (!existsSync(reportPath)) {
    console.error(`Report not found: ${reportPath}`);
    process.exit(1);
  }
  const { readFileSync } = await import("fs");
  const { intake } = JSON.parse(readFileSync(reportPath, "utf-8")) as { intake: ThreatReport };
  writeDefense(intake).then(bundle => {
    if (!bundle) { console.log("No bundle written."); process.exit(0); }
    console.log(`\nBundle complete: ${bundle.reportPath}`);
  }).catch(err => {
    console.error("[defense-writer] Fatal:", err.message);
    process.exit(1);
  });
}
