/**
 * SPECTRAL TERRAIN — INTEGRITY CHECK
 *
 * Validates invariants that must hold across all terrain points.
 * Run as part of CI or after any ingest/migration.
 *
 * Exit 0 = clean. Exit 1 = violations found (CI fails).
 *
 * Usage:
 *   npx tsx engine/terrain-integrity.ts
 *   npx tsx engine/terrain-integrity.ts --strict   ← same, explicit
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import { TERRAIN_PAYLOAD_VERSION } from "../contracts/terrain.contract.js";

const QDRANT_URL         = "http://127.0.0.1:6340";
const HEATMAP_COLLECTION = "spectral-heatmap";

// Points ingested at or after this timestamp must carry payload_schema_version === TERRAIN_PAYLOAD_VERSION.
// Points before this date are grandfathered (they existed before versioning and have been backfilled).
// Update when the version increments: set to the ISO date of the migration.
const VERSION_ENFORCEMENT_CUTOFF = "2026-05-22T00:00:00.000Z";

interface PointSummary {
  id:                     string;
  file:                   string;
  domain:                 string;
  ingestedAt:             string  | undefined;
  unicode_drift_risk:     boolean | undefined;
  source_resolvable:      boolean | undefined;
  payload_schema_version: number  | undefined;
}

async function fetchAllPoints(): Promise<PointSummary[]> {
  const points: PointSummary[] = [];
  let offset: string | null = null;

  while (true) {
    const body: any = { limit: 250, with_vector: false, with_payload: true };
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
        id:                     p.id,
        file:                   p.payload.file ?? "(unknown)",
        domain:                 p.payload.domain ?? "(unknown)",
        ingestedAt:             p.payload.ingestedAt,
        unicode_drift_risk:     p.payload.unicode_drift_risk,
        source_resolvable:      p.payload.source_resolvable,
        payload_schema_version: p.payload.payload_schema_version,
      });
    }

    if (!data.result.next_page_offset) break;
    offset = data.result.next_page_offset;
  }

  return points;
}

async function runIntegrityCheck(): Promise<void> {
  console.log("[terrain-integrity] Scanning all points...\n");

  const all = await fetchAllPoints();
  console.log(`  Total points: ${all.length}`);

  const violations: { rule: string; file: string; domain: string; id: string }[] = [];

  // ── RULE 1 ──────────────────────────────────────────────────────────────────
  // unicode_drift_risk=true MUST NOT coexist with source_resolvable != true.
  // A flagged point with no resolvable source can never be scored by the sidecar —
  // it is permanent noise in the drift queue. This indicates a synthetic ingest
  // path that did not gate on source_resolvable before setting unicode_drift_risk.
  const rule1Violations = all.filter(
    p => p.unicode_drift_risk === true && p.source_resolvable !== true
  );
  for (const p of rule1Violations) {
    violations.push({
      rule:   "DRIFT_RISK_WITHOUT_SOURCE",
      file:   p.file,
      domain: p.domain,
      id:     p.id,
    });
  }

  // ── RULE 2 ──────────────────────────────────────────────────────────────────
  // All points should carry payload_schema_version.
  // Absent = v0 (pre-versioning) — not a hard failure, but surfaced as a warning
  // so migration scripts can target them.
  const unversionedCount = all.filter(p => p.payload_schema_version === undefined).length;

  // ── RULE 3 ──────────────────────────────────────────────────────────────────
  // Points ingested at or after VERSION_ENFORCEMENT_CUTOFF must carry
  // payload_schema_version === TERRAIN_PAYLOAD_VERSION.
  //
  // This gates new ingests: if ingest.ts fails to write the current version,
  // integrity check catches it immediately. Grandfathers all pre-cutoff points.
  const staleVersionViolations = all.filter(p => {
    if (!p.ingestedAt) return false;
    if (p.ingestedAt < VERSION_ENFORCEMENT_CUTOFF) return false;  // grandfathered
    return p.payload_schema_version !== TERRAIN_PAYLOAD_VERSION;
  });
  for (const p of staleVersionViolations) {
    violations.push({
      rule:   "STALE_SCHEMA_VERSION",
      file:   p.file,
      domain: p.domain,
      id:     p.id,
    });
  }

  // ── OUTPUT ──────────────────────────────────────────────────────────────────

  if (rule1Violations.length > 0) {
    console.error(`\n[FAIL] DRIFT_RISK_WITHOUT_SOURCE — ${rule1Violations.length} violation(s):`);
    for (const v of rule1Violations) {
      console.error(`  ${v.file} (${v.domain}) — id: ${v.id}`);
    }
    console.error(`\n  Fix: set unicode_drift_risk=false OR source_resolvable=true on these points.`);
    console.error(`  Cause: synthetic ingest path set unicode_drift_risk without checking source availability.\n`);
  } else {
    console.log(`  [PASS] DRIFT_RISK_WITHOUT_SOURCE — 0 violations`);
  }

  if (unversionedCount > 0) {
    console.warn(`  [WARN] ${unversionedCount} point(s) missing payload_schema_version (v0 — pre-versioning).`);
    console.warn(`         Run backfill to set payload_schema_version=${TERRAIN_PAYLOAD_VERSION} on these points.`);
  } else {
    console.log(`  [PASS] payload_schema_version — all points versioned at v${TERRAIN_PAYLOAD_VERSION}`);
  }

  if (staleVersionViolations.length > 0) {
    console.error(`\n[FAIL] STALE_SCHEMA_VERSION — ${staleVersionViolations.length} newly-ingested point(s) carry wrong schema version:`);
    for (const v of staleVersionViolations) {
      console.error(`  ${v.file} (${v.domain}) — id: ${v.id}`);
    }
    console.error(`\n  Fix: ensure ingest.ts writes payload_schema_version = TERRAIN_PAYLOAD_VERSION (currently ${TERRAIN_PAYLOAD_VERSION}).`);
    console.error(`  Cause: ingest.ts is out of sync with contracts/terrain.contract.ts.\n`);
  } else {
    console.log(`  [PASS] STALE_SCHEMA_VERSION — all post-cutoff points at current schema v${TERRAIN_PAYLOAD_VERSION}`);
  }

  const versionBreakdown: Record<string, number> = {};
  for (const p of all) {
    const v = String(p.payload_schema_version ?? "v0-absent");
    versionBreakdown[v] = (versionBreakdown[v] ?? 0) + 1;
  }
  console.log(`\n  Schema version breakdown:`);
  for (const [v, count] of Object.entries(versionBreakdown).sort()) {
    console.log(`    v${v}: ${count} point(s)`);
  }

  if (violations.length > 0) {
    console.error(`\n[terrain-integrity] FAILED — ${violations.length} violation(s). Fix before proceeding.\n`);
    process.exit(1);
  }

  console.log(`\n[terrain-integrity] PASSED — terrain invariants hold.\n`);
}

runIntegrityCheck().catch(err => {
  console.error(`[terrain-integrity] Fatal: ${err.message}`);
  process.exit(1);
});
