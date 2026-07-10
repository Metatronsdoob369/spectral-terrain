/**
 * SPECTRAL TERRAIN — CIRCADIAN LAYER 4
 *
 * Nightly hardening loop. Runs after the DREAM cycle confirms the
 * husk shard index is stable. Performs four steps:
 *
 * Step 1 — Monitor drift check
 *   Load all active MonitorSpecs written in the last 24h.
 *   Re-embed the canonical file each monitor is watching.
 *   Compute shatter against the current centroid.
 *   If shatter has moved significantly (> MONITOR_RECAL_THRESHOLD),
 *   the canonical file was legitimately updated — recalibrate the
 *   monitor's triggerOnShatter to track the new geometry.
 *
 * Step 2 — Centroid recompute
 *   Recompute the Diamond-Stable centroid for each domain that had
 *   at least one monitor recalibration or new canonical ingest today.
 *   Writes the updated centroid JSON — watchdog + threat-intake reload
 *   it on next call to loadCentroid() (reads from disk each time).
 *
 * Step 3 — Domain profile recalibration
 *   After centroid update, recompute shatter distribution over all
 *   canonical points. If p90 or σ shifted > PROFILE_DRIFT_THRESHOLD,
 *   update calibration/{domain}-profile.json with new thresholds.
 *
 * Step 4 — Missing-source audit
 *   For every terrain point with source_resolvable: true, verify the
 *   source file still exists on disk. Missing files = DELETE alarm
 *   (canonical file removed after ingest — this is a security event).
 *   Write missing-source events to telemetry/missing-sources.jsonl.
 *
 * Usage:
 *   npx tsx engine/circadian.ts [--domain source-audit]
 *   Called by CircadianPulse.dream() in circadian/pulse.ts
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import {
  existsSync, readFileSync, writeFileSync,
  mkdirSync, readdirSync, appendFileSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { embed, computeShatter } from "./embed.js";
import { calibrate, loadCentroid } from "./calibrate.js";
import type { Domain } from "../contracts/terrain.contract.js";
import type { MonitorSpec } from "./defense-writer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const QDRANT_URL  = "http://127.0.0.1:6340";
const HEATMAP     = "spectral-heatmap";

// ─────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────

// If a watched canonical file's shatter moves by more than this
// from its recorded baseline, the monitor threshold is recalibrated.
const MONITOR_RECAL_THRESHOLD = 0.05;

// If domain p90 or σ shift by more than this fraction after centroid
// recompute, the profile thresholds are updated.
const PROFILE_DRIFT_THRESHOLD = 0.02;

// Look back this many ms when scanning for recent monitors.
const MONITOR_LOOKBACK_MS = 24 * 60 * 60 * 1000;

// Source roots — same as drift-sidecar KNOWN_ROOTS
const KNOWN_ROOTS = [
  "/Volumes/ARCHIVE/Emergency_Information/WhiteGlove_Agent_Husk",
  "/Users/joewales/NODE_OUT_Master/spectral-terrain",
  process.cwd(),
];

// ─────────────────────────────────────────────────────────────────
// CIRCADIAN REPORT
// ─────────────────────────────────────────────────────────────────

export interface CircadianReport {
  timestamp:          string;
  domain:             Domain | null;
  monitorsChecked:    number;
  monitorsRecal:      number;       // thresholds updated
  centroidsRecomputed: string[];    // domain names
  profilesUpdated:    string[];     // domain names
  missingSourceCount: number;
  missingSourceFiles: string[];
  status:             "clean" | "recalibrated" | "missing_sources";
}

// ─────────────────────────────────────────────────────────────────
// STEP 1 — MONITOR DRIFT CHECK
// ─────────────────────────────────────────────────────────────────

function resolveSource(relFile: string): string | null {
  for (const root of KNOWN_ROOTS) {
    const full = join(root, relFile);
    if (existsSync(full)) return readFileSync(full, "utf-8");
  }
  return null;
}

function loadRecentMonitors(): MonitorSpec[] {
  const monitorsDir = join(__dirname, "../defense/monitors");
  if (!existsSync(monitorsDir)) return [];

  const cutoff = Date.now() - MONITOR_LOOKBACK_MS;
  const specs: MonitorSpec[] = [];

  for (const f of readdirSync(monitorsDir)) {
    if (!f.endsWith(".monitor.json")) continue;
    try {
      const spec = JSON.parse(readFileSync(join(monitorsDir, f), "utf-8")) as MonitorSpec;
      const ts   = new Date(spec.createdAt).getTime();
      if (ts >= cutoff && spec.status === "active") specs.push(spec);
    } catch {
      // skip malformed files
    }
  }

  return specs;
}

async function checkAndRecalibrate(
  monitors: MonitorSpec[],
): Promise<{ recalCount: number; affectedDomains: Set<string> }> {
  let recalCount = 0;
  const affectedDomains = new Set<string>();

  for (const spec of monitors) {
    const source = resolveSource(spec.watchFile);
    if (!source) continue;  // file gone — handled by Step 4

    const domain   = spec.domain as Domain;
    const centroid = loadCentroid(domain);
    if (!centroid) continue;

    let vec: number[];
    try {
      vec = await embed(source);
    } catch {
      continue;
    }

    const currentShatter = computeShatter(vec, centroid);

    // If shatter moved significantly from the recorded threshold baseline,
    // the canonical file was legitimately updated. Recalibrate.
    const baseline = spec.triggerOnShatter / 0.6;  // reverse the 0.6 factor to get original alarm
    const delta    = Math.abs(currentShatter - baseline);

    if (delta > MONITOR_RECAL_THRESHOLD) {
      // Load the profile to get the domain alarm threshold
      const profilePath = join(__dirname, `../calibration/${domain}-profile.json`);
      const profile = existsSync(profilePath)
        ? JSON.parse(readFileSync(profilePath, "utf-8")) as { alarmThreshold: number }
        : { alarmThreshold: 1.45 };

      const newTrigger = profile.alarmThreshold * 0.6;
      spec.triggerOnShatter  = newTrigger;
      spec.tightenedThreshold = newTrigger;

      const monitorPath = join(__dirname, `../defense/monitors/${spec.id}.monitor.json`);
      // id doesn't include the mon- prefix in the filename? Use threatId-based name pattern
      const candidates = readdirSync(join(__dirname, "../defense/monitors"))
        .filter(f => f.includes(spec.threatId));
      const target = candidates.length > 0
        ? join(__dirname, `../defense/monitors/${candidates[0]}`)
        : monitorPath;

      writeFileSync(target, JSON.stringify(spec, null, 2));
      console.log(`  [recal] ${spec.watchFile} | shatter delta ${delta.toFixed(4)} > threshold → new trigger: ${newTrigger.toFixed(4)}`);
      recalCount++;
      affectedDomains.add(domain);
    } else {
      console.log(`  [ok]   ${spec.watchFile} | shatter: ${currentShatter.toFixed(4)} (delta: ${delta.toFixed(4)}) — monitor stable`);
    }
  }

  return { recalCount, affectedDomains };
}

// ─────────────────────────────────────────────────────────────────
// STEP 2 — CENTROID RECOMPUTE
// ─────────────────────────────────────────────────────────────────

async function recomputeIfNeeded(
  domains: Set<string>,
  forceDomain?: Domain,
): Promise<string[]> {
  const toRecompute = new Set<string>(domains);
  if (forceDomain) toRecompute.add(forceDomain);

  const recomputed: string[] = [];

  for (const domain of toRecompute) {
    try {
      console.log(`  [centroid] Recomputing ${domain}...`);
      await calibrate(domain as Domain);
      recomputed.push(domain);
    } catch (err: unknown) {
      console.error(`  [centroid] Failed for ${domain}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return recomputed;
}

// ─────────────────────────────────────────────────────────────────
// STEP 3 — DOMAIN PROFILE RECALIBRATION
// ─────────────────────────────────────────────────────────────────

async function fetchShatterDistribution(domain: Domain): Promise<number[]> {
  const values: number[] = [];
  let offset: string | null = null;

  while (true) {
    const body: Record<string, unknown> = {
      limit: 200, with_vector: false, with_payload: true,
      filter: { must: [
        { key: "domain", match: { value: domain } },
        { key: "kind",   match: { value: "canonical" } },
      ]},
    };
    if (offset) body.offset = offset;

    const res = await fetch(`${QDRANT_URL}/collections/${HEATMAP}/points/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) break;
    const data = await res.json() as {
      result: { points: { payload: Record<string, unknown> }[]; next_page_offset: string | null };
    };

    for (const p of data.result.points) {
      const s = p.payload["shatter"];
      if (typeof s === "number" && s > 0) values.push(s);
    }

    offset = data.result.next_page_offset;
    if (!offset) break;
  }

  return values;
}

async function recalibrateProfilesIfNeeded(recomputedDomains: string[]): Promise<string[]> {
  const updated: string[] = [];

  for (const domain of recomputedDomains) {
    const profilePath = join(__dirname, `../calibration/${domain}-profile.json`);
    if (!existsSync(profilePath)) continue;

    const prev = JSON.parse(readFileSync(profilePath, "utf-8")) as {
      shatterP90: number; shatterStdev: number;
      watchThreshold: number; alarmThreshold: number; slopQueryCutoff: number;
      canonicalCount: number; calibratedAt: string;
    };

    const sv = (await fetchShatterDistribution(domain as Domain)).sort((a, b) => a - b);
    if (sv.length < 5) continue;

    const newP90   = sv[Math.floor(sv.length * 0.9)];
    const mean     = sv.reduce((s, v) => s + v, 0) / sv.length;
    const newStdev = Math.sqrt(sv.reduce((s, v) => s + (v - mean) ** 2, 0) / sv.length);

    const p90Drift   = Math.abs(newP90   - prev.shatterP90)   / prev.shatterP90;
    const stdevDrift = Math.abs(newStdev - prev.shatterStdev) / prev.shatterStdev;

    if (p90Drift < PROFILE_DRIFT_THRESHOLD && stdevDrift < PROFILE_DRIFT_THRESHOLD) {
      console.log(`  [profile] ${domain} — p90 drift ${(p90Drift * 100).toFixed(1)}%, σ drift ${(stdevDrift * 100).toFixed(1)}% — within tolerance, no update`);
      continue;
    }

    const newProfile = {
      ...prev,
      calibratedAt:    new Date().toISOString().split("T")[0],
      canonicalCount:  sv.length,
      shatterP90:      newP90,
      shatterStdev:    newStdev,
      watchThreshold:  parseFloat(newP90.toFixed(4)),
      alarmThreshold:  parseFloat((newP90 + 1.5 * newStdev).toFixed(4)),
    };

    writeFileSync(profilePath, JSON.stringify(newProfile, null, 2));
    console.log(`  [profile] ${domain} — updated: watch=${newProfile.watchThreshold} alarm=${newProfile.alarmThreshold} (p90 drift ${(p90Drift * 100).toFixed(1)}%)`);
    updated.push(domain);
  }

  return updated;
}

// ─────────────────────────────────────────────────────────────────
// STEP 4 — MISSING-SOURCE AUDIT
//
// Any terrain point with source_resolvable: true whose source file
// is no longer on disk is a security event: a canonical file was
// removed after ingest. Logged to telemetry/missing-sources.jsonl.
// ─────────────────────────────────────────────────────────────────

interface MissingSourceEvent {
  timestamp:  string;
  domain:     string;
  file:       string;
  pointId:    string;
  eventType:  "CANONICAL_FILE_DELETED";
}

async function auditMissingSources(domain?: Domain): Promise<{ count: number; files: string[] }> {
  const domainFilter = domain ? [{ key: "domain", match: { value: domain } }] : [];
  const missing: string[] = [];
  let offset: string | null = null;

  while (true) {
    const body: Record<string, unknown> = {
      limit: 200, with_vector: false, with_payload: true,
      filter: { must: [
        { key: "source_resolvable", match: { value: true } },
        ...domainFilter,
      ]},
    };
    if (offset) body.offset = offset;

    const res = await fetch(`${QDRANT_URL}/collections/${HEATMAP}/points/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) break;
    const data = await res.json() as {
      result: {
        points: { id: string; payload: Record<string, unknown> }[];
        next_page_offset: string | null;
      };
    };

    for (const p of data.result.points) {
      const file = p.payload["file"] as string | undefined;
      if (!file) continue;
      if (resolveSource(file) === null) {
        missing.push(file);

        const event: MissingSourceEvent = {
          timestamp: new Date().toISOString(),
          domain:    String(p.payload["domain"] ?? "unknown"),
          file,
          pointId:   String(p.id),
          eventType: "CANONICAL_FILE_DELETED",
        };

        const logPath = join(__dirname, "../telemetry/missing-sources.jsonl");
        mkdirSync(join(__dirname, "../telemetry"), { recursive: true });
        appendFileSync(logPath, JSON.stringify(event) + "\n");
      }
    }

    offset = data.result.next_page_offset;
    if (!offset) break;
  }

  if (missing.length > 0) {
    console.log(`  [missing-source] ${missing.length} CANONICAL_FILE_DELETED event(s):`);
    for (const f of missing) console.log(`    DELETE ALARM: ${f}`);
  }

  return { count: missing.length, files: missing };
}

// ─────────────────────────────────────────────────────────────────
// MAIN CIRCADIAN RUN
// ─────────────────────────────────────────────────────────────────

export async function runCircadian(domain?: Domain): Promise<CircadianReport> {
  const timestamp = new Date().toISOString();
  console.log(`\n[circadian] Layer 4 hardening loop — ${timestamp}`);
  if (domain) console.log(`[circadian] Domain scope: ${domain}`);

  // Pre-step: Finance refinery — runs before hardening if finance-crypto domain is in scope
  if (!domain || domain === "finance-crypto") {
    const todayDate = new Date().toISOString().slice(0, 10);
    const packPath  = join(__dirname, `../store/finance-crypto-${todayDate}.jsonl`);
    if (!existsSync(packPath)) {
      console.log("\n[circadian] Pre-step — Finance terrain refinery");
      const { spawnSync } = await import("child_process");
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx/esm", join(__dirname, "../scripts/refinery-finance.ts")],
        { stdio: "inherit", env: { ...process.env } },
      );
      if (result.status !== 0) {
        console.error("[circadian] Finance refinery failed — continuing hardening without new pack");
      }
    } else {
      console.log(`\n[circadian] Pre-step — Finance pack for ${todayDate} already exists, skipping refinery`);
    }
  }

  // Step 1: Monitor drift check
  console.log("\n[circadian] Step 1 — Monitor drift check");
  const monitors = loadRecentMonitors();
  console.log(`  Active monitors (last 24h): ${monitors.length}`);
  const { recalCount, affectedDomains } = monitors.length > 0
    ? await checkAndRecalibrate(monitors)
    : { recalCount: 0, affectedDomains: new Set<string>() };

  // Step 2: Centroid recompute
  console.log("\n[circadian] Step 2 — Centroid recompute");
  const centroidsRecomputed = await recomputeIfNeeded(affectedDomains, domain);
  if (centroidsRecomputed.length === 0) {
    console.log("  No domains needed recompute — centroids stable");
  }

  // Step 3: Profile recalibration
  console.log("\n[circadian] Step 3 — Domain profile recalibration");
  const profilesUpdated = centroidsRecomputed.length > 0
    ? await recalibrateProfilesIfNeeded(centroidsRecomputed)
    : [];
  if (profilesUpdated.length === 0 && centroidsRecomputed.length > 0) {
    console.log("  Profiles within tolerance — no update needed");
  } else if (centroidsRecomputed.length === 0) {
    console.log("  Skipped — no centroids were recomputed");
  }

  // Step 4: Missing-source audit
  console.log("\n[circadian] Step 4 — Missing-source audit");
  const { count: missingSourceCount, files: missingSourceFiles } =
    await auditMissingSources(domain);
  if (missingSourceCount === 0) {
    console.log("  All source_resolvable points confirmed on disk");
  }

  // Summary
  const status: CircadianReport["status"] =
    missingSourceCount > 0    ? "missing_sources"
    : recalCount > 0 || centroidsRecomputed.length > 0 ? "recalibrated"
    :                            "clean";

  const report: CircadianReport = {
    timestamp,
    domain:              domain ?? null,
    monitorsChecked:     monitors.length,
    monitorsRecal:       recalCount,
    centroidsRecomputed,
    profilesUpdated,
    missingSourceCount,
    missingSourceFiles,
    status,
  };

  // Write report artifact
  const telemetryDir = join(__dirname, "../telemetry");
  mkdirSync(telemetryDir, { recursive: true });
  const artifactPath = join(telemetryDir, `circadian-run-${Date.now()}.json`);
  writeFileSync(artifactPath, JSON.stringify(report, null, 2));
  writeFileSync(join(telemetryDir, "latest-circadian-run.json"), JSON.stringify(report, null, 2));

  console.log(`\n[circadian] Complete — status: ${status}`);
  console.log(`  Monitors checked: ${monitors.length} | recalibrated: ${recalCount}`);
  console.log(`  Centroids recomputed: ${centroidsRecomputed.join(", ") || "none"}`);
  console.log(`  Profiles updated: ${profilesUpdated.join(", ") || "none"}`);
  console.log(`  Missing sources: ${missingSourceCount}`);
  console.log(`  Artifact: ${artifactPath}`);

  return report;
}

// ─────────────────────────────────────────────────────────────────
// CLI ENTRY
// ─────────────────────────────────────────────────────────────────

if (process.argv[1]?.includes("circadian")) {
  const args      = process.argv.slice(2);
  const domainIdx = args.indexOf("--domain");
  const domain    = domainIdx !== -1 && args[domainIdx + 1]
    ? args[domainIdx + 1] as Domain
    : undefined;

  runCircadian(domain).catch(err => {
    console.error("[circadian] Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
