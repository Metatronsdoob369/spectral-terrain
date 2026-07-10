/**
 * SPECTRAL TERRAIN — MASTER CONTRACT
 *
 * This is the law of the environment. Every agent operating in this terrain
 * must conform to these types. Every tool, every output, every metric.
 *
 * Proprietary — NODE OUT / Joe Wales
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────
// CORE VECTOR TYPES
// ─────────────────────────────────────────────────────────────────

/** Single embedding from a local Ollama embedder. Default length 1024 for mxbai-embed-large, override via EMBED_DIM env var. */
const EMBED_DIM = (() => {
  const env = typeof process !== "undefined" && process.env?.EMBED_DIM ? parseInt(process.env.EMBED_DIM, 10) : 1024;
  return Number.isFinite(env) && env > 0 ? env : 1024;
})();

export const EmbeddingSchema = z.array(z.number()).length(EMBED_DIM);

const DIM_3072 = EMBED_DIM * 3;

/**
 * Temporal 3072-D vector: [v_t-1 | v_t | v_t+1]
 * Time is a structural dimension, not a sequence.
 */
export const TemporalVectorSchema = z.object({
  t_minus1: EmbeddingSchema,   // where this code came from
  t_now:    EmbeddingSchema,   // what this code is now
  t_plus1:  EmbeddingSchema,   // where this code is going
  concat:   z.array(z.number()).length(DIM_3072), // [t-1, t, t+1] flat — what goes to Qdrant
});

export type TemporalVector = z.infer<typeof TemporalVectorSchema>;

// ─────────────────────────────────────────────────────────────────
// DOMAIN CONTRACT
// ─────────────────────────────────────────────────────────────────

export const DomainSchema = z.enum([
  "roblox-luau",           // Physics-deterministic t+1 — state changes with every engine tick
  "finance-crypto",        // Learned residual t+1 — liquidity pools, mempool, blockchain state
  "source-audit",          // Static code — NO temporal geometry. Single 1024-D embed only.
  "general",               // Static code — NO temporal geometry. Single 1024-D embed only.
  "memory",                // Static documents — NO temporal geometry. Single 1024-D embed only.
  "reddit",                // Reddit domain — static text embeddings
  "geospatial-standards",  // ISO/NATO geospatial standards — 0-dim structural fingerprint (3-D). NO Ollama.
]);

export type Domain = z.infer<typeof DomainSchema>;

/**
 * CONTRACT: Which domains require temporal geometry (3072-D [v_t-1|v_t|v_t+1]).
 *
 * Temporal geometry is ONLY meaningful when the domain has real state progression —
 * i.e., code whose execution semantics change through time-indexed states:
 * game engines (physics ticks), blockchain (block state), liquidity pools (AMM curves).
 *
 * Static source code, documents, and audit files do NOT change state over time.
 * Concatenating [v|v|v] for these domains produces geometrically identical thirds
 * with zero temporal signal — inflated dimensionality, degraded centroid accuracy,
 * and 3× unnecessary embed cost. These domains use a single 1024-D vector.
 *
 * Enforced at ingest time. Violations are a contract breach — not a config choice.
 */
export const DOMAIN_GEOMETRY = {
  "roblox-luau":          { temporal: true,  dim: 3072, reason: "physics-deterministic tick progression" },
  "finance-crypto":       { temporal: true,  dim: 3072, reason: "blockchain/mempool state transitions" },
  "source-audit":         { temporal: false, dim: 1024, reason: "static code — no state progression" },
  "general":              { temporal: false, dim: 1024, reason: "static code — no state progression" },
  "memory":               { temporal: false, dim: 1024, reason: "static documents — no state progression" },
  "reddit":               { temporal: false, dim: 1024, reason: "reddit content — static text" },
  // Structural fingerprint layer — 3-D, deterministic, no Ollama, no network.
  // [log(token_count), sha_hash_norm, log(chapter_count)] via 0-dim injector pattern.
  // eve TriadGATGraphRAG(in_dim=3) builds the K-NN graph and heat map.
  // Qdrant collection: spectral-heatmap-geo (dim=3).
  "geospatial-standards": { temporal: false, dim: 3,    reason: "ISO/NATO standards — deterministic structural fingerprint, not semantic embedding" },
} as const satisfies Record<Domain, { temporal: boolean; dim: number; reason: string }>;

export type DomainGeometry = typeof DOMAIN_GEOMETRY[Domain];

export const TPlusonMethodSchema = z.enum([
  "physics-deterministic",  // t+1 computed from engine rules (Roblox, blockchain)
  "learned-residual",       // t+1 predicted from (t-1, t) model
  "single-embed",           // 1024-D — domain does not require temporal geometry (contract-enforced)
  "placeholder",            // [v,v,v] — LEGACY ONLY. Do not use for new ingests.
]);

// ─────────────────────────────────────────────────────────────────
// TERRAIN POINT (What lives in Qdrant spectral-heatmap)
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────
// LABEL METADATA (Shadow vocabulary audit layer)
// ─────────────────────────────────────────────────────────────────

export const LabelRiskClassSchema = z.enum([
  "invalid_identifier",   // fails as Luau variable name
  "dot_access_unsafe",    // spaces/hyphens — must use WaitForChild
  "api_collision",        // shadows Roblox service/member/global name
  "team_convention_reject", // meaningless or unstable by convention
  "clean",                // passes all checks
]);

export const SuffixClassSchema = z.enum([
  "Manager", "Controller", "Service", "Handler", "System",
  "Bridge", "Generator", "Interface", "Core", "Library",
  "Client", "Server", "Module", "none",
]);

export const LabelMetaSchema = z.object({
  module_name:      z.string(),               // extracted from filename
  suffix_class:     SuffixClassSchema,        // which suffix pattern
  risk_class:       LabelRiskClassSchema,     // worst risk found
  api_collision:    z.boolean(),              // true if name matches Roblox API term
  casing_valid:     z.boolean(),              // true if PascalCase
  dot_access_safe:  z.boolean(),              // false if spaces/hyphens in any string literal
  shadow_terms:     z.array(z.string()),      // string literals that hit the API collision list
  casing_violations: z.array(z.string()),     // lowercase service aliases found
});

export type LabelMeta = z.infer<typeof LabelMetaSchema>;
export type LabelRiskClass = z.infer<typeof LabelRiskClassSchema>;
export type SuffixClass = z.infer<typeof SuffixClassSchema>;

export const TerrainPointSchema = z.object({
  id:              z.string().uuid(),
  domain:          DomainSchema,
  file:            z.string(),
  symbol:          z.string().optional(),
  kind:            z.enum(["canonical", "shattered", "pending"]),

  // Temporal metadata
  t_method:        TPlusonMethodSchema,
  t_source:        z.string().optional(), // what generated t+1

  // Geometric scores
  heat:            z.number(),  // Manhattan resonance — Σ|v[i]|
  shatter:         z.number(),  // Euclidean distance from Diamond-Stable centroid
  hamming_sig:     z.string(),  // 128-bit SimHash hex

  // Repair
  deltaVector3d:   z.array(z.number()).length(3).nullable(), // vector to centroid
  deltaTarget:     z.string().nullable(), // nearest canonical file

  // Shadow vocabulary audit
  label_meta:      LabelMetaSchema.optional(),

  // Audit
  ingestedAt:      z.string().datetime(),
  provenanceHash:  z.string(), // BLAKE2b of source content

  // Unicode drift flag — true if pre-ingest filter stripped non-ASCII chars.
  // Points with this flag have degraded vector fidelity under mxbai-embed-large.
  // Re-embed against spectral-terrain-768 (nomic-embed-text) when that instance is live.
  unicode_drift_risk:      z.boolean().optional(),

  // Source resolvability — true if the source file was read from disk at ingest time.
  // false (or absent) = synthetic/generated content with no on-disk path.
  // Drift sidecar requires this to be true before scoring — absent = treated as false.
  source_resolvable:       z.boolean().optional(),

  // Schema version — increment when payload fields change shape or meaning.
  // Absent = v0 (pre-versioning). Use this to gate migrations and CI checks.
  //
  // v1 — 2026-05-22: added source_resolvable; cleared unicode_drift_risk from synthetic popsim points;
  //                  fixed idempotency gate to !== undefined (was > 0, causing 0.0-score churn)
  payload_schema_version:  z.number().int().optional(),
});

export type TerrainPoint = z.infer<typeof TerrainPointSchema>;

/**
 * Current payload schema version. Increment here + add changelog entry in TerrainPointSchema
 * whenever payload fields change shape or meaning. Ingest writes this on every new point.
 * Migration scripts gate on this to identify points that need backfilling.
 *
 * Version history:
 *   0 — (absent) baseline, no versioning
 *   1 — 2026-05-22: source_resolvable added; unicode_drift_risk cleared from synthetic popsim points;
 *                   drift sidecar idempotency fixed (!== undefined, not > 0)
 */
export const TERRAIN_PAYLOAD_VERSION = 1 as const;

// ─────────────────────────────────────────────────────────────────
// SHATTER REPORT (Output of a query or scan)
// ─────────────────────────────────────────────────────────────────

export const ShatterReportSchema = z.object({
  queryFile:       z.string(),
  domain:          DomainSchema,
  shatter:         z.number(),
  heat:            z.number(),
  kind:            z.enum(["canonical", "shattered", "pending"]),
  nearestCanonical: z.object({
    file:          z.string(),
    shatter:       z.number(),
    distance:      z.number(),
  }).nullable(),
  recommendation:  z.enum([
    "ANCHOR",           // shatter < 0.05 — use as-is
    "REVIEW",           // 0.05 < shatter < 0.15 — inspect before shipping
    "SHATTER_RESOLVE",  // shatter > 0.15 — apply deltaVector repair
    "SLOP_CHECK",       // query slop-canon before proceeding
  ]),
  timestamp:       z.string().datetime(),
});

export type ShatterReport = z.infer<typeof ShatterReportSchema>;

// ─────────────────────────────────────────────────────────────────
// TELEMETRY (EvasionGate output — logged every cycle)
// ─────────────────────────────────────────────────────────────────

export const TelemetrySchema = z.object({
  status:          z.enum(["OK", "WATCH", "HOLD"]),
  tau:             z.number(),   // Attack tempo (adaptive throttle)
  dTheta:          z.number(),   // Angular step size
  emaFast:         z.number(),
  emaSlow:         z.number(),
  driftStable:     z.boolean(),  // DriftGuard result
  hammingRatio:    z.number(),
  cycle:           z.number(),
  domain:          DomainSchema,
  timestamp:       z.string().datetime(),
});

export type Telemetry = z.infer<typeof TelemetrySchema>;

// ─────────────────────────────────────────────────────────────────
// CENTROID (Diamond-Stable baseline — computed once per domain)
// ─────────────────────────────────────────────────────────────────

export const CentroidSchema = z.object({
  domain:          DomainSchema,
  vector:          z.array(z.number()).length(3072),
  computedAt:      z.string().datetime(),
  corpusSize:      z.number(), // how many canonical points went in
  stability:       z.number(), // drift vs previous centroid (< 0.01 = stable)
  label:           z.string(), // e.g. "Diamond-Stable-roblox-luau-2026-05-20"
});

export type Centroid = z.infer<typeof CentroidSchema>;

// ─────────────────────────────────────────────────────────────────
// SLOP CANON ENTRY (Failure memory)
// ─────────────────────────────────────────────────────────────────

export const SlopEntrySchema = z.object({
  id:              z.string().uuid(),
  domain:          DomainSchema,
  title:           z.string(),
  errorType:       z.string(),
  stackTrace:      z.string().optional(),
  badPattern:      z.string(), // the code/pattern that caused failure
  correction:      z.string(), // what to do instead
  embedding:       z.array(z.number()).length(1024), // 1024-D in slop-canon collection
  timestamp:       z.string().datetime(),
});

export type SlopEntry = z.infer<typeof SlopEntrySchema>;

// ─────────────────────────────────────────────────────────────────
// AGENT OPERATIONAL CONTRACT
// ─────────────────────────────────────────────────────────────────

export const AgentDirectives = {
  PRE_FLIGHT: {
    trigger: "Before writing any code in this terrain",
    action: "Query spectral-heatmap with your intended logic embedding. Find nearest canonical. Anchor to it.",
  },
  SHATTER_RESOLVE: {
    trigger: "shatter > 0.05 on any terrain point",
    action: "Extract deltaVector3d. Apply topological translation toward deltaTarget.",
  },
  SLOP_CHECK: {
    trigger: "Using any unfamiliar API, pattern, or Roblox service",
    action: "Embed the pattern. Query slop-canon (1024-D). If hit rate > 0, apply correction.",
  },
  DRIFT_BREACH: {
    trigger: "DriftGuard hammingRatio > 0.03",
    action: "Re-anchor session. Re-embed current context. Do not continue on stale signature.",
  },
  HOLD_STATE: {
    trigger: "EvasionGate status = HOLD",
    action: "Throttle output. Sink below noise floor. Wait for tau to stabilize.",
  },
} as const;
