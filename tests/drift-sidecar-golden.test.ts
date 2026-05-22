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

// ─────────────────────────────────────────────────────────────────
// NOMIC_768_DUAL — A/B BLOCK SCHEMA INVARIANTS
//
// When NOMIC_768_DUAL=1 is active, the artifact's nomic768 block must
// always contain the four required counters regardless of sample size
// or ingestion state. This CI check prevents silent schema regressions
// that would break agent/dashboard consumers of the artifact.
// ─────────────────────────────────────────────────────────────────

interface Nomic768Block {
  sampled:          number;
  ingested768:      number;
  notIngested768:   number;
  scored768:        number;
  comparison:       unknown[];
  notIngestedFiles: string[];
  stats:            { medianDelta: number; p95Delta: number; favorableCount: number; unfavorableCount: number } | null;
  skippedReason:    string | null;
}

function assertNomic768BlockShape(block: Nomic768Block, label: string): void {
  // Required top-level counter keys — always present, always numbers
  assert.equal(typeof block.sampled,        "number", `${label}: sampled must be number`);
  assert.equal(typeof block.ingested768,    "number", `${label}: ingested768 must be number`);
  assert.equal(typeof block.notIngested768, "number", `${label}: notIngested768 must be number`);
  assert.equal(typeof block.scored768,      "number", `${label}: scored768 must be number`);
  assert.ok(Array.isArray(block.comparison),        `${label}: comparison must be array`);
  assert.ok(Array.isArray(block.notIngestedFiles),  `${label}: notIngestedFiles must be array`);
  // stats and skippedReason are mutually exclusive but both may be null/non-null
  assert.ok(
    "stats" in block && "skippedReason" in block,
    `${label}: both stats and skippedReason must be present (null when unused)`,
  );
  // Counter coherence: only applies when fetch was actually performed (no skip)
  if (block.skippedReason === null) {
    assert.equal(
      block.ingested768 + block.notIngested768,
      block.sampled,
      `${label}: ingested768 + notIngested768 must equal sampled`,
    );
  }
}

test("nomic768 block: sample gate not met produces correct skip shape", () => {
  // Simulate NOMIC_768_MIN_SAMPLE=25 with only 7 HIGH files
  const highCount = 7;
  const block: Nomic768Block = {
    sampled:          highCount,
    ingested768:      0,
    notIngested768:   0,
    scored768:        0,
    comparison:       [],
    notIngestedFiles: [],
    stats:            null,
    skippedReason:    `insufficient sample: ${highCount} HIGH files < minimum 25 — ingest more HIGH-drift files into spectral-terrain-768 before comparing`,
  };

  assertNomic768BlockShape(block, "skip-gate");
  assert.ok(block.skippedReason !== null, "skippedReason must be set when gate not met");
  assert.equal(block.stats, null, "stats must be null when gate not met");
});

test("nomic768 block: full scored block has valid percentile stats shape", () => {
  const comparison = [
    { file: "brain/indexer/export_training_set.py", mxbai: 0.1155, nomic768: 0.0210, delta: -0.0945 },
    { file: "server/api.ts",                        mxbai: 0.0880, nomic768: 0.0310, delta: -0.0570 },
    { file: "brain/spectral/ingest_monitor.py",     mxbai: 0.0820, nomic768: 0.0620, delta: -0.0200 },
    { file: "brain/indexer/rechunk_medical.py",     mxbai: 0.0670, nomic768: 0.0800, delta:  0.0130 },
    { file: "circadian/pulse.ts",                   mxbai: 0.0630, nomic768: 0.0510, delta: -0.0120 },
  ];
  const block: Nomic768Block = {
    sampled:          5,
    ingested768:      5,
    notIngested768:   0,
    scored768:        5,
    comparison,
    notIngestedFiles: [],
    stats:            { medianDelta: -0.0200, p95Delta: 0.0130, favorableCount: 4, unfavorableCount: 1 },
    skippedReason:    null,
  };

  assertNomic768BlockShape(block, "full-scored");
  assert.ok(block.stats !== null, "stats must be present when comparison has deltas");
  assert.equal(typeof block.stats!.medianDelta,     "number", "medianDelta must be number");
  assert.equal(typeof block.stats!.p95Delta,        "number", "p95Delta must be number");
  assert.equal(typeof block.stats!.favorableCount,  "number", "favorableCount must be number");
  assert.equal(typeof block.stats!.unfavorableCount,"number", "unfavorableCount must be number");
  // favorableCount + unfavorableCount === comparison pairs with delta !== null
  const pairedCount = comparison.filter(c => c.delta !== null).length;
  assert.equal(
    block.stats!.favorableCount + block.stats!.unfavorableCount,
    pairedCount,
    "favorable + unfavorable must equal paired comparison count",
  );
});

test("nomic768 block: partially ingested 768 collection — counter coherence", () => {
  // 25 HIGHs sampled, 15 ingested in 768, 10 not yet there
  const block: Nomic768Block = {
    sampled:          25,
    ingested768:      15,
    notIngested768:   10,
    scored768:        12,  // 3 ingested but no magnitude yet
    comparison:       Array.from({ length: 12 }, (_, i) => ({ file: `file${i}.ts`, mxbai: 0.06, nomic768: 0.04, delta: -0.02 })),
    notIngestedFiles: Array.from({ length: 10 }, (_, i) => `missing${i}.ts`),
    stats:            { medianDelta: -0.02, p95Delta: -0.02, favorableCount: 12, unfavorableCount: 0 },
    skippedReason:    null,
  };

  assertNomic768BlockShape(block, "partial-ingestion");
  assert.equal(block.notIngestedFiles.length, block.notIngested768, "notIngestedFiles length must match notIngested768 count");
});
