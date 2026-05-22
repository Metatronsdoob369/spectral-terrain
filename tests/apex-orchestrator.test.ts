/**
 * SPECTRAL TERRAIN — Apex Orchestrator Tests
 *
 * Five test groups, one per sealed fix:
 *
 *   Fix 1 — Gate machine: all four states reachable, PROBE_LOCK fires,
 *            probe success returns to OK after PROBE_CLEAR_THRESHOLD cleans.
 *
 *   Fix 2 — Calibration: injected store, stale returns CALIBRATION_STALE,
 *            null returns CALIBRATION_MISSING, within-threshold → SUCCESS.
 *
 *   Fix 3 — SimHash-128: deterministic on same input, differs on different
 *            input, different halves (A ≠ B), stable regardless of token count.
 *
 *   Fix 4 — Semaphore queue: no bypass possible, FIFO ordering is strict,
 *            QUEUE_OVERFLOW fires when maxQueueDepth is reached.
 *
 *   Fix 5 — Queue wait timeout: expired slots return QUEUE_TIMEOUT, not hang.
 *            Non-expired slots complete normally when capacity frees.
 *
 * All tests are pure logic — no Qdrant, no Ollama, no network.
 */

import { strict as assert } from "assert";
import { test }              from "node:test";
import {
  ApexOrchestrator,
  FallbackReason,
  type ApexOrchestratorConfig,
  type CalibrationStore,
  type CalibrationRecord,
  type LFUCache,
  type SemanticCompressor,
} from "../engine/apex-orchestrator.js";

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ApexOrchestratorConfig = {
  engineVersion:       "1.0.0",
  schemaVersion:       "v1.0.0",
  domain:              "source-audit",
  collectionId:        "spectral-heatmap",
  embedModel:          "mxbai-embed-large",
  tokenizer:           "whitespace",
  endpointFingerprint: "fp-test-abc123",
  maxInFlight:         2,
  maxQueueDepth:       10,
  queueWaitTimeoutMs:  200,
  calibrationMaxAgeMs: 3_600_000,
};

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function makeCalStore(record: CalibrationRecord | null): CalibrationStore {
  return { fetch: async () => record };
}

const CLEAN_CAL: CalibrationRecord = {
  timestamp:       Date.now(),
  canonicalSig128: 0n,       // 0-sig accepts everything (Hamming = bits set in sig128)
  threshold:       1.0,      // 100% threshold — always stable in tests
};

const NULL_STORE:  CalibrationStore  = makeCalStore(null);
const CLEAN_STORE: CalibrationStore  = makeCalStore(CLEAN_CAL);

const NULL_CACHE: LFUCache = {
  get: async () => null,
  set: async () => {},
};

const PASS_COMPRESSOR: SemanticCompressor = {
  compress: async () => [new Float32Array([1, 2, 3])],
};

function makeOrchestrator(overrides: Partial<ApexOrchestratorConfig> = {}): ApexOrchestrator {
  return new ApexOrchestrator(
    { ...DEFAULT_CONFIG, ...overrides },
    CLEAN_STORE,
    NULL_CACHE,
    PASS_COMPRESSOR,
  );
}

// ─────────────────────────────────────────────────────────────────
// FIX 1 — GATE MACHINE
// ─────────────────────────────────────────────────────────────────

test("gate: starts in OK", () => {
  const o = makeOrchestrator();
  assert.equal(o.state.gateState, "OK");
});

test("gate: first breach → WATCH", () => {
  const o = makeOrchestrator();
  o.updateGate(200, null);  // breach SLO (>100ms)
  assert.equal(o.state.gateState, "WATCH");
  assert.equal(o.state.strikes,   1);
});

test("gate: second breach → HOLD", () => {
  const o = makeOrchestrator();
  o.updateGate(200, null);
  o.updateGate(200, null);
  assert.equal(o.state.gateState, "HOLD");
});

test("gate: HOLD → PROBING on third breach, tau tightens, dtheta halves", () => {
  const o = makeOrchestrator();
  o.updateGate(200, null);  // → WATCH
  o.updateGate(200, null);  // → HOLD
  const tauBefore    = o.state.tau;
  const dthetaBefore = o.state.dtheta;
  o.updateGate(200, null);  // → PROBING
  assert.equal(o.state.gateState, "PROBING");
  assert.ok(o.state.tau > tauBefore,       "tau must tighten on PROBING entry");
  assert.ok(o.state.dtheta < dthetaBefore, "dtheta must halve on PROBING entry");
  assert.equal(o.state.strikes, 0,         "strikes reset to 0 on PROBING entry");
});

test("gate: PROBING + probe already in flight → PROBE_LOCK fallback", async () => {
  // Blocking compressor keeps the first request in-flight so probeInFlight stays true.
  let releaseProbe!: () => void;
  const blockingCompressor: SemanticCompressor = {
    compress: () => new Promise(r => { releaseProbe = () => r([]); }),
  };
  const o = new ApexOrchestrator(
    { ...DEFAULT_CONFIG, maxInFlight: 1, maxQueueDepth: 5, queueWaitTimeoutMs: 5000 },
    CLEAN_STORE, NULL_CACHE, blockingCompressor,
  );

  // Drive gate to PROBING
  o.updateGate(200, null);
  o.updateGate(200, null);
  o.updateGate(200, null);
  assert.equal(o.state.gateState, "PROBING");

  // First request acquires probe lock and enters the (blocking) compressor
  const first = o.execute(enc("probe payload"));
  // Yield to let first acquire probeInFlight=true before second checks
  await new Promise(r => setTimeout(r, 5));

  // Second request while probeInFlight=true → PROBE_LOCK (checked before semaphore)
  const second = await o.execute(enc("blocked payload"));
  assert.equal(second.status, "FALLBACK");
  assert.equal(second.reason, FallbackReason.PROBE_LOCK);

  releaseProbe();
  await first;
});

test("gate: PROBING clears to OK after PROBE_CLEAR_THRESHOLD clean observations", () => {
  const o = makeOrchestrator();
  // Drive to PROBING
  o.updateGate(200, null);
  o.updateGate(200, null);
  o.updateGate(200, null);
  assert.equal(o.state.gateState, "PROBING");

  // Feed PROBE_CLEAR_THRESHOLD=3 clean observations
  o.updateGate(10, 1.0);  // clean
  assert.equal(o.state.gateState, "PROBING", "still PROBING after 1 clean");
  o.updateGate(10, 1.0);  // clean
  assert.equal(o.state.gateState, "PROBING", "still PROBING after 2 cleans");
  o.updateGate(10, 1.0);  // clean — threshold reached
  assert.equal(o.state.gateState, "OK", "PROBING must clear to OK after 3 consecutive cleans");
  assert.equal(o.state.strikes,   0);
});

test("gate: clean observations decay strikes, WATCH→OK when strikes=0", () => {
  const o = makeOrchestrator();
  o.updateGate(200, null);  // → WATCH, strikes=1
  o.updateGate(10, 1.0);    // clean → strikes=0 → OK
  assert.equal(o.state.gateState, "OK");
  assert.equal(o.state.strikes,   0);
});

test("gate: gap below floor counts as breach", () => {
  const o = makeOrchestrator();
  o.updateGate(10, 0.0001);  // gap < GAP_FLOOR, TTFT fine
  assert.equal(o.state.gateState, "WATCH");
});

// ─────────────────────────────────────────────────────────────────
// FIX 2 — CALIBRATION (injected store)
// ─────────────────────────────────────────────────────────────────

test("calibration: null store → CALIBRATION_MISSING", async () => {
  const o = new ApexOrchestrator(DEFAULT_CONFIG, NULL_STORE, NULL_CACHE, PASS_COMPRESSOR);
  const r = await o.execute(enc("test payload"));
  assert.equal(r.status, "FALLBACK");
  assert.equal(r.reason, FallbackReason.CALIBRATION_MISSING);
});

test("calibration: stale record → CALIBRATION_STALE", async () => {
  const staleStore = makeCalStore({
    timestamp:       Date.now() - 4_000_000,  // older than 1h
    canonicalSig128: 0n,
    threshold:       1.0,
  });
  const o = new ApexOrchestrator(DEFAULT_CONFIG, staleStore, NULL_CACHE, PASS_COMPRESSOR);
  const r = await o.execute(enc("test payload"));
  assert.equal(r.status, "FALLBACK");
  assert.equal(r.reason, FallbackReason.CALIBRATION_STALE);
});

test("calibration: sig within threshold → SUCCESS", async () => {
  // canonicalSig128=0n means XOR with any sig = sig itself.
  // threshold=1.0 means any Hamming ratio passes.
  const o = new ApexOrchestrator(DEFAULT_CONFIG, CLEAN_STORE, NULL_CACHE, PASS_COMPRESSOR);
  const r = await o.execute(enc("test payload"));
  assert.equal(r.status, "SUCCESS");
});

test("calibration: sig outside threshold → DRIFT_REJECT", async () => {
  // Set threshold=0.0 — any nonzero Hamming distance fails.
  // The payload "test payload" will produce a nonzero SimHash → nonzero XOR with 0n.
  const tightStore = makeCalStore({
    timestamp:       Date.now(),
    canonicalSig128: 0n,
    threshold:       0.0,   // must be exact match
  });
  const o = new ApexOrchestrator(DEFAULT_CONFIG, tightStore, NULL_CACHE, PASS_COMPRESSOR);
  const r = await o.execute(enc("test payload"));
  assert.equal(r.status, "FALLBACK");
  assert.equal(r.reason, FallbackReason.DRIFT_REJECT);
});

test("calibration: freshness cutoff is configurable via config.calibrationMaxAgeMs", async () => {
  // calibration is 10 minutes old — accepted with 1h max, rejected with 1s max
  const tenMinAgo = Date.now() - 600_000;
  const store     = makeCalStore({ timestamp: tenMinAgo, canonicalSig128: 0n, threshold: 1.0 });

  const oAccept = new ApexOrchestrator(
    { ...DEFAULT_CONFIG, calibrationMaxAgeMs: 3_600_000 },
    store, NULL_CACHE, PASS_COMPRESSOR,
  );
  const rAccept = await oAccept.execute(enc("x"));
  assert.equal(rAccept.status, "SUCCESS");

  const oReject = new ApexOrchestrator(
    { ...DEFAULT_CONFIG, calibrationMaxAgeMs: 1_000 },
    store, NULL_CACHE, PASS_COMPRESSOR,
  );
  const rReject = await oReject.execute(enc("x"));
  assert.equal(rReject.status,  "FALLBACK");
  assert.equal(rReject.reason,  FallbackReason.CALIBRATION_STALE);
});

// ─────────────────────────────────────────────────────────────────
// FIX 3 — SIMHASH-128
// ─────────────────────────────────────────────────────────────────

test("simhash: deterministic — same input produces same hash", () => {
  const o = makeOrchestrator();
  const a = o.simHash128("the quick brown fox");
  const b = o.simHash128("the quick brown fox");
  assert.equal(a, b);
});

test("simhash: different inputs produce different hashes (collision resistance)", () => {
  const o = makeOrchestrator();
  const a = o.simHash128("hello world");
  const b = o.simHash128("goodbye world");
  assert.notEqual(a, b);
});

test("simhash: upper 64 bits ≠ lower 64 bits (independent halves)", () => {
  const o    = makeOrchestrator();
  const sig  = o.simHash128("some input tokens here");
  const hi   = sig >> 64n;
  const lo   = sig & ((1n << 64n) - 1n);
  assert.notEqual(hi, lo, "upper and lower halves should differ (independent person-prefix salts)");
});

test("simhash: single-token input is stable (no byte-view truncation)", () => {
  const o    = makeOrchestrator();
  const sig1 = o.simHash128("superlongtoken");
  const sig2 = o.simHash128("superlongtoken");
  assert.equal(sig1, sig2);
});

test("simhash: empty string produces a hash (no crash)", () => {
  const o = makeOrchestrator();
  // Empty string → no tokens → acc stays all-zero → sig = 0n
  const sig = o.simHash128("");
  assert.equal(typeof sig, "bigint");
  assert.equal(sig, 0n);  // all bits negative weight or zero → 0n
});

test("simhash: schema version is part of the key (different schema → different hash)", () => {
  const oA = makeOrchestrator({ schemaVersion: "v1.0.0" });
  const oB = makeOrchestrator({ schemaVersion: "v2.0.0" });
  const a  = oA.simHash128("function foo() { return 42; }");
  const b  = oB.simHash128("function foo() { return 42; }");
  assert.notEqual(a, b, "different schema versions must produce different hashes");
});

// ─────────────────────────────────────────────────────────────────
// FIX 4 — SEMAPHORE / FIFO ORDERING
// ─────────────────────────────────────────────────────────────────

test("semaphore: QUEUE_OVERFLOW when pending depth exceeds maxQueueDepth", async () => {
  // maxInFlight=1, maxQueueDepth=2, queueWaitTimeoutMs=5000 (long, won't expire in test)
  // Block only the first request so queue fills deterministically; subsequent
  // requests complete immediately once admitted.
  let releaseFirst!: () => void;
  let first = true;
  const blockingCompressor: SemanticCompressor = {
    compress: async () => {
      if (first) {
        first = false;
        await new Promise<void>(resolve => {
          releaseFirst = resolve;
        });
      }
      return [];
    },
  };

  const o = new ApexOrchestrator(
    { ...DEFAULT_CONFIG, maxInFlight: 1, maxQueueDepth: 2, queueWaitTimeoutMs: 5000 },
    CLEAN_STORE, NULL_CACHE, blockingCompressor,
  );

  // p0: fills the single inflight slot (compressor blocks for first call)
  const p0 = o.execute(enc("p0"));
  // Flush microtask queue so p0 fully acquires inflight before p1/p2 execute()
  for (let i = 0; i < 10; i++) await Promise.resolve();

  // p1 and p2: inflight=1=maxInFlight, so each pushes a pending slot and waits
  const p1 = o.execute(enc("p1"));
  const p2 = o.execute(enc("p2"));
  for (let i = 0; i < 10; i++) await Promise.resolve();

  // pendingQueue.length=2 >= maxQueueDepth=2 → synchronous QUEUE_OVERFLOW
  const r3 = await o.execute(enc("p3"));
  assert.equal(r3.status, "FALLBACK");
  assert.equal(r3.reason, FallbackReason.QUEUE_OVERFLOW);

  releaseFirst();
  await Promise.all([p0, p1, p2]);
});

test("semaphore: FIFO ordering — completions arrive in submission order", async () => {
  const completionOrder: number[] = [];
  const pendingReleases: Array<() => void> = [];
  const releaseNext = () => {
    const next = pendingReleases.shift();
    if (next) next();
  };
  let count = 0;

  // Compressor records which request number completed it
  const orderingCompressor: SemanticCompressor = {
    compress: async () => {
      const myNum = count++;
      await new Promise<void>(r => { pendingReleases.push(r); });
      completionOrder.push(myNum);
      return [new Float32Array([myNum])];
    },
  };

  const o = new ApexOrchestrator(
    { ...DEFAULT_CONFIG, maxInFlight: 1, maxQueueDepth: 5, queueWaitTimeoutMs: 5000 },
    CLEAN_STORE, NULL_CACHE, orderingCompressor,
  );

  // Submit 3 requests — they must complete in order 0, 1, 2
  const promises = [
    o.execute(enc("req0")),
    o.execute(enc("req1")),
    o.execute(enc("req2")),
  ];

  // Let all three enqueue, then release one at a time
  await new Promise(r => setTimeout(r, 10));
  releaseNext();  // unblocks req0

  await new Promise(r => setTimeout(r, 10));
  releaseNext();  // unblocks req1

  await new Promise(r => setTimeout(r, 10));
  releaseNext();  // unblocks req2

  await Promise.all(promises);
  assert.deepEqual(completionOrder, [0, 1, 2], "completions must arrive in FIFO submission order");
});

test("semaphore: requests below maxInFlight execute without queuing", async () => {
  const o = makeOrchestrator({ maxInFlight: 4 });
  // All 3 fit within the 4-slot limit — all should succeed directly
  const results = await Promise.all([
    o.execute(enc("a")),
    o.execute(enc("b")),
    o.execute(enc("c")),
  ]);
  for (const r of results) {
    assert.equal(r.status, "SUCCESS");
  }
});

// ─────────────────────────────────────────────────────────────────
// FIX 5 — QUEUE WAIT TIMEOUT
// ─────────────────────────────────────────────────────────────────

test("queue timeout: pending slot returns QUEUE_TIMEOUT after deadline", async () => {
  let releaseBlocker!: () => void;
  const blockingCompressor: SemanticCompressor = {
    compress: () => new Promise(r => { releaseBlocker = () => r([]); }),
  };

  const o = new ApexOrchestrator(
    { ...DEFAULT_CONFIG, maxInFlight: 1, maxQueueDepth: 5, queueWaitTimeoutMs: 50 },
    CLEAN_STORE, NULL_CACHE, blockingCompressor,
  );

  // Fill the single inflight slot
  const blocker = o.execute(enc("blocker"));
  await new Promise(r => setTimeout(r, 5));

  // This request queues and will timeout after 50ms
  const start   = Date.now();
  const queued  = await o.execute(enc("will-timeout"));
  const elapsed = Date.now() - start;

  assert.equal(queued.status, "FALLBACK");
  assert.equal(queued.reason, FallbackReason.QUEUE_TIMEOUT);
  assert.ok(elapsed >= 40,  `expected ~50ms wait, got ${elapsed}ms`);
  assert.ok(elapsed <= 500, `wait far exceeded deadline: ${elapsed}ms`);

  releaseBlocker();
  await blocker;
});

test("queue timeout: slot that frees in time completes normally", async () => {
  let releaseBlocker!: () => void;
  let first = true;
  const blockingCompressor: SemanticCompressor = {
    compress: async () => {
      if (first) {
        first = false;
        await new Promise<void>(r => { releaseBlocker = () => r(); });
      }
      return [new Float32Array([1])];
    },
  };

  const o = new ApexOrchestrator(
    { ...DEFAULT_CONFIG, maxInFlight: 1, maxQueueDepth: 5, queueWaitTimeoutMs: 500 },
    CLEAN_STORE, NULL_CACHE, blockingCompressor,
  );

  // Fill inflight slot
  const blocker = o.execute(enc("blocker"));
  await new Promise(r => setTimeout(r, 5));

  // Queued request — timeout is 500ms, we'll release at 50ms
  const queued = o.execute(enc("will-complete"));

  // Release before timeout fires
  await new Promise(r => setTimeout(r, 50));
  releaseBlocker();

  const [, r] = await Promise.all([blocker, queued]);
  assert.equal(r.status, "SUCCESS");
});

test("queue timeout: expired slot is removed from queue (no ghost dequeue)", async () => {
  let releaseBlocker!: () => void;
  const blockingCompressor: SemanticCompressor = {
    compress: () => new Promise(r => { releaseBlocker = () => r([]); }),
  };

  const o = new ApexOrchestrator(
    { ...DEFAULT_CONFIG, maxInFlight: 1, maxQueueDepth: 10, queueWaitTimeoutMs: 50 },
    CLEAN_STORE, NULL_CACHE, blockingCompressor,
  );

  const blocker = o.execute(enc("blocker"));
  await new Promise(r => setTimeout(r, 5));

  // Enqueue 3 slots that will all time out
  const [r1, r2, r3] = await Promise.all([
    o.execute(enc("t1")),
    o.execute(enc("t2")),
    o.execute(enc("t3")),
  ]);

  assert.equal(r1.reason, FallbackReason.QUEUE_TIMEOUT);
  assert.equal(r2.reason, FallbackReason.QUEUE_TIMEOUT);
  assert.equal(r3.reason, FallbackReason.QUEUE_TIMEOUT);

  // After all timeouts, queue must be empty — no ghost slots remain
  assert.equal(o.state.pendingDepth, 0, "expired slots must be removed from queue");

  releaseBlocker();
  await blocker;
});
