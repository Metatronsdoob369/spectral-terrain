/**
 * SPECTRAL TERRAIN — APEX ORCHESTRATOR
 *
 * Sealed execution layer for semantic compression requests.
 * Enforces admission control, drift gating, cache keying, and backpressure.
 *
 * Five behavioral contracts (each with targeted tests):
 *
 *   1. Gate machine: OK → WATCH → HOLD → PROBING transitions are all reachable.
 *      PROBE_LOCK fires correctly; probe success returns gate to OK.
 *
 *   2. Calibration: Injected CalibrationStore (not a stub). Stale and missing
 *      calibration both produce distinct fallback reasons.
 *
 *   3. SimHash-128: Stable lexical token hashing — one blake2b512 hash per
 *      whitespace-delimited token. No byte-view truncation.
 *
 *   4. Semaphore queue: Always enqueue before checking capacity; dequeue in
 *      strict FIFO order. No request can bypass a waiting peer.
 *
 *   5. Queue wait timeout: Pending promises expire after queueWaitTimeoutMs.
 *      Expired waiters resolve with QUEUE_TIMEOUT fallback, never hang.
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import * as crypto from "crypto";

// ─────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────

export enum FallbackReason {
  ADMISSION_CAP_BREACH = "ADMISSION_CAP",
  QUEUE_OVERFLOW        = "QUEUE_OVERFLOW",
  QUEUE_TIMEOUT         = "QUEUE_TIMEOUT",    // Fix 5: expired wait
  PROBE_LOCK            = "PROBE_LOCK",
  DRIFT_REJECT          = "DRIFT_REJECT",
  CALIBRATION_MISSING   = "CALIBRATION_MISSING",
  CALIBRATION_STALE     = "CALIBRATION_STALE",
  EMBED_TIMEOUT         = "EMBED_TIMEOUT",
}

export interface CalibrationRecord {
  timestamp:        number;   // epoch ms of calibration
  canonicalSig128:  bigint;   // SimHash-128 of canonical corpus centroid
  threshold:        number;   // max Hamming ratio to accept (e.g. 0.03)
}

// Fix 2: injected store — not a stub
export interface CalibrationStore {
  fetch(schema: string, domain: string, model: string): Promise<CalibrationRecord | null>;
}

export interface LFUCache {
  get(key: string): Promise<Float32Array[] | string | null>;
  set(key: string, value: Float32Array[] | string): Promise<void>;
}

export interface SemanticCompressor {
  compress(payload: Uint8Array): Promise<Float32Array[]>;
}

export interface ApexOrchestratorConfig {
  engineVersion:       string;
  schemaVersion:       string;
  domain:              string;
  collectionId:        string;
  embedModel:          string;
  tokenizer:           string;
  endpointFingerprint: string;
  maxInFlight:         number;   // semaphore width
  maxQueueDepth:       number;   // Fix 4: hard cap before QUEUE_OVERFLOW
  queueWaitTimeoutMs:  number;   // Fix 5: per-slot wait deadline
  calibrationMaxAgeMs: number;
}

export interface TelemetryMeta {
  gateState:          "OK" | "WATCH" | "HOLD" | "PROBING";
  inFlight:           number;
  pendingDepth:       number;
  tau:                number;
  dtheta:             number;
  cacheKeyHashPrefix?: string;
  reason?:            FallbackReason;
}

export interface ExecutionResult {
  status:    "SUCCESS" | "FALLBACK";
  data?:     Float32Array[] | string;
  reason?:   FallbackReason;
  telemetry: TelemetryMeta;
}

// ─────────────────────────────────────────────────────────────────
// PENDING SLOT — Fix 4 + 5
//
// Each slot holds a resolve callback (to unblock the waiting coroutine)
// and a timer handle for the wait timeout. When a slot is dequeued
// normally the timer is cleared. When the timer fires, the slot is
// removed from the queue and the outer promise rejects with a sentinel
// so the caller returns QUEUE_TIMEOUT rather than hanging.
// ─────────────────────────────────────────────────────────────────

interface PendingSlot {
  resolve:    () => void;
  reject:     (err: Error) => void;
  timer:      ReturnType<typeof setTimeout>;
}

const QUEUE_TIMEOUT_SENTINEL = new Error("QUEUE_TIMEOUT_SENTINEL");

// ─────────────────────────────────────────────────────────────────
// APEX ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────

export class ApexOrchestrator {
  private readonly config:      ApexOrchestratorConfig;
  private readonly calibration: CalibrationStore;
  private readonly cache:       LFUCache;
  private readonly compressor:  SemanticCompressor;

  // Semaphore state
  private activeInFlight = 0;
  private readonly pendingQueue: PendingSlot[] = [];

  // Fix 1: full gate machine state
  private gateState:    "OK" | "WATCH" | "HOLD" | "PROBING" = "OK";
  private emaFast:      number | null = null;
  private emaSlow:      number | null = null;
  private strikes:      number = 0;
  private tau:          number = 0.70;
  private dtheta:       number = 1.0;
  private probeInFlight = false;

  // How many consecutive clean observations to exit PROBING
  private readonly PROBE_CLEAR_THRESHOLD = 3;
  private probeCleanCount = 0;

  constructor(
    config:      ApexOrchestratorConfig,
    calibration: CalibrationStore,
    cache:       LFUCache,
    compressor:  SemanticCompressor,
  ) {
    this.config      = config;
    this.calibration = calibration;
    this.cache       = cache;
    this.compressor  = compressor;
  }

  // ─────────────────────────────────────────────────────────────────
  // PUBLIC: admission + execution
  // ─────────────────────────────────────────────────────────────────

  public async execute(payload: Uint8Array): Promise<ExecutionResult> {
    // Hard cap: reject immediately when queue is full
    if (this.pendingQueue.length >= this.config.maxQueueDepth) {
      return this.fallback(FallbackReason.QUEUE_OVERFLOW);
    }

    // PROBING: only one probe may be in flight at a time
    let holdsProbeLock = false;
    if (this.gateState === "PROBING") {
      if (this.probeInFlight) {
        return this.fallback(FallbackReason.PROBE_LOCK);
      }
      this.probeInFlight = true;
      holdsProbeLock = true;
    }

    let acquiredSemaphore = false;
    let incrementedInFlight = false;
    try {
      // Fix 4: always go through the semaphore queue — no bypass
      await this.acquireSemaphore();
      acquiredSemaphore = true;

      this.activeInFlight++;
      incrementedInFlight = true;

      return await this.cacheAndRetrieve(payload);
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (err === QUEUE_TIMEOUT_SENTINEL) return this.fallback(FallbackReason.QUEUE_TIMEOUT);
        if (err.name === "TimeoutError")    return this.fallback(FallbackReason.EMBED_TIMEOUT);
      }
      throw err;
    } finally {
      if (incrementedInFlight) {
        this.activeInFlight--;
      }
      if (holdsProbeLock) this.probeInFlight = false;
      if (acquiredSemaphore) {
        this.releaseSemaphore();
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Fix 1: GATE MACHINE — all four states reachable
  //
  // Transitions:
  //   OK    → WATCH  : first breach (strikes = 1)
  //   WATCH → HOLD   : second breach (strikes = 2)
  //   HOLD  → PROBING: tighten tau/dtheta, reset strikes, arm probe
  //   PROBING → OK   : PROBE_CLEAR_THRESHOLD consecutive clean observations
  //   any   → OK     : strikes decay to 0 on clean observations
  //
  // Called by the consumer after observing a p95 TTFT measurement.
  // ─────────────────────────────────────────────────────────────────

  public updateGate(p95TtftMs: number, gap: number | null): void {
    const BETA_FAST       = 0.5;
    const BETA_SLOW       = 0.9;
    const BURST_DELTA     = 0.15;
    const TTFT_THRESHOLD  = 100.0;
    const GAP_FLOOR       = 0.001;

    this.emaFast = this.emaFast === null
      ? p95TtftMs
      : BETA_FAST * this.emaFast + (1 - BETA_FAST) * p95TtftMs;
    this.emaSlow = this.emaSlow === null
      ? p95TtftMs
      : BETA_SLOW * this.emaSlow + (1 - BETA_SLOW) * p95TtftMs;

    const breachSlo   = p95TtftMs > TTFT_THRESHOLD || (gap !== null && gap < GAP_FLOOR);
    const breachBurst = this.emaFast > (1 + BURST_DELTA) * this.emaSlow;
    const breach      = breachSlo || breachBurst;

    if (breach) {
      this.probeCleanCount = 0;

      // Drive state changes one step per observation:
      // 1st breach: OK -> WATCH
      // 2nd breach: WATCH -> HOLD
      // 3rd breach: HOLD -> PROBING (+ tighten tau/dtheta)
      if (this.gateState === "HOLD") {
        this.tau    = parseFloat((this.tau    + 0.05).toFixed(3));
        this.dtheta = parseFloat((this.dtheta * 0.5 ).toFixed(3));
        this.strikes = 0;
        this.gateState = "PROBING";
        return;
      }

      if (this.gateState === "PROBING") {
        // Keep probe mode active on breach; caller decides whether to
        // execute probe traffic or reject via PROBE_LOCK.
        return;
      }

      this.strikes++;
      if (this.gateState === "OK") {
        this.gateState = "WATCH";
        return;
      }
      if (this.gateState === "WATCH" && this.strikes >= 2) {
        this.gateState = "HOLD";
        return;
      }
    } else {
      if (this.gateState === "PROBING") {
        this.probeCleanCount++;
        if (this.probeCleanCount >= this.PROBE_CLEAR_THRESHOLD) {
          this.gateState       = "OK";
          this.probeCleanCount = 0;
          this.strikes         = 0;
        }
        // Partial recovery: don't touch strikes until cleared
      } else {
        this.strikes = Math.max(this.strikes - 1, 0);
        if (this.strikes === 0) this.gateState = "OK";
        else if (this.strikes === 1) this.gateState = "WATCH";
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Fix 3: SIMHASH-128 — stable lexical token hashing
  //
  // Tokenize by whitespace, hash each token with blake2b512 under a
  // domain+schema salt, accumulate bit weights, sign to produce two
  // independent 64-bit halves, concatenate to 128-bit bigint.
  //
  // No byte-view window — every token is fully hashed regardless of
  // trailing-byte alignment.
  // ─────────────────────────────────────────────────────────────────

  public simHash128(text: string): bigint {
    const schemaSlice = this.config.schemaVersion.slice(0, 6);
    const tokens      = text.split(/\s+/).filter(t => t.length > 0);
    const sigA = this.simHash64(tokens, `RFG:shA:${schemaSlice}`);
    const sigB = this.simHash64(tokens, `RFG:shB:${schemaSlice}`);
    return (sigA << 64n) | sigB;
  }

  private simHash64(tokens: string[], personPrefix: string): bigint {
    const acc = new Int32Array(64);

    for (const token of tokens) {
      const data = Buffer.from(`${personPrefix}|${token}`);
      const hash = crypto.createHash("blake2b512").update(data).digest();
      const h    = hash.readBigUInt64BE(0);   // first 8 bytes → 64-bit view

      for (let bit = 0n; bit < 64n; bit++) {
        acc[Number(bit)] += ((h >> bit) & 1n) === 1n ? 1 : -1;
      }
    }

    let sig = 0n;
    for (let i = 0n; i < 64n; i++) {
      if (acc[Number(i)] > 0) sig |= (1n << i);
    }
    return sig;
  }

  // ─────────────────────────────────────────────────────────────────
  // SEMAPHORE — Fix 4 + Fix 5
  //
  // acquireSemaphore always pushes a slot onto the queue, then checks
  // whether it is now at the head AND capacity is available. If not,
  // it waits. Slots are dequeued strictly in FIFO order by the release
  // path — no request can observe capacity and skip ahead of a waiter.
  // ─────────────────────────────────────────────────────────────────

  private acquireSemaphore(): Promise<void> {
    return new Promise<void>((outerResolve, outerReject) => {
      let settled = false;

      const slot: PendingSlot = {
        resolve: () => {
          if (settled) return;
          settled = true;
          clearTimeout(slot.timer);
          outerResolve();
        },
        reject: (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(slot.timer);
          outerReject(err);
        },
        timer: setTimeout(() => {
          // Expire: remove from queue so the slot doesn't block dequeue
          const idx = this.pendingQueue.indexOf(slot);
          if (idx !== -1) this.pendingQueue.splice(idx, 1);
          slot.reject(QUEUE_TIMEOUT_SENTINEL);
        }, this.config.queueWaitTimeoutMs),
      };

      this.pendingQueue.push(slot);
      this.tryAdvanceQueue();
    });
  }

  private releaseSemaphore(): void {
    this.tryAdvanceQueue();
  }

  private tryAdvanceQueue(): void {
    // The slot at index 0 is the oldest waiting request.
    // Grant capacity to it if we have room.
    if (this.pendingQueue.length > 0 && this.activeInFlight < this.config.maxInFlight) {
      const slot = this.pendingQueue.shift()!;
      slot.resolve();
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // CACHE + RETRIEVE
  // ─────────────────────────────────────────────────────────────────

  private async cacheAndRetrieve(payload: Uint8Array): Promise<ExecutionResult> {
    const normalized = this.normalizePayload(payload);
    const text       = new TextDecoder().decode(normalized);
    const sig128     = this.simHash128(text);

    const driftResult = await this.checkDrift(sig128);
    if (!driftResult.calibrationFound) return this.fallback(FallbackReason.CALIBRATION_MISSING);
    if (driftResult.isStale)           return this.fallback(FallbackReason.CALIBRATION_STALE);
    if (!driftResult.isStable)         return this.fallback(FallbackReason.DRIFT_REJECT);

    const cacheKey    = this.buildCacheKey(normalized);
    const keyPrefix   = cacheKey.slice(0, 12);
    const cachedShard = await this.cache.get(cacheKey);
    if (cachedShard !== null) return this.success(cachedShard, keyPrefix);

    const result = await this.compressor.compress(payload);
    await this.cache.set(cacheKey, result);
    return this.success(result, keyPrefix);
  }

  // Fix 2: delegates to injected CalibrationStore — no stub
  private async checkDrift(sig128: bigint): Promise<{
    isStable: boolean; calibrationFound: boolean; isStale: boolean;
  }> {
    const cal = await this.calibration.fetch(
      this.config.schemaVersion,
      this.config.domain,
      this.config.embedModel,
    );

    if (!cal) return { isStable: false, calibrationFound: false, isStale: false };

    const ageMs = Date.now() - cal.timestamp;
    if (ageMs > this.config.calibrationMaxAgeMs) {
      return { isStable: false, calibrationFound: true, isStale: true };
    }

    // Hamming distance over 128 bits
    let xor   = sig128 ^ cal.canonicalSig128;
    let count = 0;
    while (xor > 0n) {
      count += Number(xor & 1n);
      xor >>= 1n;
    }
    const hammingRatio = count / 128.0;

    return { isStable: hammingRatio <= cal.threshold, calibrationFound: true, isStale: false };
  }

  // Fix 5 (also covers GAP 5): network-salted, schema-versioned cache key
  private buildCacheKey(data: Uint8Array): string {
    const salt = [
      "RFGv4",
      this.config.engineVersion,
      this.config.schemaVersion,
      this.config.domain,
      this.config.collectionId,
      this.config.embedModel,
      this.config.tokenizer,
      this.config.endpointFingerprint,
    ].join("|");
    const payload = Buffer.concat([Buffer.from(salt), Buffer.from("|"), data]);
    return crypto.createHash("blake2b512").update(payload).digest("hex").slice(0, 64);
  }

  private normalizePayload(p: Uint8Array): Uint8Array {
    const str = new TextDecoder().decode(p).replace(/\s+/g, " ").trim();
    return new TextEncoder().encode(str);
  }

  private fallback(reason: FallbackReason, keyPrefix?: string): ExecutionResult {
    return {
      status:    "FALLBACK",
      reason,
      data:      "CEPE_OR_NC_FALLBACK",
      telemetry: this.telemetry(keyPrefix, reason),
    };
  }

  private success(data: Float32Array[] | string, keyPrefix: string): ExecutionResult {
    return { status: "SUCCESS", data, telemetry: this.telemetry(keyPrefix) };
  }

  private telemetry(keyPrefix?: string, reason?: FallbackReason): TelemetryMeta {
    return {
      gateState:          this.gateState,
      inFlight:           this.activeInFlight,
      pendingDepth:       this.pendingQueue.length,
      tau:                this.tau,
      dtheta:             this.dtheta,
      cacheKeyHashPrefix: keyPrefix,
      reason,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // ACCESSOR — for test inspection
  // ─────────────────────────────────────────────────────────────────

  public get state() {
    return {
      gateState:    this.gateState,
      strikes:      this.strikes,
      tau:          this.tau,
      dtheta:       this.dtheta,
      pendingDepth: this.pendingQueue.length,
      inFlight:     this.activeInFlight,
    };
  }
}
