# WhiteGlove System — Three-Zone Architecture

Version: 1.0 | Status: Zone 1 + Zone 2 operational | Zone 3: Phase 1 gated

## Zone Map

ZONE 1 — Orchestration (NodeBase, external access OK)
  POST /api/webhook/ingest  -> terrain_ingest (PostgreSQL)
  GET  /api/topology        -> node graph JSON
  tRPC terrain router       -> gate_event, audit_entry
  Canvas Run button         -> simulation ingest (confirmed working)

  [telemetry only, one-way, append-only]

ZONE 2 — Air-Gapped Kernel (zero external calls at query time)
  HK101 Refinery -> Terrain Packs (.tar.gz)
  WhiteGlove Harness TUI
    LiveTerrainEngine: FAISS KNN, LLM fingerprint embeddings, EMA drift
    SilenceGate: 6 gate decisions, Silence Rule enforced
    ProfessorPersona: 280-token synthesis budget
  Gate States: OK -> WATCH -> HOLD -> PROBING -> SILENCE
  Shatter Bands: ANCHOR <0.05 | REVIEW <0.15 | ALARM >=0.15

  [signed spectral proof + human gate only]

ZONE 3 — SovereignArbEngine (Phase 2, not yet built)
  All executions require operator approval or multi-sig threshold

## Boundary Rules

| Boundary       | Permitted                          | Forbidden                        |
|----------------|------------------------------------|----------------------------------|
| Zone 1->Zone 2 | Terrain Pack files (offline)       | Live queries, API calls          |
| Zone 2->Zone 1 | Gate event telemetry (async POST)  | Query content, embeddings        |
| Zone 2->Zone 3 | Signed spectral proof + human gate | Raw embeddings, query text       |
| Zone 3->Zone 2 | Nothing                            | Everything                       |

## Query Lifecycle

1. Operator submits query via TUI
2. LiveTerrainEngine generates LLM fingerprint embedding
3. FAISS KNN search against terrain pack index
4. Shatter score computed (L2 distance to centroid)
5. SilenceGate evaluates gate state
6. SILENCE/HOLD -> system stays silent; OK/WATCH -> ProfessorPersona synthesizes
7. Gate event POSTed to Zone 1 async (non-blocking)

## Terrain Pack Ingestion Flow

1. HK101 produces Terrain Pack (.tar.gz) in Zone 2
2. Pack transferred to Zone 1 (file copy, no live connection)
3. POST /api/webhook/ingest -> normalizeTerrainPayload() -> terrain_ingest table
4. Harness loads pack: BLAKE2b verify -> centroid load -> FAISS mount
5. Pack live in Zone 2 kernel — queries navigate its geometry

## Repositories

| Repo                          | Zone            | Language   | Purpose                              |
|-------------------------------|-----------------|------------|--------------------------------------|
| Metatronsdoob369/whiteglove-harness | Zone 2    | Python     | Harness TUI, SilenceGate, engine     |
| Metatronsdoob369/HK101        | Zone 2          | Python     | Spectral Terrain Refinery, LivingRAG |
| Metatronsdoob369/spectral-terrain | Zone 1/2    | TypeScript | Apex-orchestrator, terrain contracts |
| Metatronsdoob369/nodebase     | Zone 1          | TypeScript | Workflow canvas, ingestion, telemetry|

## Key Principles

Silence over hallucination — Faith-Less by design. System stays silent rather than produce a plausible-but-wrong response when outside canonical geometry.

Geometry over retrieval — Knowledge is navigated, not fetched. Shatter score (L2 distance to centroid) is the primary signal, not semantic similarity.

Append-only audit trail — Every gate decision logged with BLAKE2b entry hash. Immutable and queryable via Zone 1 tRPC router.

Human-in-the-loop at Zone 3 — No execution reaches Zone 3 without signed spectral proof from Zone 2 and explicit operator approval. Non-negotiable in Phase 1.

## Current Status (v1.0)

| Component                                      | Status          |
|------------------------------------------------|-----------------|
| Zone 1: NodeBase canvas, ingestion, tRPC router | Operational    |
| Zone 2: Harness TUI, SilenceGate, LiveTerrainEngine | Operational |
| Zone 1<->2: Live gate event telemetry          | Operational     |
| Zone 2: TerrainPackLoader, FAISS, BLAKE2b      | Operational     |
| Zone 3: SovereignArbEngine                     | Phase 2         |
| Ollama-first embedding (nomic-embed-text Q8_0) | Planned v1.1    |
| Recursive self-ingest                          | Planned v2      |
