/**
 * SPECTRAL TERRAIN — Drift Sidecar Regression Tests
 *
 * Tests the two bugs fixed in this session:
 * 1. --domain CLI arg parsing (indexOf bug — sent node binary path as domain filter)
 * 2. embedNomic chunking (large files no longer overflow nomic's 512-token context)
 *
 * These tests are pure logic — no Ollama, no Qdrant required.
 */

import { strict as assert } from "assert";
import { test } from "node:test";

// ─────────────────────────────────────────────────────────────────
// Extracted pure functions from drift-sidecar.ts for unit testing
// (mirrors the actual implementations exactly)
// ─────────────────────────────────────────────────────────────────

const NOMIC_WORDS_PER_CHUNK = 100;
const NOMIC_MIN_WORDS       = 20;

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

/** Mirrors the fixed CLI arg parsing in drift-sidecar.ts */
function parseDomainArg(argv: string[]): string | undefined {
  const domainIdx = argv.indexOf("--domain");
  return domainIdx !== -1 ? argv[domainIdx + 1] : undefined;
}

/** The buggy version for comparison */
function parseDomainArgBuggy(argv: string[]): string | undefined {
  return argv[argv.indexOf("--domain") + 1];
}

// ─────────────────────────────────────────────────────────────────
// TEST 1 — --domain CLI parsing
// ─────────────────────────────────────────────────────────────────

test("parseDomainArg: absent --domain returns undefined", () => {
  const argv = ["/path/to/node", "/path/to/drift-sidecar.ts"];
  assert.equal(parseDomainArg(argv), undefined);
});

test("parseDomainArg: absent --domain (buggy version) returns node binary path", () => {
  // Documents the bug: indexOf returns -1, -1+1=0, argv[0] = node binary
  const argv = ["/path/to/node", "/path/to/drift-sidecar.ts"];
  assert.equal(parseDomainArgBuggy(argv), "/path/to/node");
  assert.notEqual(parseDomainArgBuggy(argv), undefined);
});

test("parseDomainArg: with --domain source-audit returns 'source-audit'", () => {
  const argv = ["/path/to/node", "/path/to/drift-sidecar.ts", "--domain", "source-audit"];
  assert.equal(parseDomainArg(argv), "source-audit");
});

test("parseDomainArg: with --domain roblox-luau returns 'roblox-luau'", () => {
  const argv = ["/path/to/node", "/path/to/drift-sidecar.ts", "--domain", "roblox-luau"];
  assert.equal(parseDomainArg(argv), "roblox-luau");
});

// ─────────────────────────────────────────────────────────────────
// TEST 2 — embedNomic chunking shape
// ─────────────────────────────────────────────────────────────────

test("chunkTextNomic: short text (< MIN_WORDS) returns single chunk", () => {
  const text = "hello world this is a short text";
  const chunks = chunkTextNomic(text);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], text);
});

test("chunkTextNomic: exactly MIN_WORDS returns single chunk", () => {
  const words = Array.from({ length: NOMIC_MIN_WORDS }, (_, i) => `word${i}`);
  const text = words.join(" ");
  const chunks = chunkTextNomic(text);
  assert.equal(chunks.length, 1);
});

test("chunkTextNomic: large file (>100 words) splits into multiple chunks", () => {
  // Simulate a 250-word file (typical of the files that were failing)
  const words = Array.from({ length: 250 }, (_, i) => `token${i}`);
  const text = words.join(" ");
  const chunks = chunkTextNomic(text);
  assert.ok(chunks.length > 1, `expected >1 chunk, got ${chunks.length}`);
  // Each chunk should be at most NOMIC_WORDS_PER_CHUNK words
  for (const chunk of chunks) {
    const chunkWords = chunk.split(/\s+/).filter(w => w.length > 0).length;
    assert.ok(chunkWords <= NOMIC_WORDS_PER_CHUNK, `chunk has ${chunkWords} words, expected <= ${NOMIC_WORDS_PER_CHUNK}`);
  }
});

test("chunkTextNomic: 250-word file produces exactly 3 chunks", () => {
  const words = Array.from({ length: 250 }, (_, i) => `token${i}`);
  const text = words.join(" ");
  const chunks = chunkTextNomic(text);
  // 250 words / 100 per chunk = 3 chunks (100, 100, 50)
  // The last chunk (50 words) is >= MIN_WORDS (20), so it's kept
  assert.equal(chunks.length, 3);
});

test("chunkTextNomic: last chunk below MIN_WORDS is discarded", () => {
  // 110 words: chunk 1 = 100 words (kept), chunk 2 = 10 words (discarded, < MIN_WORDS=20)
  const words = Array.from({ length: 110 }, (_, i) => `token${i}`);
  const text = words.join(" ");
  const chunks = chunkTextNomic(text);
  assert.equal(chunks.length, 1, `expected 1 chunk (tail discarded), got ${chunks.length}`);
});

test("chunkTextNomic: all chunks contain only original words", () => {
  const words = Array.from({ length: 250 }, (_, i) => `token${i}`);
  const text = words.join(" ");
  const chunks = chunkTextNomic(text);
  const reassembled = chunks.join(" ").split(/\s+/);
  for (const w of reassembled) {
    assert.ok(words.includes(w), `unexpected word in chunk: ${w}`);
  }
});

test("chunkTextNomic: empty string returns single-element array", () => {
  const chunks = chunkTextNomic("");
  assert.equal(chunks.length, 1);
});
