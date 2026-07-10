#!/usr/bin/env python3
"""
geo_rag_ingest.py — Geospatial standards corpus → TriadGATGraphRAG heat map

0-dim structural fingerprint (no Ollama, no network):
  [log(token_count), sha_hash_norm, log(chapter_count)]

Builds K-NN graph over geospatial standards artifacts.
Runs eve TriadGATGraphRAG (in_dim=3) → per-document heat scores + GSI.

Usage:
    conda run -n agents python spectral-terrain/scripts/geo_rag_ingest.py
    conda run -n agents python spectral-terrain/scripts/geo_rag_ingest.py --out /tmp/geo_heatmap.json
    conda run -n agents python spectral-terrain/scripts/geo_rag_ingest.py --qdrant-push
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import uuid
from pathlib import Path
from typing import List, Tuple

import numpy as np
import torch
import torch.nn.functional as F
from scipy.spatial import KDTree
from torch_geometric.data import Data

# ── eve import ──────────────────────────────────────────────────────────────
EVE_PATH = Path("/Users/joewales/NODE_OUT_Master/domicile_live/Skills/HK_101")
sys.path.insert(0, str(EVE_PATH))
from eve_v1 import TriadGATGraphRAG  # noqa: E402

# ── Corpus definition ────────────────────────────────────────────────────────
ARTIFACT_BASE = Path(
    "/Users/joewales/Documents/BOOK_BRAIN_ADDITIONS/"
    "book_brain_repo/book-pipeline/library/new/artifacts"
)

GEO_CORPUS: list[dict] = [
    {"id": "iphg_xsd",             "file": "iphg_xsd.auto.artifact.json",             "label": "IPHG XSD (GML App Schema)"},
    {"id": "isotc211_skos",        "file": "isotc211_skos.auto.artifact.json",        "label": "ISO/TC 211 SKOS Glossary"},
    {"id": "dgiwg_dgra_synopsis",  "file": "dgiwg_dgra_synopsis.auto.artifact.json",  "label": "DGIWG Geospatial Ref Architecture"},
    {"id": "nga_wgs84",            "file": "nga_wgs84.auto.artifact.json",            "label": "NGA WGS84 Coordinate Standard"},
    {"id": "dgiwg_portrayal",      "file": "dgiwg_portrayal_roadmap.auto.artifact.json", "label": "DGIWG Portrayal Roadmap Ed4.0"},
    {"id": "iphg_catalogue",       "file": "iphg_catalogue.auto.artifact.json",       "label": "IPHG Feature Catalogue"},
]

QDRANT_URL = "http://127.0.0.1:6340"
COLLECTION = "spectral-heatmap-geo"
GEO_DIM    = 128  # eve out dim for this corpus


# ── Structural fingerprint (0-dim pattern) ────────────────────────────────────

def structural_fingerprint(artifact: dict, doc_id: str) -> np.ndarray:
    """
    3-D deterministic structural fingerprint:
      dim 0 — log1p(token_count) — document density
      dim 1 — sha256[:8] as int / 1000  — structural identity hash
      dim 2 — log1p(chapter_count) — schema depth
    No network. No Ollama. Fully deterministic.
    """
    tokens   = artifact["totals"]["tokens"]
    chapters = artifact["totals"]["chapters_total"]
    sha      = artifact["source"]["sha256"]
    hash_int = int(sha[:8], 16) % 1000

    return np.array([
        math.log1p(tokens),
        hash_int / 1000.0,
        math.log1p(chapters),
    ], dtype=np.float32)


def normalize_corpus(raw: np.ndarray) -> np.ndarray:
    """Min-max normalize across corpus so all dims ∈ [0,1]."""
    lo  = raw.min(axis=0)
    hi  = raw.max(axis=0)
    rng = np.where(hi - lo > 1e-8, hi - lo, 1.0)
    return (raw - lo) / rng


# ── K-NN graph (3-D, bypasses forge_graph which is 2-D only) ─────────────────

def build_geo_graph(fingerprints: np.ndarray) -> Data:
    """
    Build KDTree K-NN graph over N×3 structural fingerprint space.
    forge_graph from eve_v1 is bypassed — it assumes 2-D landmark curvature.
    """
    n = len(fingerprints)
    k = min(4, n - 1)

    tree = KDTree(fingerprints)
    src, dst = [], []
    for i in range(n):
        _, neighbors = tree.query(fingerprints[i], k=k + 1)
        for j in neighbors[1:]:
            if i != j:
                src.append(i); dst.append(j)
                src.append(j); dst.append(i)

    # Deduplicate edges
    edges = set(zip(src, dst))
    src_d, dst_d = zip(*edges) if edges else ([], [])

    edge_index = torch.tensor([list(src_d), list(dst_d)], dtype=torch.long)
    x = torch.tensor(fingerprints, dtype=torch.float)
    return Data(x=x, edge_index=edge_index)


# ── Heat score (mirrors spectral-terrain computeHeat) ────────────────────────

def compute_heat(node_emb: torch.Tensor) -> torch.Tensor:
    """Manhattan resonance: Σ|v[i]| per node."""
    return node_emb.abs().sum(dim=1)


def compute_shatter(node_emb: torch.Tensor) -> torch.Tensor:
    """Euclidean distance from corpus centroid."""
    centroid = node_emb.mean(dim=0)
    return torch.norm(node_emb - centroid, dim=1)


# ── Qdrant push (optional) ────────────────────────────────────────────────────

def push_to_qdrant(
    docs: list[dict],
    node_emb: torch.Tensor,
    heat: torch.Tensor,
    shatter: torch.Tensor,
    g_global: torch.Tensor,
) -> None:
    import requests
    import hashlib

    dim = node_emb.shape[1]

    # Ensure collection exists
    r = requests.get(f"{QDRANT_URL}/collections/{COLLECTION}")
    if r.status_code == 404:
        requests.put(
            f"{QDRANT_URL}/collections/{COLLECTION}",
            headers={"Content-Type": "application/json"},
            json={"vectors": {"size": dim, "distance": "Cosine"}},
        )
        print(f"  Created Qdrant collection: {COLLECTION} (dim={dim})")

    points = []
    for i, doc in enumerate(docs):
        vec = node_emb[i].tolist()
        points.append({
            "id":     str(uuid.uuid4()),
            "vector": vec,
            "payload": {
                "doc_id":   doc["id"],
                "label":    doc["label"],
                "domain":   "geospatial-standards",
                "heat":     float(heat[i]),
                "shatter":  float(shatter[i]),
                "fingerprint": doc["fingerprint_raw"].tolist(),
                "tokens":   doc["tokens"],
                "chapters": doc["chapters"],
                "kind":     "canonical",
                "t_method": "structural-fingerprint",
            },
        })

    # Global corpus centroid point
    points.append({
        "id":     str(uuid.uuid4()),
        "vector": g_global.squeeze(0).tolist(),
        "payload": {
            "doc_id":  "geo_centroid",
            "label":   "Diamond-Stable Geospatial Centroid",
            "domain":  "geospatial-standards",
            "kind":    "canonical",
            "t_method": "structural-fingerprint",
        },
    })

    requests.put(
        f"{QDRANT_URL}/collections/{COLLECTION}/points",
        headers={"Content-Type": "application/json"},
        json={"points": points},
    )
    print(f"  Pushed {len(points)} points → {COLLECTION}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description="Geospatial standards → TriadGAT heat map")
    ap.add_argument("--out",         default="geo_heatmap.json", help="Output JSON path")
    ap.add_argument("--qdrant-push", action="store_true",        help="Push results to Qdrant")
    ap.add_argument("--gat-out",     type=int, default=GEO_DIM,  help="GAT output dim (default 128)")
    args = ap.parse_args()

    # 1 — Load artifacts & build fingerprints
    print("\n── Geospatial RAG Ingest ─────────────────────────────────")
    docs = []
    raw_fps: list[np.ndarray] = []
    for entry in GEO_CORPUS:
        path = ARTIFACT_BASE / entry["file"]
        if not path.exists():
            print(f"  SKIP (not found): {entry['id']}")
            continue
        artifact = json.loads(path.read_text())
        fp = structural_fingerprint(artifact, entry["id"])
        raw_fps.append(fp)
        docs.append({
            **entry,
            "fingerprint_raw": fp,
            "tokens":          artifact["totals"]["tokens"],
            "chapters":        artifact["totals"]["chapters_total"],
            "sha256":          artifact["source"]["sha256"],
        })
        print(f"  {entry['id']:25s}  tokens={artifact['totals']['tokens']:6d}  ch={artifact['totals']['chapters_total']:4d}  fp={fp.round(3)}")

    n_docs = len(docs)
    if n_docs < 3:
        sys.exit("ERROR: need at least 3 documents for graph construction")

    # 2 — Normalize fingerprints to [0,1]
    raw_matrix  = np.stack(raw_fps)
    norm_matrix = normalize_corpus(raw_matrix)
    for i, doc in enumerate(docs):
        doc["fingerprint_norm"] = norm_matrix[i]

    # 3 — Build K-NN graph
    print(f"\n── Building K-NN graph over {n_docs} nodes (3-D fingerprint space)")
    data = build_geo_graph(norm_matrix)
    print(f"   Nodes: {data.num_nodes}  Edges: {data.num_edges}")

    # 4 — TriadGATGraphRAG (in_dim=3, bypasses forge_graph)
    out_dim = args.gat_out
    hid_dim = max(32, out_dim // 2)
    model = TriadGATGraphRAG(
        in_dim=3,
        hid=hid_dim,
        out=out_dim,
        num_layers=3,
        heads=4,
        tau=0.85,
        num_traces=8,
        low_k=min(10, n_docs - 2),
        heat_tau=0.05,
        lambda_op=0.1,
    )
    model.eval()

    print(f"\n── Running TriadGATGraphRAG (in_dim=3, hid={hid_dim}, out={out_dim})")
    # No torch.no_grad() — embed_graph's Hessian estimator requires grad
    h, g_global = model.embed_graph(data)

    print(f"   Node embeddings : {h.shape}   (N={n_docs}, dim={out_dim})")
    print(f"   Global embedding: {g_global.shape}")

    # 5 — Heat scores (GAT-space)
    heat    = compute_heat(h)
    shatter = compute_shatter(h)

    # Raw fingerprint heat — meaningful even with untrained GAT weights
    # This is the primary structural signal; GAT adds relational context
    norm_t        = torch.tensor(norm_matrix, dtype=torch.float)
    fp_centroid   = norm_t.mean(dim=0)
    fp_shatter    = torch.norm(norm_t - fp_centroid, dim=1)   # Euclidean from centroid
    fp_heat       = norm_t.abs().sum(dim=1)                    # Manhattan resonance

    # 6 — GSI via diffusion_lock (optional, uses global embedding as prompt)
    prompt_emb = g_global.squeeze(0)
    enhanced, retrieved_idxs = model.rag_strike(prompt_emb, h, g_global)
    target = torch.tensor(norm_matrix, dtype=torch.float)
    with torch.no_grad():
        _, gsi_score = model.diffusion_lock(enhanced, target)

    diag = model.get_triad_diagnostics()

    # 7 — Build report
    print("\n── Heat Map ─────────────────────────────────────────────────")
    print(f"   {'Doc':25s}  {'fp_heat':>7s}  {'fp_shat':>7s}  {'gat_heat':>8s}  {'gat_shat':>8s}")
    document_reports = []
    for i, doc in enumerate(docs):
        retrieved = (i in retrieved_idxs)
        print(f"   {doc['id']:25s}  {fp_heat[i]:.4f}   {fp_shatter[i]:.4f}   {heat[i]:.4f}    {shatter[i]:.4f}")

        # Nearest neighbors by fingerprint distance (structural proximity)
        # Using fingerprint space not GAT space — GAT is untrained (random init)
        fp_dists = torch.norm(norm_t - norm_t[i].unsqueeze(0), dim=1)
        fp_dists[i] = float("inf")
        nearest_idxs = fp_dists.argsort()[:3].tolist()
        nearest = [docs[j]["id"] for j in nearest_idxs]

        document_reports.append({
            "id":             doc["id"],
            "label":          doc["label"],
            "tokens":         doc["tokens"],
            "chapters":       doc["chapters"],
            "sha256":         doc["sha256"][:16],
            "fingerprint_raw":  [round(float(x), 5) for x in doc["fingerprint_raw"]],
            "fingerprint_norm": [round(float(x), 5) for x in doc["fingerprint_norm"]],
            "fp_heat":        round(float(fp_heat[i]), 6),
            "fp_shatter":     round(float(fp_shatter[i]), 6),
            "gat_heat":       round(float(heat[i]), 6),
            "gat_shatter":    round(float(shatter[i]), 6),
            "retrieved_by_rag": retrieved,
            "nearest":        nearest,
            "embedding_norm": round(float(h[i].norm()), 6),
        })

    report = {
        "corpus":             "geospatial-standards",
        "doc_count":          n_docs,
        "gsi_score":          round(gsi_score, 6),
        "global_emb_norm":    round(float(g_global.norm()), 6),
        "retrieval_hits":     len(retrieved_idxs),
        "gat_config": {
            "in_dim": 3, "hid": hid_dim, "out": out_dim,
            "layers": 3, "heads": 4,
        },
        "triad_diagnostics":  {k: (v if isinstance(v, (int, float)) else list(v)) for k, v in diag.items()},
        "documents":          document_reports,
    }

    out_path = Path(args.out)
    out_path.write_text(json.dumps(report, indent=2))
    print(f"\n── Wrote: {out_path}")
    print(f"   GSI alignment: {gsi_score:.4f}")
    print(f"   Retrieval hits: {len(retrieved_idxs)}/{n_docs}")
    print(f"   Spectral range: {diag['spectral_range']}")

    if args.qdrant_push:
        print("\n── Pushing to Qdrant...")
        push_to_qdrant(docs, h, heat, shatter, g_global)

    print("\n── COMPLETE ─────────────────────────────────────────────────\n")


if __name__ == "__main__":
    main()
