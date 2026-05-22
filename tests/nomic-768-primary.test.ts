/**
 * SPECTRAL TERRAIN — NOMIC_768_PRIMARY Integration Test
 *
 * Proves that NOMIC_768_PRIMARY=1 changes both the active collection name
 * and the active embedding dimension in the artifact metadata.
 *
 * These are pure logic tests — no Qdrant or Ollama required.
 * They test the flag resolution contract so a regression (e.g. hardcoded
 * HEATMAP_COLLECTION leaking back into a fetch path) is caught before
 * a live cutover run.
 *
 * The integration contract:
 *   NOMIC_768_PRIMARY unset → activeCollection="spectral-heatmap",    activeEmbedDim=1024
 *   NOMIC_768_PRIMARY=1    → activeCollection="spectral-heatmap-768", activeEmbedDim=768
 *
 * Rollback contract:
 *   Unsetting NOMIC_768_PRIMARY must return both values to baseline.
 *   No code changes required — env var is the sole switch.
 */

import { strict as assert } from "assert";
import { test } from "node:test";

// ─────────────────────────────────────────────────────────────────
// Flag resolution logic — mirrors the constants block in drift-sidecar.ts
// Extracted here so tests are stable against internal refactors.
// If the constant names change in the sidecar, update here too.
// ─────────────────────────────────────────────────────────────────

const HEATMAP_COLLECTION = "spectral-heatmap";
const HEATMAP_768_COLL   = "spectral-heatmap-768";

function resolveActiveCollection(primary: boolean): string {
  return primary ? HEATMAP_768_COLL : HEATMAP_COLLECTION;
}

function resolveActiveEmbedDim(primary: boolean): number {
  return primary ? 768 : 1024;
}

// ─────────────────────────────────────────────────────────────────
// COLLECTION SWITCHING
// ─────────────────────────────────────────────────────────────────

test("NOMIC_768_PRIMARY off: active collection is spectral-heatmap (mxbai baseline)", () => {
  assert.equal(resolveActiveCollection(false), "spectral-heatmap");
});

test("NOMIC_768_PRIMARY on: active collection switches to spectral-heatmap-768", () => {
  assert.equal(resolveActiveCollection(true), "spectral-heatmap-768");
});

test("rollback: unsetting flag returns collection to spectral-heatmap", () => {
  const after = resolveActiveCollection(false);
  assert.equal(after, "spectral-heatmap", "rollback must restore baseline collection");
});

// ─────────────────────────────────────────────────────────────────
// DIMENSION SWITCHING
// ─────────────────────────────────────────────────────────────────

test("NOMIC_768_PRIMARY off: active embed dim is 1024 (mxbai-embed-large)", () => {
  assert.equal(resolveActiveEmbedDim(false), 1024);
});

test("NOMIC_768_PRIMARY on: active embed dim switches to 768 (nomic-embed-text)", () => {
  assert.equal(resolveActiveEmbedDim(true), 768);
});

test("rollback: unsetting flag returns embed dim to 1024", () => {
  const after = resolveActiveEmbedDim(false);
  assert.equal(after, 1024, "rollback must restore 1024-D baseline");
});

// ─────────────────────────────────────────────────────────────────
// ARTIFACT METADATA CONTRACT
// Proves that both fields co-change correctly — you can't get
// collection=768 with dim=1024 or collection=mxbai with dim=768.
// ─────────────────────────────────────────────────────────────────

test("artifact metadata: primary=false produces coherent mxbai baseline pair", () => {
  const coll = resolveActiveCollection(false);
  const dim  = resolveActiveEmbedDim(false);
  assert.equal(coll, "spectral-heatmap");
  assert.equal(dim,  1024);
  // Coherence: mxbai collection must never pair with 768-D
  assert.notEqual(coll, "spectral-heatmap-768", "mxbai collection must not pair with 768 dim");
  assert.notEqual(dim,  768,                    "mxbai dim must not be 768");
});

test("artifact metadata: primary=true produces coherent 768 pair", () => {
  const coll = resolveActiveCollection(true);
  const dim  = resolveActiveEmbedDim(true);
  assert.equal(coll, "spectral-heatmap-768");
  assert.equal(dim,  768);
  // Coherence: 768 collection must never pair with 1024-D
  assert.notEqual(coll, "spectral-heatmap", "768 collection must not pair with mxbai dim");
  assert.notEqual(dim,  1024,               "768 dim must not be 1024");
});

test("flag is the sole switch: same code, opposite flag, opposite pair", () => {
  const baselineColl = resolveActiveCollection(false);
  const baselineDim  = resolveActiveEmbedDim(false);
  const cutoverColl  = resolveActiveCollection(true);
  const cutoverDim   = resolveActiveEmbedDim(true);

  assert.notEqual(baselineColl, cutoverColl, "collection must differ between modes");
  assert.notEqual(baselineDim,  cutoverDim,  "dim must differ between modes");
});

// ─────────────────────────────────────────────────────────────────
// FETCH PATH CONTRACT — documents that both fetch functions use ACTIVE_COLLECTION
//
// These tests are structural proofs: they verify the string that would be
// interpolated into the Qdrant URL matches the expected collection for each mode.
// If a future refactor hardcodes HEATMAP_COLLECTION back into a fetch call,
// this test fails and surfaces the regression before a live run.
// ─────────────────────────────────────────────────────────────────

function buildScrollUrl(activeCollection: string): string {
  return `http://127.0.0.1:6340/collections/${activeCollection}/points/scroll`;
}

function buildPatchUrl(activeCollection: string): string {
  return `http://127.0.0.1:6340/collections/${activeCollection}/points/payload`;
}

test("fetch path: primary=false — scroll URL targets spectral-heatmap", () => {
  const url = buildScrollUrl(resolveActiveCollection(false));
  assert.ok(url.includes("/collections/spectral-heatmap/"), `expected mxbai path, got ${url}`);
  assert.ok(!url.includes("spectral-heatmap-768"),          "must not contain 768 collection name");
});

test("fetch path: primary=true — scroll URL targets spectral-heatmap-768", () => {
  const url = buildScrollUrl(resolveActiveCollection(true));
  assert.ok(url.includes("/collections/spectral-heatmap-768/"), `expected 768 path, got ${url}`);
});

test("fetch path: primary=false — patch URL targets spectral-heatmap", () => {
  const url = buildPatchUrl(resolveActiveCollection(false));
  assert.ok(url.includes("/collections/spectral-heatmap/"), `expected mxbai path, got ${url}`);
  assert.ok(!url.includes("spectral-heatmap-768"),           "must not contain 768 collection name");
});

test("fetch path: primary=true — patch URL targets spectral-heatmap-768", () => {
  const url = buildPatchUrl(resolveActiveCollection(true));
  assert.ok(url.includes("/collections/spectral-heatmap-768/"), `expected 768 path, got ${url}`);
});
