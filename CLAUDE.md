# CLAUDE.md — SPECTRAL TERRAIN

This file provides guidance to Claude Code when working in this repository.

**READ `AGENT_ENTRY.md` FIRST. That is your terrain briefing. This file is just operational config.**

---

## What This Repo Is

The canonical home of the **Temporal Geometric Intelligence Layer (TGIL)** — a proprietary
architecture by Joe Wales / NODE OUT for agent code understanding via geometry rather than tokenization.

Core idea: code states are 3072-D points `[v_t-1 | v_t | v_t+1]`. Time is structural, not sequential.

---

## Commands

```bash
# Ingest a codebase into the terrain
npm run ingest:roblox /path/to/luau/repo
npm run ingest:audit /path/to/any/repo

# Mark a codebase as canonical (trusted baseline)
npx tsx engine/ingest.ts --domain roblox-luau --path /path/to/repo --canonical

# Compute Diamond-Stable centroid after canonical ingest
npm run calibrate:roblox

# Query terrain (agent pre-flight)
npx tsx engine/query.ts
```

## Infrastructure Required

- **Qdrant** at `http://127.0.0.1:6340` — vector vault
- **Ollama** at `http://127.0.0.1:11434` with `mxbai-embed-large` — local embedder

Start them:
```bash
# Qdrant (Docker)
docker run -p 6340:6333 qdrant/qdrant

# Ollama
ollama serve
```

---

## Directory Map

```
AGENT_ENTRY.md          ← Agent reads this first — terrain briefing
contracts/
  terrain.contract.ts   ← Master types: TerrainPoint, ShatterReport, Centroid, etc.
  roblox-luau.domain.ts ← Roblox-specific: physics prediction, Luau safety rules
engine/
  embed.ts              ← Embedder, temporal vector builder, heat/shatter scoring
  query.ts              ← Nearest canonical query, shatter report, slop-canon query
  ingest.ts             ← Run any codebase through the terrain
  calibrate.ts          ← Compute Diamond-Stable centroid from canonical points
calibration/            ← Centroid JSON files per domain (generated, not hand-written)
vault/                  ← Index snapshots, terrain health summaries
telemetry/              ← EvasionGate logs, ingest summaries, audit trail
slop-canon/             ← Failure memory (auto-populated, never delete)
agents/
  AGENT_CONTRACT.md     ← Operational contract for agents working in this terrain
domains/                ← Domain-specific t+1 prediction implementations
```

---

## Key Architecture Facts

- **3072-D = [1024 | 1024 | 1024]** — mxbai-embed-large output concatenated 3× for temporal encoding
- **t+1 method for Roblox** = physics-deterministic (one engine tick forward, no ML)
- **t+1 method for source-audit** = learned residual (pending implementation)
- **Shatter > 0.05** = review required. **Shatter > 0.15** = apply deltaVector repair
- **DriftGuard threshold** = 0.03 Hamming ratio (tighter than WhiteGlove's 0.2858 — this is execution context, not document similarity)
- **Slop-canon** = 1024-D collection in Qdrant. Populated automatically on failures.

## Proprietary

Do not expose centroid vectors, mathematical formulations, or architecture details
to external APIs. All compute is local and airgapped.
