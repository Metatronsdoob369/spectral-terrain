# NAICS Industry Agent — Sell Path (Step 5)

## What it is

A silence-first **industry map accessory** any agent can mount.

- **Fuel:** sealed NAICS 2022 3-D pack (20 official sectors)
- **Not:** DNA extraction, LLM freestyle, or a medical/legal product
- **Job:** tell industries apart from processed data — or stay silent

WhiteGlove (or any husk) is the **carrier**. This pack is an **accessory**. Hydra `holder_naics` is the **money path** that already consumes the same taxonomy.

## Demo (90 seconds)

```bash
# Hit — life insurance → Sector 52 + neighbors
conda run -n agents python spectral-terrain/scripts/naics_agent.py --prose "life insurance"

# Silence — out of corpus
conda run -n agents python spectral-terrain/scripts/naics_agent.py --prose "banana pudding recipe"

# Pack tools (JSON for agents)
conda run -n agents python spectral-terrain/scripts/query_naics.py resolve "commercial banking"
conda run -n agents python spectral-terrain/scripts/query_naics.py near 52 5
conda run -n agents python spectral-terrain/scripts/query_naics.py list
```

Pi Qdrant collection (optional remote): `naics-heatmap-3` (dim=3, 20 points).

## Why buyers care

| Buyer | Pitch |
| --- | --- |
| Unclaimed-property / estate ops | Holder industry graded into lead score (already live in Hydra) |
| Compliance / procurement agents | Canonical sector map without hallucinated NAICS codes |
| Silence-first husks | Mount industry accessory; refuse when the map doesn't know |

## What ships

| Artifact | Path |
| --- | --- |
| Sealed pack | `spectral-terrain/store/naics-2022-3d.pack.json` |
| Sector shards | `NODE_OUT_Master/book-pipeline/library/new/export/naics-2022-sectors-20260726/` |
| Query surface | `spectral-terrain/scripts/query_naics.py` |
| Demo agent | `spectral-terrain/scripts/naics_agent.py` |
| Domain registry | `Whiteglove/spectral-config/config/domains.config.ts` → `naics-2022` |
| Hydra overlay | `property-hydra/agents/overlay_holder_naics.py` + scorer write-back |

## Deliberately out of scope

- DNA / voice-intent extraction on NAICS
- 1024-D chunk ingest for this taxonomy
- Selling WhiteGlove-as-medical (corpus is ballast; husk is the product)

## Next commercial move

1. Record the 90s demo (hit + silence).
2. Package `naics_agent` + pack as a mountable accessory SKU.
3. Offer with Hydra lead grades **or** as a WhiteGlove accessory mount — same fuel, different vehicle.
