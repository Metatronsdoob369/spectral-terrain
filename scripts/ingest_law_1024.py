#!/usr/bin/env python3
"""
ingest_law_1024.py — Law corpus ingest into spectral-heatmap-1024

Reads .txt files from a source directory, chunks them at 100 words,
embeds with mxbai-embed-large (1024-D, local Ollama), and upserts to
Pi Qdrant in the 'law-heatmap-1024' collection.

Domain: memory (static doctrinal, no temporal concatenation — contract-enforced)
Collection: law-heatmap-1024 (1024-D Cosine)
Embed model: mxbai-embed-large (local)

Usage:
    python3 scripts/ingest_law_1024.py --dir /tmp/law-texts
    python3 scripts/ingest_law_1024.py --dir /tmp/law-texts --dry-run
"""

import argparse
import hashlib
import json
import os
import re
import sys
import uuid
from pathlib import Path

import requests

QDRANT_URL  = os.environ.get("QDRANT_PI_URL", "http://127.0.0.1:6333")
OLLAMA_URL  = "http://127.0.0.1:11434"
EMBED_MODEL = "mxbai-embed-large"
COLLECTION  = "law-heatmap-1024"
DIM         = 1024

WORDS_PER_CHUNK = 100
MIN_WORDS       = 20

# ─────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────

def sanitize(text: str) -> str:
    """Strip non-ASCII except tab, LF, CR — matches engine preIngestFilter."""
    return re.sub(r'[^\x09\x0A\x0D\x20-\x7E]', ' ', text)

def chunk_text(text: str) -> list[str]:
    """Word-count chunking — 100-word ceiling, 20-word floor."""
    words = text.split()
    if len(words) < MIN_WORDS:
        return [text] if text.strip() else []
    chunks = []
    for i in range(0, len(words), WORDS_PER_CHUNK):
        chunk = ' '.join(words[i:i + WORDS_PER_CHUNK])
        if len(chunk.split()) >= MIN_WORDS:
            chunks.append(chunk)
    return chunks if chunks else [text]

def embed_chunk(text: str) -> list[float]:
    safe = sanitize(text)
    res = requests.post(
        f"{OLLAMA_URL}/api/embed",
        json={"model": EMBED_MODEL, "input": safe},
        timeout=60,
    )
    res.raise_for_status()
    data = res.json()
    vec = data["embeddings"][0]
    if len(vec) != DIM:
        raise ValueError(f"Expected {DIM}-D vector, got {len(vec)}-D")
    return vec

def compute_heat(vec: list[float]) -> float:
    """Manhattan resonance — Σ|v[i]|"""
    return sum(abs(v) for v in vec)

def ensure_collection():
    """Create law-heatmap-1024 if it doesn't exist."""
    r = requests.get(f"{QDRANT_URL}/collections/{COLLECTION}", timeout=10)
    if r.status_code == 200:
        info = r.json().get("result", {})
        count = info.get("points_count", "?")
        print(f"✅ Collection '{COLLECTION}' exists ({count} points)")
        return
    print(f"📦 Creating collection '{COLLECTION}' (dim={DIM}, Cosine)...")
    body = {"vectors": {"size": DIM, "distance": "Cosine"}}
    r2 = requests.put(
        f"{QDRANT_URL}/collections/{COLLECTION}",
        json=body,
        timeout=30,
    )
    r2.raise_for_status()
    print(f"✅ Created '{COLLECTION}'")

def upsert_point(point_id: str, vector: list[float], payload: dict):
    body = {"points": [{"id": point_id, "vector": vector, "payload": payload}]}
    r = requests.put(
        f"{QDRANT_URL}/collections/{COLLECTION}/points",
        json=body,
        timeout=30,
    )
    if not r.ok:
        raise RuntimeError(f"Qdrant upsert failed: {r.status_code} {r.text[:200]}")

# ─────────────────────────────────────────────────────────────────
# MAIN INGEST
# ─────────────────────────────────────────────────────────────────

def ingest_dir(source_dir: str, dry_run: bool = False):
    txt_files = sorted(Path(source_dir).glob("*.txt"))
    if not txt_files:
        print(f"No .txt files found in {source_dir}")
        sys.exit(1)

    print(f"\n📚 Law Ingest — {len(txt_files)} files → {COLLECTION} (1024-D)")
    print(f"   Qdrant: {QDRANT_URL}")
    print(f"   Ollama: {OLLAMA_URL} / {EMBED_MODEL}")
    print(f"   Dry run: {dry_run}\n")

    if not dry_run:
        ensure_collection()

    total_chunks = 0
    total_ingested = 0
    errors = 0

    for txt_path in txt_files:
        raw = txt_path.read_text(encoding="utf-8", errors="replace")
        chunks = chunk_text(raw)
        fname = txt_path.name
        prov_hash = hashlib.sha256(raw.encode()).hexdigest()[:32]

        print(f"📄 {fname} — {len(raw):,} chars, {len(chunks)} chunks")
        total_chunks += len(chunks)

        for i, chunk in enumerate(chunks):
            point_id = str(uuid.uuid4())
            payload = {
                "domain":    "memory",
                "file":      fname,
                "chunk_idx": i,
                "chunk_total": len(chunks),
                "t_method":  "single-embed",
                "kind":      "canonical",
                "heat":      0.0,       # updated after embed
                "shatter":   -1.0,      # no centroid yet for this collection
                "hamming_sig": "0" * 16,
                "deltaVector3d": None,
                "deltaTarget":   None,
                "ingestedAt":    __import__("datetime").datetime.utcnow().isoformat() + "Z",
                "provenanceHash": prov_hash,
                "source_resolvable": True,
                "payload_schema_version": 1,
                "unicode_drift_risk": bool(re.search(r'[^\x09\x0A\x0D\x20-\x7E]', chunk)),
                # Law-specific metadata
                "corpus": "law-library",
                "full_text": chunk,
            }

            if dry_run:
                print(f"   [dry] chunk {i+1}/{len(chunks)}: {chunk[:60].strip()!r}...")
                total_ingested += 1
                continue

            try:
                vec = embed_chunk(chunk)
                payload["heat"] = compute_heat(vec)
                upsert_point(point_id, vec, payload)
                total_ingested += 1
                if (i + 1) % 50 == 0 or (i + 1) == len(chunks):
                    print(f"   ✅ {i+1}/{len(chunks)} chunks")
            except Exception as e:
                print(f"   ❌ chunk {i}: {e}")
                errors += 1

    print(f"\n📊 Ingest complete:")
    print(f"   Files:   {len(txt_files)}")
    print(f"   Chunks:  {total_chunks}")
    print(f"   Stored:  {total_ingested}")
    print(f"   Errors:  {errors}")
    if not dry_run:
        r = requests.get(f"{QDRANT_URL}/collections/{COLLECTION}", timeout=10)
        if r.ok:
            count = r.json().get("result", {}).get("points_count", "?")
            print(f"   Pi Qdrant '{COLLECTION}': {count} total points")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Ingest law corpus → law-heatmap-1024")
    parser.add_argument("--dir", default="/tmp/law-texts", help="Directory of .txt files")
    parser.add_argument("--dry-run", action="store_true", help="Parse/chunk only, no embed/upsert")
    args = parser.parse_args()
    ingest_dir(args.dir, dry_run=args.dry_run)
