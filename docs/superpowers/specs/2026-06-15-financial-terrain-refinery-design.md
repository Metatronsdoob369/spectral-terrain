# Financial Terrain Refinery — Design Spec

**Date:** 2026-06-15
**Author:** Joe Wales / NODE OUT
**Status:** Approved for implementation planning
**Domain:** `finance-crypto` (defined in `terrain.contract.ts`, currently PENDING)

---

## The Core Idea

This is not a signal system. It is not a live trading feed. It is an **instinct formation layer**.

Raw financial state (liquidity pools, Polymarket CLOB snapshots) enters a refinery. The refinery produces signed terrain packs. The capital agent navigates those packs overnight in a circadian cycle. By the time live decisions are made, the agent is not querying terrain — it is *acting from geometry it has already internalized*.

The analogy that holds: the Roblox-Luau domain gave an agent geometric self-knowledge of game code. This domain gives the capital agent geometric self-knowledge of market structure. The terrain doesn't tell it what to do. It shapes what the agent already knows to be true.

---

## What This Is Not

- Not a live market data feed
- Not a real-time decision system
- Not a replacement for execution logic (WeaponsGradeAMEM handles quoting)
- Not fine-tuning — cleaner than fine-tuning in non-hypercompetitive environments because the geometry is navigable, auditable, and doesn't require gradient descent

---

## Separation of Concerns (Non-Negotiable)

The terrain engine is **domain-agnostic**. It receives vectors and produces geometry. It does not know what a liquidity pool is.

The refinery is **domain-specific**. It knows what a liquidity pool is, how to normalize it, and how to compute the temporal delta. It does not touch the terrain engine's internals.

```
[Market Data APIs]
       │
       ▼
[Financial Refinery]          ← NEW — this spec
  normalize → embed → delta
       │
       ▼
[Terrain Pack (.tar.gz)]
       │
       ▼
[Spectral Terrain Engine]     ← EXISTING — unchanged
  FAISS, centroid, shatter
       │
       ▼
[Circadian Agent Navigation]  ← EXISTING — extended for finance-crypto domain
  overnight, signed, gated
```

---

## Dimensionality Decision

The existing `terrain.contract.ts` defines `finance-crypto` as 3072-D (`[v_t-1 | v_t | v_t+1]`). This is the current contract. However, the recognized reality is:

- 1024-D was designed for text (`mxbai-embed-large` output)
- Financial state vectors have different manifold structure than text
- Concatenating three 1024-D text embeddings to "include time" is brute force

**Target architecture (to be validated in v1.1):**
- **512-D base**: financial state (pool reserves, fee tier, volume, spread, depth)
- **128-D delta**: rate and direction of change — computed as a learned compression, not a raw difference
- **Total: 640-D per point** — stored in a new Qdrant collection `finance-heatmap-640`

**For v1.0 (this build):** Use the existing 3072-D contract to stay compatible with terrain.contract.ts. Instrument collection sizes and centroid stability. The 640-D revision is a Phase 2 calibration decision with data to back it — not an assumption.

---

## Refinery Architecture

### Input Sources (v1.0)
1. **Uniswap v3/v4 subgraph** — pool state snapshots (reserves, fee tier, tick, volume 24h)
2. **Polymarket CLOB snapshots** — YES/NO price, spread, open interest, volume

### Normalization
Each source produces a **FinancialStateRecord**:
```typescript
{
  domain: "finance-crypto",
  source: "uniswap-v3" | "polymarket-clob",
  pool_id: string,            // deterministic identifier
  timestamp: number,          // unix seconds
  state: {                    // normalized 0-1 or log-scaled
    price: number,
    liquidity: number,
    volume_24h: number,
    spread: number,
    depth_bid: number,
    depth_ask: number,
  },
  raw: object,                // original API response, stored for audit
}
```

### Embedding Strategy
1. Serialize `state` fields into a structured text description (not raw JSON — structured prose that `mxbai-embed-large` embeds meaningfully)
2. Embed `t_now` (current state) → 1024-D via local Ollama
3. Load `t_minus1` from previous terrain pack for same `pool_id`
4. Compute `t_plus1` via residual prediction (v1.0: mirror of delta direction; v1.1: learned model)
5. Concatenate → 3072-D TemporalVector per terrain.contract.ts

### Temporal Delta (the part that makes this different from text)
The delta between `t_minus1` and `t_now` is not discarded — it is the dimensional signal. A pool whose reserves shifted 40% in 24h occupies different terrain than one that drifted 0.3%. The shatter score of the delta itself is a first-class metric.

---

## Circadian Integration

The existing `engine/circadian.ts` runs nightly hardening for all active domains. The financial refinery plugs in as a pre-circadian step:

```
[00:00] financial-refinery runs
  → fetches today's snapshots
  → produces terrain pack: finance-heatmap-YYYY-MM-DD.tar.gz
  → BLAKE2b signs pack

[01:00] circadian.ts runs (existing)
  → loads new finance pack
  → recalibrates finance-crypto centroid
  → recomputes shatter distribution
  → writes profile to calibration/finance-crypto-profile.json

[02:00] capital agent navigates updated terrain
  → enters via low-shatter canonical pools (known-stable)
  → routes toward high-heat, low-shatter zones (dense + stable = opportunity geometry)
  → records path as instinct weight update
  → exits — never navigates live
```

---

## What "Canonical" Means for Finance

This is an open research question — nobody has defined Diamond-Stable centroids for financial terrain because nobody has built financial terrain this way.

**Working definition for v1.0:** A pool state is canonical if:
- It has been observed across at least 5 daily snapshots
- Its shatter score relative to the rolling centroid stays below 0.05 for those 5 days
- It has not been flagged by the Pi/Nuclei CVE scanner as a vulnerable protocol

This is conservative and deliberately so. The centroid will initially be sparse. That is correct behavior — the agent should start with a small, high-confidence canonical region and let it grow through observed stability, not through volume of ingested data.

---

## Self-Knowledge Extension (Future Domain)

The insight that generalizes this architecture: **any system with version history can be terrain**.

Source code with git history has `v_t-1` (previous commit), `v_t` (current), and a computable `v_t+1` direction. An agent given its own source code as navigable terrain — not as a string to read, but as geometry to navigate — would locate its own structural brittleness (high-shatter zones), its dense capability regions (high-heat, low-shatter), and could write defense protocols from geometric self-knowledge rather than prompted introspection.

This is a separate domain (`source-audit` or a new `self-model` domain). It is noted here because the financial refinery build is the pattern that proves the approach before applying it to something as consequential as agent self-modeling.

---

## Build Order

| Phase | Deliverable | Location |
|-------|-------------|----------|
| P1 | `FinancialStateRecord` type + normalizers for Uniswap + Polymarket | `spectral-terrain/domains/finance-crypto/` |
| P2 | Refinery script: fetch → normalize → embed → pack | `spectral-terrain/scripts/refinery-finance.ts` |
| P3 | `t_plus1` residual predictor (v1.0: delta mirror) | `spectral-terrain/engine/finance-crypto-tplus1.ts` |
| P4 | Circadian integration: pre-step hook in `circadian.ts` | `spectral-terrain/engine/circadian.ts` (extend) |
| P5 | Calibration run: first centroid for `finance-crypto` domain | `spectral-terrain/calibration/finance-crypto-centroid.json` |
| P6 | Capital agent navigation loop (overnight, signed, gated) | `spectral-terrain/engine/navigate-finance.ts` |

---

## Constraints

- All embedding is local — `mxbai-embed-large` via Ollama on Pi or Mac. No external embedding APIs.
- Terrain packs are BLAKE2b signed before the circadian layer loads them.
- The capital agent **never** navigates live terrain. It navigates yesterday's signed pack.
- The refinery is a scheduled script, not a daemon. It runs once per circadian cycle and exits.
- Financial domain logic lives entirely in `domains/finance-crypto/`. The engine stays agnostic.
