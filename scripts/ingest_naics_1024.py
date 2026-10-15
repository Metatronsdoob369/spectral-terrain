#!/usr/bin/env python3
"""
ingest_naics_1024.py — Sealed NAICS domain → naics-heatmap-1024

Static geometry only (contract: memory-class / no temporal concat).
Reads sector JSON shards from book-pipeline export, chunks, embeds with
local mxbai-embed-large (1024-D), upserts to a dedicated Qdrant collection.

Does NOT touch law-heatmap, spectral-heatmap (3072), medical, or finance packs.

Usage:
    python3 scripts/ingest_naics_1024.py
    python3 scripts/ingest_naics_1024.py --dry-run
    python3 scripts/ingest_naics_1024.py --limit-sectors 5
    QDRANT_URL=http://127.0.0.1:6333 python3 scripts/ingest_naics_1024.py
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import requests

QDRANT_URL = os.environ.get("QDRANT_URL", os.environ.get("QDRANT_PI_URL", "http://100.113.215.46:6333"))
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
EMBED_MODEL = "mxbai-embed-large"
COLLECTION = "naics-heatmap-1024"
DIM = 1024

DEFAULT_SHARDS = Path(
    "/Users/joewales/NODE_OUT_Master/book-pipeline/library/new/export/naics-2022-sectors-20260726"
)
WORDS_PER_CHUNK = 80  # keep embeds small — large chunks wedge mxbai locally
MIN_WORDS = 20
# Skip supporting meta shards (Introduction / Structure) from geometric core
SKIP_TITLE_SUBSTR = ("introduction", "united states structure")


def sanitize(text: str) -> str:
    return re.sub(r"[^\x09\x0A\x0D\x20-\x7E]", " ", text)


def chunk_text(text: str) -> list[str]:
    words = text.split()
    if len(words) < MIN_WORDS:
        return [text] if text.strip() else []
    chunks = []
    for i in range(0, len(words), WORDS_PER_CHUNK):
        chunk = " ".join(words[i : i + WORDS_PER_CHUNK])
        if len(chunk.split()) >= MIN_WORDS:
            chunks.append(chunk)
    return chunks if chunks else [text]


def embed_chunk(text: str) -> list[float]:
    # Hard cap ~500 tokens-ish; oversized inputs hang mxbai on this machine
    safe = sanitize(text)[:1800]
    res = requests.post(
        f"{OLLAMA_URL}/api/embed",
        json={"model": EMBED_MODEL, "input": safe},
        timeout=30,
    )
    res.raise_for_status()
    vec = res.json()["embeddings"][0]
    if len(vec) != DIM:
        raise ValueError(f"Expected {DIM}-D, got {len(vec)}")
    return vec


def heat(vec: list[float]) -> float:
    return sum(abs(v) for v in vec)


def ensure_collection() -> None:
    r = requests.get(f"{QDRANT_URL}/collections/{COLLECTION}", timeout=15)
    if r.status_code == 200:
        count = r.json().get("result", {}).get("points_count", "?")
        print(f"✅ Collection '{COLLECTION}' exists ({count} points)")
        return
    print(f"📦 Creating '{COLLECTION}' (dim={DIM}, Cosine) on {QDRANT_URL}")
    r2 = requests.put(
        f"{QDRANT_URL}/collections/{COLLECTION}",
        json={"vectors": {"size": DIM, "distance": "Cosine"}},
        timeout=30,
    )
    r2.raise_for_status()
    print(f"✅ Created '{COLLECTION}'")


def upsert(points: list[dict]) -> None:
    r = requests.put(
        f"{QDRANT_URL}/collections/{COLLECTION}/points?wait=true",
        json={"points": points},
        timeout=120,
    )
    if not r.ok:
        raise RuntimeError(f"upsert failed: {r.status_code} {r.text[:300]}")


def log(msg: str) -> None:
    print(msg, flush=True)


def load_sector_shards(shards_dir: Path, limit: int | None) -> list[dict]:
    out = []
    for f in sorted(shards_dir.glob("*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        title = (d.get("title") or "").lower()
        if any(s in title for s in SKIP_TITLE_SUBSTR):
            continue
        if not (d.get("meta") or {}).get("naics_sector") and "sector" not in title:
            # allow only sector shards in geometric core
            if not f.name.startswith("naics2022_sector_"):
                continue
        out.append(d)
        if limit and len(out) >= limit:
            break
    return out


def ingest(shards_dir: Path, dry_run: bool, limit_sectors: int | None) -> int:
    shards = load_sector_shards(shards_dir, limit_sectors)
    if not shards:
        print(f"No sector shards in {shards_dir}")
        return 2

    print(f"\n🏭 NAICS Sealed Ingest — {len(shards)} sectors → {COLLECTION}")
    print(f"   Qdrant: {QDRANT_URL}")
    print(f"   Ollama: {OLLAMA_URL} / {EMBED_MODEL}")
    print(f"   Dry run: {dry_run}\n")

    if not dry_run:
        ensure_collection()

    total_chunks = 0
    stored = 0
    errors = 0
    batch: list[dict] = []
    t0 = time.time()

    for s in shards:
        meta = s.get("meta") or {}
        sector = meta.get("naics_sector") or "unknown"
        title = s.get("title") or sector
        content = s.get("content") or ""
        chunks = chunk_text(content)
        total_chunks += len(chunks)
        prov = hashlib.sha256(content.encode()).hexdigest()[:32]
        print(f"📄 Sector {sector} — {title[:55]}  chars={len(content):,}  chunks={len(chunks)}")

        for i, chunk in enumerate(chunks):
            point_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"naics2022:{sector}:{i}:{prov}"))
            payload = {
                "domain": "memory",
                "corpus": "naics-2022",
                "sealed": True,
                "naics_sector": sector,
                "title": title,
                "chunk_idx": i,
                "chunk_total": len(chunks),
                "t_method": "single-embed",
                "kind": "naics-sector",
                "heat": 0.0,
                "shatter": -1.0,
                "ingestedAt": datetime.now(timezone.utc).isoformat(),
                "provenanceHash": prov,
                "full_text": chunk[:2000],
                "payload_schema_version": 1,
            }

            if dry_run:
                stored += 1
                continue

            try:
                vec = embed_chunk(chunk)
                payload["heat"] = heat(vec)
                batch.append({"id": point_id, "vector": vec, "payload": payload})
                stored += 1
                if len(batch) >= 8:
                    upsert(batch)
                    log(f"   ⬆ upserted batch (running total {stored})")
                    batch = []
                if (i + 1) % 10 == 0 or (i + 1) == len(chunks):
                    log(f"   ✅ {i+1}/{len(chunks)}")
            except Exception as e:
                errors += 1
                print(f"   ❌ chunk {i}: {e}")

        if batch and not dry_run:
            upsert(batch)
            batch = []

    elapsed = time.time() - t0
    print(f"\n📊 Done in {elapsed:.1f}s")
    print(f"   Sectors: {len(shards)}")
    print(f"   Chunks:  {total_chunks}")
    print(f"   Stored:  {stored}")
    print(f"   Errors:  {errors}")

    if not dry_run:
        r = requests.get(f"{QDRANT_URL}/collections/{COLLECTION}", timeout=15)
        if r.ok:
            count = r.json().get("result", {}).get("points_count", "?")
            print(f"   Qdrant '{COLLECTION}': {count} points")

        # Write local terrain summary pack (offline readable)
        pack_path = Path("/Users/joewales/spectral-terrain/store/naics-2022-ingest-summary.json")
        pack_path.write_text(
            json.dumps(
                {
                    "collection": COLLECTION,
                    "qdrant": QDRANT_URL,
                    "sectors": len(shards),
                    "chunks": total_chunks,
                    "stored": stored,
                    "errors": errors,
                    "elapsed_s": round(elapsed, 1),
                    "generated_at": datetime.now(timezone.utc).isoformat(),
                    "sector_ids": [ (s.get("meta") or {}).get("naics_sector") for s in shards ],
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"   Summary: {pack_path}")
    return 0 if errors == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shards", default=str(DEFAULT_SHARDS))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit-sectors", type=int, default=None)
    args = ap.parse_args()
    return ingest(Path(args.shards), args.dry_run, args.limit_sectors)


if __name__ == "__main__":
    raise SystemExit(main())
