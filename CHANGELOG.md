# CHANGELOG

## v0.1.1 — 2026-05-22

### Added

- Introduced `TERRAIN_PAYLOAD_VERSION = 1` as the contract source of truth in `contracts/terrain.contract.ts`.
- Added `payload_schema_version` to `TerrainPointSchema` — written on every new ingest, backfillable via script.
- Added `source_resolvable` to `TerrainPointSchema` — explicit on-disk semantics for ingest paths vs. synthetic content.
- Added `engine/terrain-integrity.ts` — CI integrity gate with three enforced rules:
  - `DRIFT_RISK_WITHOUT_SOURCE` — unicode_drift_risk=true requires source_resolvable=true (hard fail, exit 1)
  - `payload_schema_version` presence check — warns with backfill guidance (soft)
  - `STALE_SCHEMA_VERSION` — post-cutoff points must carry current version (hard fail, exit 1)
- Added drift telemetry artifacts written atomically from a single serialized payload:
  - `telemetry/drift-run-{timestamp}.json` — trendable history, retained 30 runs then pruned
  - `telemetry/latest-drift-run.json` — stable pointer for agents and dashboards (no glob needed)
- Added `status` field to drift artifacts: `clean | degraded | error` — agent branch oracle.
  - `clean` — queue healthy, all attempts succeeded or were legitimately skipped
  - `degraded` — partial failure (miss > 0 or error > 0, but not all attempted)
  - `error` — systemic: `nError === attempted`, nothing got through, block on this
- Added `npm run promote` script — gates on `npm run ci` (tests + integrity), blocks on any failure.

### Changed

- Backfilled all 525 existing terrain points to `payload_schema_version: 1`.
- Sidecar Qdrant scroll filter now requires `source_resolvable: true` — structurally excludes synthetic content.
- Drift sidecar summary now reports full counters on every run (including all-skip): `Queued / Scored / Skipped / Miss / Error` with inline diagnostics.
- Promotion flow gated by `npm run ci` — no longer procedural.

### Fixed

- **Sidecar idempotency bug** — old gate was `magnitude > 0`, causing files that scored 0.0 (CLEAN) to be re-embedded on every run. New gate is `!== undefined` — 0.0 is a valid scored state.
- **CLI `--domain` parsing bug** — when `--domain` flag was absent, `indexOf("--domain") + 1` resolved to index 0 (the node binary path), which was cast to `Domain` and sent as a Qdrant filter, returning 0 results. Fixed with `domainIdx !== -1` guard.
- **Large-file embedding failures (Bad Request)** — `embedNomic()` passed full file content as a single Ollama request, exceeding nomic-embed-text's 512-token context window on files > ~100 words of code. Fixed by adding word-based chunking matching the `embed.ts` pipeline: 100 words/chunk ceiling, 20-word minimum fragment threshold, max-magnitude pooling across chunks. Previously failing files (9 total) now score correctly.
- **Synthetic popsim queue contamination** — 72 UUID-prefixed roblox-luau terrain points had `unicode_drift_risk: true` but no on-disk source path. They appeared in every sidecar scan as `[miss]` noise, inflating queue counts and degrading run signal. Fixed by setting `unicode_drift_risk: false` on all synthetic points and adding `source_resolvable` gate to the scroll filter.

### Tests

- Added `tests/drift-sidecar.test.ts` — pure logic regression coverage (no Ollama/Qdrant required):
  - `--domain` absent/present parsing, including negative case documenting the old bug
  - Chunking shape: MIN_WORDS boundary, 250-word split, tail discard, word integrity, empty string
- Added `tests/drift-sidecar-golden.test.ts` — behavioral baseline:
  - Golden counter snapshot for current terrain state (36 queued, all-skip, 0 miss, 0 error)
  - Idempotent skip for 0.0 CLEAN files
  - Miss/error/scored counter pathway correctness
  - `status` derivation: 7 distinct cases including systemic `error` discriminator
  - Schema version cutoff predicate logic (pre/post cutoff, missing ingestedAt)

**Current gate:** 24/24 tests passing, 3/3 integrity rules clean.

### Operational Impact

- Drift runs are now deterministic, idempotent, and fully auditable per run.
- Synthetic/unresolvable artifacts are structurally excluded from drift scoring — not filtered at read time, excluded at write time.
- `latest-drift-run.json` gives any agent or dashboard a single stable read for current terrain health — no timestamp arithmetic, no globbing.
- Agent orchestration can branch on `status` before touching counters or drift stats.

---

## v0.1.0 — 2026-05-21

Initial terrain pipeline operational.

- Qdrant collection `spectral-heatmap` (3072-D, Cosine)
- `engine/embed.ts` — mxbai-embed-large (1024-D), word-based chunking, max-magnitude pooling, temporal vector builder
- `engine/ingest.ts` — repo walker, pre-ingest Unicode filter, domain geometry gate, Roblox physics-deterministic t+1
- `engine/calibrate.ts` — Diamond-Stable centroid computation per domain
- `engine/query.ts` — nearest canonical query, shatter report, slop-canon query
- `engine/drift-sidecar.ts` — post-ingest unicode drift scoring via nomic-embed-text
- `contracts/terrain.contract.ts` — `DOMAIN_GEOMETRY` map, `TerrainPointSchema`, `AgentDirectives`
- `domains/roblox-luau-tplus1.ts` — physics-deterministic t+1 (one engine tick forward)
- `engine/label-validator.ts` — Roblox shadow vocabulary audit, API collision detection
- `use-cases/blue-team-autonomous-defense.md` — 4-layer autonomous defense architecture spec
- Two domains ingested and calibrated: roblox-luau (256 canonical), source-audit (207 points, 36 canonical)
