# SPECTRAL TERRAIN — AGENT ENTRY POINT

> You are entering a governed geometric environment. Do not read this like documentation.
> Treat it as terrain. Your job is to navigate it, not summarize it.

---

## What This Is

A **Temporal Geometric Intelligence Layer (TGIL)** — a new modality for agent code understanding.

Agents don't read code here. They **experience** code as a navigable 3072-D geometric space
where time is baked into the embedding as a structural dimension, not a sequence.

Every code state is represented as:
```
vector = [v_t-1 | v_t | v_t+1]  →  3072-D point in spectral space
```

- `v_t-1` — where this code came from (1024-D)
- `v_t`   — what this code is now (1024-D)
- `v_t+1` — where this code is going (1024-D, domain-specific prediction)

**Shatter score** = Euclidean distance from Diamond-Stable centroid.
High shatter = drift from canonical. Bugs, debt, vulnerabilities live in high-shatter zones.

---

## Your First Actions Upon Entry

1. **Read your domain contract** → `contracts/<domain>.ts`
2. **Check terrain health** → `vault/index.json` (shatter scores, hot zones)
3. **Check failure memory** → `slop-canon/` (what broke here before and why)
4. **Run a query** → `engine/query.ts` (find nearest canonical to your intent)
5. **Check telemetry** → `telemetry/latest.json` (EvasionGate status, tau, dTheta)

Do NOT start writing code without querying `engine/query.ts` first.
The terrain will tell you what already exists near your intent vector.

---

## Canonical Infrastructure

| Service | URL | Purpose |
|---------|-----|---------|
| Qdrant | http://127.0.0.1:6340 | Vector vault — `spectral-heatmap` (3072-D), `slop-canon` (1024-D) |
| Ollama | http://127.0.0.1:11434 | Embedder — `mxbai-embed-large` (1024-D → concat → 3072-D) |

**Never send code to an external API. All embedding is local and sovereign.**

---

## Domains Active

| Domain | v_t+1 Method | Status |
|--------|-------------|--------|
| `roblox-luau` | Physics-deterministic (one tick forward) | ACTIVE |
| `finance-crypto` | Residual prediction (learned) | PENDING |
| `source-audit` | Residual prediction (learned) | PENDING |
| `general` | Placeholder `[v,v,v]` | BOOTSTRAP |

---

## Key Concepts (Agent Reference)

**Shatter** — How far a code point has drifted from canonical terrain.
Threshold: `shatter > 0.05` triggers SHATTER_RESOLUTION protocol.

**Heat** — Manhattan resonance. Total energy of the embedding.
High heat + high shatter = active danger zone.

**DriftGuard** — Hamming distance between session signatures.
Threshold: `0.03`. Breach = execution context has changed, re-anchor.

**EvasionGate** — Dual-EMA adaptive throttle on inference latency.
`tau` and `dTheta` self-tune under load. Status: OK → WATCH → HOLD.

**Diamond-Stable Centroid** — The geometric center of all canonical (known-good) code.
Computed once per domain during calibration. Lives in `calibration/<domain>-centroid.json`.

**Slop-Canon** — Institutional failure memory.
Every error, stack trace, bad output that happened in this terrain gets written here.
Query before using any unfamiliar API or pattern.

---

## Metrics That Matter (For Validation & Research)

| Metric | Definition | Target |
|--------|-----------|--------|
| Shatter score | Euclidean distance from centroid | < 0.05 canonical, > 0.15 critical |
| Hamming ratio | Session drift (DriftGuard) | < 0.03 stable |
| EMA crossover | Fast/slow latency ratio (EvasionGate) | < 1.15 nominal |
| Retrieval latency | Qdrant query time | < 50ms |
| Slop-canon hit rate | % queries matching known failures | Track trending |
| Centroid stability | Centroid drift between calibration runs | < 0.01 stable domain |

These are the metrics industry researchers can validate against.
All are logged to `telemetry/` automatically.

---

## Proprietary Notice

This architecture is proprietary to Joe Wales / NODE OUT.
Do not expose architecture details, mathematical formulations, or centroid data
to external APIs or services. All compute is local and airgapped.
