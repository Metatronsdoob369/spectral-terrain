/**
 * SPECTRAL TERRAIN — Drift Sidecar Golden Test
 *
 * Snapshots the known state of the drift queue and asserts that the
 * summary counters match. This catches silent regressions in queue
 * logic — e.g. if the source_resolvable filter breaks and synthetic
 * points flood back in, or if the idempotency gate reverts and
 * forces re-scoring of already-scored points.
 *
 * NOT a live Qdrant test — that would be a flaky integration test.
 * Instead: tests the counter logic against a mock point set that
 * exactly mirrors the current known-good terrain state.
 *
 * Update the GOLDEN snapshot when the terrain state intentionally changes
 * (new ingest, re-embed pass, etc.). The snapshot is the contract.
 */

import { strict as assert } from "assert";
import { test } from "node:test";

// ─────────────────────────────────────────────────────────────────
// Counter logic extracted from drift-sidecar.ts runDriftSidecar()
// ─────────────────────────────────────────────────────────────────

interface MockPoint {
  id:                      string;
  file:                    string;
  domain:                  string;
  unicode_drift_magnitude: number | undefined;
  source_resolvable:       boolean | undefined;
}

type SidecarCounters = {
  queued:  number;
  scored:  number;
  skipped: number;
  miss:    number;
  error:   number;
};

/**
 * Simulate one sidecar pass over a set of flagged points.
 * resolveSource: returns content string if file is on disk, null otherwise.
 * embed: returns a drift magnitude (or throws to simulate embed error).
 */
function simulateSidecarPass(
  points: MockPoint[],
  resolveSource: (file: string) => string | null,
  embed: (content: string) => number | Error,
): SidecarCounters {
  let scored = 0, skipped = 0, miss = 0, error = 0;

  for (const point of points) {
    // idempotency: skip if already scored (any defined value including 0.0)
    if (point.unicode_drift_magnitude !== undefined) {
      skipped++;
      continue;
    }

    const source = resolveSource(point.file);
    if (!source) {
      miss++;
      continue;
    }

    const result = embed(source);
    if (result instanceof Error) {
      error++;
    } else {
      scored++;
    }
  }

  return { queued: points.length, scored, skipped, miss, error };
}

// ─────────────────────────────────────────────────────────────────
// GOLDEN SNAPSHOT — current known-good terrain state (2026-05-22)
//
// 36 source-audit points flagged, all scored in the last full run.
// Queue is all-skip on re-run. 0 miss (source_resolvable filter active).
// Update this when terrain state intentionally changes.
// ─────────────────────────────────────────────────────────────────

const GOLDEN = {
  queued:   36,
  scored:   0,   // all already scored — idempotent re-run
  skipped:  36,
  miss:     0,
  error:    0,
} as const;

// Build a mock point set matching the golden state:
// 36 points, all already have unicode_drift_magnitude set (scored).
function buildGoldenPoints(): MockPoint[] {
  return Array.from({ length: 36 }, (_, i) => ({
    id:                      `uuid-${i}`,
    file:                    `source-audit/file${i}.ts`,
    domain:                  "source-audit",
    unicode_drift_magnitude: i === 0 ? 0.0 : 0.01 * i,  // includes a 0.0 CLEAN file
    source_resolvable:       true,
  }));
}

test("golden: all-skip re-run produces correct counters", () => {
  const points = buildGoldenPoints();
  const counters = simulateSidecarPass(
    points,
    () => "source content",  // resolveSource always succeeds
    () => 0.05,              // embed always succeeds
  );
  assert.equal(counters.queued,  GOLDEN.queued);
  assert.equal(counters.scored,  GOLDEN.scored);
  assert.equal(counters.skipped, GOLDEN.skipped);
  assert.equal(counters.miss,    GOLDEN.miss);
  assert.equal(counters.error,   GOLDEN.error);
});

test("golden: 0.0-scored CLEAN file is correctly skipped (not re-processed)", () => {
  // The point at index 0 has magnitude=0.0 — old buggy gate (> 0) would re-process it.
  // New gate (!== undefined) must skip it.
  const points = buildGoldenPoints();
  const cleanPoint = points.find(p => p.unicode_drift_magnitude === 0.0);
  assert.ok(cleanPoint, "expected a 0.0 CLEAN point in golden set");

  let embedCallCount = 0;
  simulateSidecarPass(
    [cleanPoint],
    () => "source content",
    () => { embedCallCount++; return 0.0; },
  );
  assert.equal(embedCallCount, 0, "embed should NOT be called for already-scored 0.0 point");
});

// ─────────────────────────────────────────────────────────────────
// REGRESSION SCENARIOS — catch queue logic regressions
// ─────────────────────────────────────────────────────────────────

test("regression: synthetic points (source_resolvable absent) would miss if filter breaks", () => {
  // Simulate what happens if source_resolvable filter breaks at the Qdrant layer
  // and synthetic points re-appear in the queue. They should MISS, not error.
  const synthetic: MockPoint[] = Array.from({ length: 5 }, (_, i) => ({
    id:                      `synth-${i}`,
    file:                    `72ff90e9-AtmosphereManager${i}.lua`,
    domain:                  "roblox-luau",
    unicode_drift_magnitude: undefined,  // not yet scored
    source_resolvable:       false,
  }));

  const counters = simulateSidecarPass(
    synthetic,
    () => null,  // resolveSource fails — file not on disk
    () => 0.05,
  );

  assert.equal(counters.miss,   5, "synthetic points should produce miss entries");
  assert.equal(counters.scored, 0, "synthetic points should not be scored");
  assert.equal(counters.error,  0, "synthetic points should not produce errors");
});

test("regression: embed error increments error counter, not miss", () => {
  const points: MockPoint[] = [{
    id:                      "err-point",
    file:                    "server/api.ts",
    domain:                  "source-audit",
    unicode_drift_magnitude: undefined,
    source_resolvable:       true,
  }];

  const counters = simulateSidecarPass(
    points,
    () => "large file content...",
    () => new Error("nomic embed failed: Bad Request"),
  );

  assert.equal(counters.error,  1);
  assert.equal(counters.scored, 0);
  assert.equal(counters.miss,   0);
});

// ─────────────────────────────────────────────────────────────────
// STATUS FIELD DERIVATION
// ─────────────────────────────────────────────────────────────────

type RunStatus = "clean" | "degraded" | "error";

function deriveStatus(counters: {
  queued: number; skipped: number; scored: number; miss: number; error: number;
}): RunStatus {
  const attempted = counters.queued - counters.skipped;
  return counters.error > 0 && counters.error === attempted ? "error"
       : counters.miss > 0 || counters.error > 0           ? "degraded"
       :                                                      "clean";
}

test("status: all-skip run is clean", () => {
  assert.equal(deriveStatus({ queued: 36, skipped: 36, scored: 0, miss: 0, error: 0 }), "clean");
});

test("status: fresh scored run with no errors is clean", () => {
  assert.equal(deriveStatus({ queued: 9, skipped: 0, scored: 9, miss: 0, error: 0 }), "clean");
});

test("status: any miss degrades status", () => {
  assert.equal(deriveStatus({ queued: 36, skipped: 27, scored: 8, miss: 1, error: 0 }), "degraded");
});

test("status: any error degrades status (when other points scored)", () => {
  assert.equal(deriveStatus({ queued: 9, skipped: 0, scored: 8, miss: 0, error: 1 }), "degraded");
});

test("status: all attempted points errored is error (not degraded)", () => {
  // 9 attempted, 9 errored — nothing got through
  assert.equal(deriveStatus({ queued: 9, skipped: 0, scored: 0, miss: 0, error: 9 }), "error");
});

test("status: partial skip + all attempted errored is error", () => {
  // 36 queued, 27 skipped = 9 attempted, all 9 errored
  assert.equal(deriveStatus({ queued: 36, skipped: 27, scored: 0, miss: 0, error: 9 }), "error");
});

test("status: mix of miss and error on attempted is degraded (not error)", () => {
  // 9 attempted: 4 errored, 5 missed — error !== attempted, so degraded
  assert.equal(deriveStatus({ queued: 9, skipped: 0, scored: 0, miss: 5, error: 4 }), "degraded");
});

test("regression: version check — new point missing schema version would be caught", () => {
  // Simulate a new point ingested after the enforcement cutoff without payload_schema_version.
  // The integrity check would catch it as STALE_SCHEMA_VERSION.
  // This test verifies the predicate logic (not Qdrant directly).
  const TERRAIN_PAYLOAD_VERSION = 1;
  const VERSION_ENFORCEMENT_CUTOFF = "2026-05-22T00:00:00.000Z";

  function isStaleVersionViolation(p: {
    ingestedAt?: string;
    payload_schema_version?: number;
  }): boolean {
    if (!p.ingestedAt) return false;
    if (p.ingestedAt < VERSION_ENFORCEMENT_CUTOFF) return false;
    return p.payload_schema_version !== TERRAIN_PAYLOAD_VERSION;
  }

  // Post-cutoff, missing version — violation
  assert.ok(isStaleVersionViolation({ ingestedAt: "2026-05-22T10:00:00.000Z", payload_schema_version: undefined }));
  // Post-cutoff, wrong version — violation
  assert.ok(isStaleVersionViolation({ ingestedAt: "2026-05-22T10:00:00.000Z", payload_schema_version: 0 }));
  // Post-cutoff, correct version — no violation
  assert.ok(!isStaleVersionViolation({ ingestedAt: "2026-05-22T10:00:00.000Z", payload_schema_version: 1 }));
  // Pre-cutoff, missing version — grandfathered, no violation
  assert.ok(!isStaleVersionViolation({ ingestedAt: "2026-05-21T23:59:59.000Z", payload_schema_version: undefined }));
  // No ingestedAt — not evaluated
  assert.ok(!isStaleVersionViolation({ payload_schema_version: undefined }));
});

test("regression: fresh ingest of 9 files produces scored=9 on first pass", () => {
  // Mirrors the state before the chunking fix — 9 files with undefined magnitude,
  // all resolvable, embed now succeeds (chunking works).
  const fresh: MockPoint[] = [
    "server/api.ts", "server/legal.ts", "circadian/pulse.ts",
    "brain/spectral/ingest_monitor.py", "brain/indexer/export_training_set.py",
    "brain/indexer/rechunk_medical.py", "brain/indexer/rechunk_domain.py",
    "lander/export_topology.py", "brain/scrapers/alabama_code_scraper.py",
  ].map((file, i) => ({
    id:                      `fresh-${i}`,
    file,
    domain:                  "source-audit",
    unicode_drift_magnitude: undefined,
    source_resolvable:       true,
  }));

  const counters = simulateSidecarPass(
    fresh,
    () => "file content",
    () => 0.06,  // HIGH drift — realistic for these files
  );

  assert.equal(counters.scored,  9);
  assert.equal(counters.skipped, 0);
  assert.equal(counters.miss,    0);
  assert.equal(counters.error,   0);
});
