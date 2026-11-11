# spectral-map — the repo's own history as terrain

Prototype spectral map: every code file (`.ts/.py/.lua`) at every commit, embedded with the
**same 5-D structural provider as `engine/embed.ts`** (`structuralFingerprint`: size, complexity
hash, structure, definition density, coupling). Commit order is a geometric axis, not metadata,
so the result is a cube `[file × band × commit]` plus observed `[v_t-1 | v_t | v_t+1]` triplets.

```
python3 spectral-map/build_spectral_map.py   # rebuild everything into spectral-map/out/
spectral-map/load_qdrant.sh                  # upsert into Qdrant (default http://127.0.0.1:6333)
```
Requires `numpy pandas matplotlib plotly`. The Python port of the fingerprint reproduces the
TS hash recurrence (`Math.imul(31,h)+c|0` over UTF-16 code units) and is asserted against
Java `String.hashCode` test vectors at startup.

## Outputs (`out/`)

| file | for | contents |
|---|---|---|
| `spectral_terrain_viewer.html` | humans | 3-D terrain: PCA of the 5-D vectors, height = commit. Static file = vertical pillar, mutation = kink. Click a point → its t−1/t/t+1 spectrum. Button drops the hash band. Offline (plotly inlined). |
| `spectral_map_overview.png` | humans | (a) false-colour spectrum per file over time, (b) mutation energy map, (c) shatter bands, (d) per-band share of mutation energy |
| `spectral_cube.npz` | agents | `raw`, `normalized` `[F,5,K]`, `shatter` `[F,K]`, `triplets` `[F,15,K-2]`, `centroid`, labels |
| `spectral_cube_long.csv` | spreadsheets | one row per file-state: bands (raw + normalized), heat, shatter, band, mutated flag |
| `qdrant_points_5d.json` | Qdrant `spectral-git-history-5` | 5-D L2-normalized, cosine |
| `qdrant_points_4d_centred.json` | Qdrant `spectral-git-history-4c` | hash band dropped, standardized against HEAD, cosine; payload adds `z_distance` |
| `centring_transform_4d.json` | querying 4c | band means/SDs at HEAD — apply to new code before querying |
| `summary.json` | — | headline numbers below |

Point ids are `uuid5(URL, "spectral-terrain:<path>@<full sha>")` — identical across both
collections and stable across rebuilds.

## Findings at HEAD `b03947a` (25 commits, 83 files, 1,603 file-states)

- **Commit-time is mostly static.** Only 24 of 1,520 file-steps mutate; 97.1 % of observed
  commit-indexed triplets are `[v|v|v]` — the degeneracy `terrain.contract.ts` forbids, reproduced
  by *real* history. Event-time (index each file by its own versions) removes it but yields only
  13 non-degenerate triplets today (7 files have ≥ 3 versions).
- **The complexity-hash band (d2) carries 82.5 % of mutation energy.** It is a hash, so any edit
  jumps it uniformly in [0,1): temporal movement in 5-D is mostly hash noise.
- **2-D PCA captures most of the geometry.** PC1+PC2 explain 90.6 % of variance across all
  file-states with all 5 bands (PC1 79.7 %), and 97.6 % with the hash band dropped (PC1 85.9 %)
  — the two projections offered by the viewer's buttons.
- **Raw cosine is compressed.** All bands are positive log-counts, so 5-D cosine scores sit in
  ≈ 0.95–0.998. Centring + standardizing (collection `-4c`) spreads them to ≈ −0.98–0.99.
- **Ranking is band-sensitive.** `engine/ingest.ts`@HEAD's nearest other-file state is
  `engine/watchdog.ts`@#11–12 in 5-D (rank 1–2), rank 10 with the hash dropped, rank 56 once
  centred. In `-4c` its nearest are `scripts/experiment_naics_lowdim.py`@HEAD (0.9977) and the
  *original* (#0–16) version of `contracts/terrain.contract.ts` (0.9976) — a match that only
  exists because past states are kept as points.
- **Shatter at HEAD:** 3 ANCHOR / 72 REVIEW / 8 ALARM against the repo's own HEAD centroid (not a
  calibrated domain centroid; values span only 0–0.18, so the 0.05/0.15 bands may not transfer).

Note: the scan excludes `spectral-map/` itself, but each new commit adds a time slice, so a
rebuild after committing has K = 26 and shifts triplets/percentiles slightly; existing point ids
and vectors are unchanged.
