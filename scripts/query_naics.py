#!/usr/bin/env python3
"""
query_naics.py — Agent query surface for the sealed NAICS 2022 3-D pack.

No DNA. No LLM. Pack-first (offline). Optional Qdrant for remote smoke.

Commands:
  list                 — all 20 sectors by heat
  get <sector|title>   — one sector (exact code or substring title)
  near <sector> [k]    — cosine neighbors in display 3-D
  resolve <text>       — map free text → sector or silence

Exit 0 on hit, 2 on silence (no match). JSON on stdout.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from pathlib import Path
from typing import Any

PACK_DEFAULT = Path("/Users/joewales/spectral-terrain/store/naics-2022-3d.pack.json")
QDRANT = os.environ.get("QDRANT_URL", "http://100.113.215.46:6333")
COLLECTION = "naics-heatmap-3"


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def load_pack(path: Path) -> dict[str, Any]:
    pack = json.loads(path.read_text(encoding="utf-8"))
    if pack.get("schema") != "naics_terrain_pack.v1":
        raise SystemExit(f"unexpected pack schema: {pack.get('schema')}")
    return pack


def silence(reason: str) -> int:
    print(json.dumps({"ok": False, "silence": True, "reason": reason}, indent=2))
    return 2


def hit(payload: dict[str, Any]) -> int:
    print(json.dumps({"ok": True, "silence": False, **payload}, indent=2))
    return 0


def find_sector(points: list[dict[str, Any]], key: str) -> dict[str, Any] | None:
    key = key.strip()
    for p in points:
        if p["naics_sector"] == key:
            return p
    low = key.lower()
    matches = [p for p in points if low in p["title"].lower()]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        # Prefer exact sector word after dash
        for p in matches:
            if low in p["title"].split("—", 1)[-1].lower():
                return p
        return matches[0]
    return None


def public_point(p: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": p["id"],
        "naics_sector": p["naics_sector"],
        "title": p["title"],
        "heat": round(float(p["heat"]), 4),
        "coords_3d": [round(float(x), 6) for x in p["coords_3d"]],
    }


def cmd_list(pack: dict[str, Any]) -> int:
    pts = sorted(pack["points"], key=lambda p: -float(p["heat"]))
    return hit(
        {
            "command": "list",
            "domain": pack["domain"],
            "geometry": pack["geometry"],
            "blake2b_16": pack.get("blake2b_16"),
            "sectors": [public_point(p) for p in pts],
        }
    )


def cmd_get(pack: dict[str, Any], key: str) -> int:
    p = find_sector(pack["points"], key)
    if not p:
        return silence(f"no NAICS sector matched {key!r}")
    return hit({"command": "get", "sector": public_point(p)})


def cmd_near(pack: dict[str, Any], key: str, k: int) -> int:
    anchor = find_sector(pack["points"], key)
    if not anchor:
        return silence(f"no NAICS sector matched {key!r}")
    scored = []
    for p in pack["points"]:
        if p["id"] == anchor["id"]:
            continue
        scored.append((cosine(anchor["coords_3d"], p["coords_3d"]), p))
    scored.sort(key=lambda t: -t[0])
    neighbors = [
        {**public_point(p), "score": round(s, 4)} for s, p in scored[:k]
    ]
    return hit(
        {
            "command": "near",
            "anchor": public_point(anchor),
            "neighbors": neighbors,
        }
    )


def cmd_resolve(pack: dict[str, Any], text: str) -> int:
    """
    Map free text → sector via code extract or title token overlap.
    Silence if confidence is too weak — Faith-Less for industry labels.
    """
    text = text.strip()
    if not text:
        return silence("empty query")

    # Direct 2-digit sector or 6-digit code prefix
    m = re.search(r"\b(\d{2})\d{0,4}\b", text)
    if m:
        sector = m.group(1)
        # NAICS sectors that are not contiguous 2-digit (31-33, 44-45, 48-49)
        special = {
            "31": "31-33",
            "32": "31-33",
            "33": "31-33",
            "44": "44-45",
            "45": "44-45",
            "48": "48-49",
            "49": "48-49",
        }
        key = special.get(sector, sector)
        p = find_sector(pack["points"], key)
        if p:
            return hit(
                {
                    "command": "resolve",
                    "method": "code",
                    "query": text,
                    "sector": public_point(p),
                }
            )

    tokens = {t for t in re.findall(r"[a-z0-9]+", text.lower()) if len(t) > 2}
    stop = {"the", "and", "for", "sector", "industry", "naics", "with", "from"}
    tokens -= stop
    if not tokens:
        return silence("no usable tokens")

    best: list[tuple[float, dict[str, Any]]] = []
    for p in pack["points"]:
        title_toks = set(re.findall(r"[a-z0-9]+", p["title"].lower()))
        overlap = tokens & title_toks
        if not overlap:
            continue
        score = len(overlap) / len(tokens)
        best.append((score, p))
    best.sort(key=lambda t: -t[0])
    if not best or best[0][0] < 0.34:
        return silence(f"no confident sector for {text!r}")
    # Ambiguous top-2 within 0.05 → silence rather than guess
    if len(best) > 1 and best[0][0] - best[1][0] < 0.05 and best[1][0] >= 0.34:
        return silence(
            f"ambiguous between {best[0][1]['naics_sector']} and {best[1][1]['naics_sector']}"
        )
    return hit(
        {
            "command": "resolve",
            "method": "title-overlap",
            "query": text,
            "confidence": round(best[0][0], 3),
            "sector": public_point(best[0][1]),
        }
    )


def cmd_qdrant_near(sector: str, k: int, qdrant: str) -> int:
    import requests

    pack = load_pack(PACK_DEFAULT)
    anchor = find_sector(pack["points"], sector)
    if not anchor:
        return silence(f"no NAICS sector matched {sector!r}")
    base = qdrant.rstrip("/")
    r = requests.post(
        f"{base}/collections/{COLLECTION}/points/search",
        json={"vector": anchor["coords_3d"], "limit": k + 1, "with_payload": True},
        timeout=30,
    )
    r.raise_for_status()
    hits = []
    for h in r.json()["result"]:
        pl = h["payload"]
        if pl.get("naics_sector") == anchor["naics_sector"]:
            continue
        hits.append(
            {
                "naics_sector": pl.get("naics_sector"),
                "title": pl.get("title"),
                "heat": pl.get("heat"),
                "score": round(float(h["score"]), 4),
            }
        )
        if len(hits) >= k:
            break
    return hit(
        {
            "command": "qdrant-near",
            "collection": COLLECTION,
            "anchor": public_point(anchor),
            "neighbors": hits,
        }
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="NAICS 3-D pack agent query (silence-first)")
    ap.add_argument("--pack", default=str(PACK_DEFAULT))
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list")
    g = sub.add_parser("get")
    g.add_argument("key")
    n = sub.add_parser("near")
    n.add_argument("key")
    n.add_argument("k", nargs="?", type=int, default=5)
    r = sub.add_parser("resolve")
    r.add_argument("text", nargs="+")
    q = sub.add_parser("qdrant-near")
    q.add_argument("key")
    q.add_argument("k", nargs="?", type=int, default=5)
    q.add_argument("--qdrant", default=QDRANT)

    args = ap.parse_args()
    pack = load_pack(Path(args.pack))

    if args.cmd == "list":
        return cmd_list(pack)
    if args.cmd == "get":
        return cmd_get(pack, args.key)
    if args.cmd == "near":
        return cmd_near(pack, args.key, args.k)
    if args.cmd == "resolve":
        return cmd_resolve(pack, " ".join(args.text))
    if args.cmd == "qdrant-near":
        return cmd_qdrant_near(args.key, args.k, args.qdrant)
    return silence(f"unknown command {args.cmd}")


if __name__ == "__main__":
    raise SystemExit(main())
