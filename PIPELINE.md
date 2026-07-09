# Spectral Terrain Pipeline & Unified Domain Architecture

This document consolidates the refinement stages, constraints, and locked decisions for the Spectral Terrain ecosystem (specifically covering the finance-crypto domain).

**Use this file as context at the top of any session.**

---

## Refinement Stages

The pipeline transforms raw domain state into geometric terrain that an agent can navigate offline to build "instincts".

### 1. Shatter / Chunking (Data Preparation)
* **Takes in:** Raw API/domain state (e.g., Uniswap v3/v4 pool snapshots, Polymarket CLOB, or raw HTML/text).
* **Puts out:** `FinancialStateRecord` containing structured prose text designed specifically for natural language embedders, or semantically split chunks.
* **Code Location:** `scripts/fetch-finance-snapshot.ts` (fetchers) & `domains/finance-crypto-serialize.ts` (serializer).
* *Note: The term "Shatter" is overloaded. In this ingest stage, it refers to breaking raw data into semantic chunks (e.g., `brain/indexer/rechunk_medical.py` writing to the `shattered/` directory). Later in the pipeline (Calibration/Navigation), "Shatter" refers to the geometric shatter-score (Euclidean distance from a centroid).*

### 2. Embed
* **Takes in:** The structured prose representing `t_now`, `t_minus1`, and `t_plus1`.
* **Puts out:** Local embeddings (e.g., 3 × 1024-D via `mxbai-embed-large` or 768-D via `nomic-embed-text`).
* **Code Location:** Orchestrated via `scripts/refinery-finance.ts` (for the husk path, see `scripts/ingest_husk.py`).

### 3. Temporal Prediction (t+1)
* **Takes in:** The `t_now` and `t_minus1` states.
* **Puts out:** The projected `t_plus1` state (in v1.0, this is a linear delta extrapolation/mirror; v1.1 targets a learned residual model).
* **Code Location:** `domains/finance-crypto-tplus1.ts`.

### 4. REFRAG (Spatial Compression)
* **Takes in:** Raw high-dimensional embeddings (e.g., 1024-D or 3072-D concatenated vectors).
* **Puts out:** A spatially compressed vector (select-k width reduction). This is where the 640-D finance target (512-D base + 128-D delta) lives.
* **Code Location:** `brain/indexer/refrag-compressor.ts`.

### 5. Temporal-Concat
* **Takes in:** Individual embeddings for the timeline (`t_minus1`, `t_now`, `t_plus1`).
* **Puts out:** A concatenated 3072-D `TemporalVector` (e.g., `[v_t-1 | v_t | v_t+1]`).
* **Code Location:** `scripts/refinery-finance.ts` & defined in `contracts/terrain.contract.ts`.

### 6. Spectral Map (Calibration)
* **Takes in:** Raw temporal vectors in the Qdrant collection.
* **Puts out:** Geometric scores: a Diamond-Stable centroid, shatter scores (Euclidean distance from centroid), and heat (Manhattan resonance Σ|v[i]|). 
* **Code Location:** `engine/calibrate.ts`.

### 7. Terrain Pack
* **Takes in:** Finalized state points for the current cycle.
* **Puts out:** A BLAKE2b signed terrain pack (`.jsonl` and `.sig` or `.tar.gz`) stored offline.
* **Code Location:** `scripts/refinery-finance.ts`.

### 8. Circadian Navigation (Instinct Formation)
* **Takes in:** The BLAKE2b signed terrain pack from yesterday.
* **Puts out:** Agent instinct weights (`active-instinct.json`) formed by finding entry points (lowest-shatter) and navigating toward high-heat, low-shatter zones.
* **Code Location:** `engine/circadian.ts` & `engine/navigate-finance.ts`.

---

## Decided but Scattered (Do Not Re-Litigate)

The following architectural decisions are locked. They have been decided in various design docs, implementation plans, and tests:

1. **Finance Dimensionality Target:** The ultimate target for `finance-crypto` is 640-D (512-D base + 128-D delta). The current 3072-D implementation is for v1.0 compatibility with `terrain.contract.ts` only.
2. **Embed Model Cutover:** The legal/heatmap cutover from 1024-D (`mxbai-embed-large`) to 768-D (`nomic-embed-text`) is built, verified, and flag-gated via the `NOMIC_768_PRIMARY` environment variable (changes both active collection and active embed dimension).
3. **Local Embedding Constraint:** All embedding strictly routes through local Ollama (`http://127.0.0.1:11434`). External embedding APIs are prohibited.
4. **No Live Navigation:** The capital agent **never** navigates live terrain. It navigates yesterday's BLAKE2b signed pack overnight. Live capital decisions read the resulting offline instinct weights, not the terrain itself.
5. **Execution Architecture:** The refinery is a scheduled script (LaunchAgent at 00:30), *not* a daemon. It runs once per circadian cycle, processes the daily delta, packs it, and exits.
6. **Domain Separation:** The terrain engine is strictly domain-agnostic. All domain-specific knowledge (what a liquidity pool is, how to parse it) is isolated in `domains/finance-crypto/`.
7. **Canonical Finance Points:** A financial pool state is considered "canonical" only if it is observed across ≥5 daily snapshots, maintains a shatter score < 0.05 relative to the rolling centroid, and has no CVE flags.
8. **Static vs Temporal Geometry Enforcement:** Temporal 3072-D geometry (`[v_t-1 | v_t | v_t+1]`) is ONLY used for domains with state progression (e.g., `roblox-luau`, `finance-crypto`). Static domains (`source-audit`, `general`, `memory`, `reddit`) strictly use a single 1024-D vector. This is a contract rule, not a configuration preference.
