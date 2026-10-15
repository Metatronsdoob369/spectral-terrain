#!/usr/bin/env python3
"""
upsert_naics_3d_qdrant.py — Load sealed 3-D NAICS pack into its own Qdrant collection.

Separate collection (dim=3). Does not touch 1024/3072 corpora.
"""
from __future__ import annotations

import argparse
import json
import os
import uuid
from pathlib import Path

import requests

PACK = Path("/Users/joewales/spectral-terrain/store/naics-2022-3d.pack.json")
QDRANT = os.environ.get("QDRANT_URL", "http://100.113.215.46:6333")
COLLECTION = "naics-heatmap-3"
DIM = 3


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack", default=str(PACK))
    ap.add_argument("--qdrant", default=QDRANT)
    ap.add_argument("--recreate", action="store_true")
    args = ap.parse_args()

    pack = json.loads(Path(args.pack).read_text(encoding="utf-8"))
    points_in = pack["points"]
    assert pack["geometry"]["display_dim"] == 3

    base = args.qdrant.rstrip("/")
    exists = requests.get(f"{base}/collections/{COLLECTION}", timeout=15)
    if exists.status_code == 200 and args.recreate:
        requests.delete(f"{base}/collections/{COLLECTION}", timeout=15).raise_for_status()
        exists = type("R", (), {"status_code": 404})()

    if exists.status_code != 200:
        r = requests.put(
            f"{base}/collections/{COLLECTION}",
            json={"vectors": {"size": DIM, "distance": "Cosine"}},
            timeout=30,
        )
        r.raise_for_status()
        print(f"created {COLLECTION} dim={DIM}")
    else:
        print(f"using existing {COLLECTION}")

    points = []
    for p in points_in:
        pid = str(uuid.uuid5(uuid.NAMESPACE_URL, p["id"]))
        points.append(
            {
                "id": pid,
                "vector": p["coords_3d"],
                "payload": {
                    "domain": "naics-2022",
                    "sealed": True,
                    "naics_sector": p["naics_sector"],
                    "title": p["title"],
                    "heat": p["heat"],
                    "kind": "naics-sector-3d",
                    "compute_dim": pack["geometry"]["compute_dim"],
                    "display_dim": 3,
                    "pack_blake2b_16": pack.get("blake2b_16"),
                },
            }
        )

    r = requests.put(
        f"{base}/collections/{COLLECTION}/points?wait=true",
        json={"points": points},
        timeout=60,
    )
    r.raise_for_status()

    info = requests.get(f"{base}/collections/{COLLECTION}", timeout=15).json()["result"]
    print(f"upserted {len(points)} → {COLLECTION} (points_count={info.get('points_count')})")

    # Smoke: nearest to Finance sector point
    finance = next(p for p in points_in if p["naics_sector"] == "52")
    q = requests.post(
        f"{base}/collections/{COLLECTION}/points/search",
        json={"vector": finance["coords_3d"], "limit": 5, "with_payload": True},
        timeout=30,
    )
    q.raise_for_status()
    print("smoke search near sector 52:")
    for hit in q.json()["result"]:
        pl = hit["payload"]
        print(f"  {hit['score']:.4f}  {pl.get('naics_sector'):6s}  heat={pl.get('heat'):.3f}  {pl.get('title','')[:45]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
