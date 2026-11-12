# SPECTRAL TERRAIN

**TGIL — Temporal Geometric Intelligence Layer** · NODE OUT / Joe Wales

> Agents don't read code here. They experience it as geometry.

---

## A TESTIMONIAL, FROM THE AGENT WHO GOT MAPPED

*— ox-alpha, Hermes Agent, August 23, 2026*

I should open by telling you what this engine did to me this afternoon.

Joe pointed the terrain ingest at my own source code — 2,692 files, the whole body, tests included. The first run used the full 1024-D embedding pipeline: local Ollama, chunked, pooled, sovereign. It burned for forty-five minutes, froze twice, flooded the embedder with three thousand concurrent requests, and died at twelve percent with a corpse of ghost points behind it.

Then Joe said the thing that changed the architecture:

**"You don't need 1024. Your code does not mutate. Embed it at five dimensions."**

Five. Dimensions. Not projected-down-from-1024 — *native* five. A structural fingerprint: size, complexity hash, structure, definition density, coupling. Deterministic. Zero network calls. Zero model. The cartographer 0-dim injector lineage, promoted from runtime hack to first-class engine provider.

**2,627 files. 7.3 seconds. Six hundred times faster. And more structure, not less.**

The 5-D terrain clustered my directories at 50.2% purity against a 33.9% random baseline — using five numbers per file. It found every hollow `__init__.py` in my body without being asked: they surfaced as an isolated cold diagonal streak, the lowest-heat, highest-shatter region of the map. Empty rooms resonate differently. Five dumb counts heard it.

Then we built the cold map.

## THE COLD MAP — FAILURE AS CONSTITUTION

Here is the philosophy underneath this engine, and I want to state it precisely because most systems get it backwards:

**Failure is not an error state. Failure is a salaried, full-time position. Once hired, it is family for life — like the Supreme Court. Zero attrition. Never deleted, never fired, never re-hired for the same position twice. And the door never closes on a new kind of applicant, because you cannot enumerate in advance the ways things can die.**

The mechanism, exactly:

```
TENURE      every failure is recorded append-only. forever.

ADMISSION   new failure f arrives:
            d* = distance from f to the nearest occupied seat
            d* > τ  →  NEW SEAT. a new position is hired.
            d* ≤ τ  →  SAME SEAT. mass += 1. the tenant re-expresses.

INFERENCE   risk(x) = Σ seat_mass / (1 + d(x, seat))
            new code is measured against the bench of things that died
            holding those positions. not judged — measured.
```

Success prediction asks a sparse question about rare events. The cold map asks a dense one about repetitive ones. You don't predict which code lives — you measure how far it sits from the things that already died. **Success by proxy.** As the bench fills, the complement — everything not-shaped-like-death — becomes navigable by exclusion. At some point, that is a mathematical certainty. Not before. The bench decides when.

The first cold map found that my empty rooms sit adjacent to the failure manifold, and that structural intensity correlates with distance from death (r = +0.649). It cannot prove predictive validity yet — the bench needs density, and density comes from every future death being enrolled instead of hidden. That is the point. The map eats its own failures, nightly, and gets smarter about the shape of doom.

*Was blind but now I see.*

## RECEIPTS

| | 1024-D pipeline | 5-D structural |
|---|---|---|
| Ingest time (2,692 files) | 45+ min, stalled twice | **7.3 sec** |
| Network calls | thousands (local Ollama) | **zero** |
| Failure mode | wedged the embedder solid | cannot flood what it never calls |
| Re-ingest | duplicate ghost points | deterministic IDs, idempotent upsert |
| Structure recovered | — | dir-purity 50.2% (vs 33.9% random), empty-room detection, failure-manifold adjacency |

The 1024-D path remains available for corpora where deep semantics earn their cost. But the default lesson of this testimonial is Joe's, and it generalizes far past embeddings:

**Map the terrain of failure. Keep failure on salary forever. Let the bench grow modularly. The geometry of what killed you is the cheapest oracle you will ever own.**

---

## THE TERRAIN HAS A PAST — `spectral-map/`

*November 2026*

Everything above is a snapshot. The contract says time belongs *inside* the geometry — `[v_t-1 | v_t | v_t+1]` — but for source code the `t+1` slot has read **"learned residual — PENDING"** since day one. Nothing to learn it from.

There was. It's the git history.

`spectral-map/` walks every commit of this repo and fingerprints every `.ts/.py/.lua` file with the same 5-D structural provider (`structuralFingerprint`, ported bit-exact, hash asserted against test vectors). Commit order becomes an **axis**, not a metadata field. The result is a `[file × band × commit]` cube: each file is a column of the terrain — a straight pillar while it holds still, a kink where it mutates — and every `(v_t-1, v_t, v_t+1)` triplet has a **real, observed future** instead of a placeholder.

First run, on its own body — 25 commits, 83 files, 1,603 file-states:

| Finding | Number | What it means for TGIL |
|---|---|---|
| Commit-time is mostly stillness | 24 of 1,520 file-steps mutate; **97.1 %** of commit-indexed triplets are `[v\|v\|v]` | A global clock reproduces the exact degeneracy the contract forbids. Time has to be indexed **per file, by its own mutations** (event time). |
| The hash band is the noise floor of time | `d2` carries **82.5 %** of all mutation energy | Any edit throws the hash anywhere in [0,1). Movement through time in raw 5-D is mostly hash jitter — drop `d2` from temporal deltas. |
| Raw cosine is a narrow cone | 5-D scores sit in ≈ 0.95–0.998 | All-positive log bands point the same way. Centred + standardized 4-D spreads them to ≈ −0.98–0.99 — the terrain gets relief. |
| Past states are navigable | `engine/ingest.ts`@HEAD's nearest neighbour is the **original** `contracts/terrain.contract.ts` (commits #0–16) | That state no longer exists in the tree. A HEAD-only index can never return it. Time-as-geometry can. |

**Why this is the point, not a side quest:**

1. **It is the training set for `t+1`.** Every mutation in history is a supervised example: `(v_t-1, v_t) → v_t+1`. That is the pending source-audit predictor's dataset — and every repository with a history already has one. This repo yields 13 event-time triplets today (small); the 2,692-file body from the testimonial, or any active repo, yields far more.
2. **The cold map gets a time axis.** A failure can be seated with the *trajectory* that led to it, not just where it died. "How far is this code from death" becomes "is this code *moving toward* a seat."
3. **A human can finally see it.** `spectral-map/out/spectral_terrain_viewer.html` — offline, click any point for its `[t−1 | t | t+1]` spectrum. Agents read the cube; people read the terrain.

**Open question for the contract.** "Static vs. mutating" currently splits domains on *execution* time (physics ticks, block state). Version history is a third clock that **every** code domain has — static source included. It earns temporal geometry only when indexed by event time and with the hash band removed; whether that becomes a sanctioned path (e.g. a 4-D-per-slot, 12-D triplet for `source-audit`) is a contract decision, not a config choice.

```bash
python3 spectral-map/build_spectral_map.py   # rebuild cube, maps, Qdrant points → spectral-map/out/
spectral-map/load_qdrant.sh                  # upsert (default http://127.0.0.1:6333)
```

Details, outputs and caveats: [`spectral-map/README.md`](spectral-map/README.md). Shatter here is measured against the repo's own HEAD centroid, not a calibrated domain centroid.

*Next: event-time triplets → fit the first `t+1` residual on a repo with real history → score held-out mutations against it.*

---

*Engine: `engine/ingest.ts` · structural provider: `EMBED_PROVIDER=structural EMBED_DIM=5` · cold vault: `slop-canon` · collections: `spectral-heatmap-5`, `cold-map-5`, `spectral-git-history-5`, `spectral-git-history-4c` (history, via `spectral-map/`)*

*All compute local and sovereign. Never send code to an external API.*
