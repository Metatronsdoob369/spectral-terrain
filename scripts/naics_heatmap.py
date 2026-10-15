#!/usr/bin/env python3
"""
naics_heatmap.py — Corpus heat map over NAICS sector shards.

Sibling to WhiteGlove legal_heatmap.py, tuned for industry-classification text
instead of legal citations. Input contract matches export_shards / sector split:

    { id, content, source, title }

Usage:
    conda run -n agents python spectral-terrain/scripts/naics_heatmap.py \\
        --shards /Users/joewales/NODE_OUT_Master/book-pipeline/library/new/export/naics-2022-sectors-20260726 \\
        --out    /Users/joewales/spectral-terrain/store/naics_heatmap.json
"""
from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path

import numpy as np
from scipy.sparse import csr_matrix, diags
from scipy.sparse.linalg import eigsh

INDUSTRY_SIGNALS = [
    (r"\bestablishments?\b", "establishments", 1.2),
    (r"\bindustr(?:y|ies)\b", "industry", 1.0),
    (r"\bNAICS\b", "naics", 1.5),
    (r"\bsector\b", "sector", 1.1),
    (r"\bsubsector\b", "subsector", 1.0),
    (r"\bmanufactur", "manufacturing", 1.0),
    (r"\bfinanc|\binsurance\b|\bbank", "finance", 1.2),
    (r"\breal\s+estate\b|\bleas", "real_estate", 1.1),
    (r"\butilit|\belectric|\bnatural\s+gas", "utilities", 1.1),
    (r"\bconstruct|\bcontractor", "construction", 1.0),
    (r"\bwholesale\b|\bmerchant", "wholesale", 1.0),
    (r"\bretail\b|\bstore\b", "retail", 1.0),
    (r"\bhealth\s+care\b|\bhospitals?\b", "healthcare", 1.1),
    (r"\bprofessional\b|\bscientific\b|\blegal\s+services", "professional", 1.0),
    (r"\bpublic\s+administration\b|\bgovernment", "public_admin", 1.1),
    (r"\bmining\b|\boil\b|\bgas\s+extraction", "mining", 1.0),
    (r"\bagricultur|\bforestry\b|\bfishing\b", "agriculture", 1.0),
    (r"\btransport|\bwarehous", "transport", 1.0),
    (r"\binformation\b|\btelecom|\bpublish", "information", 1.0),
    (r"\beducational\s+services\b|\bschool", "education", 0.9),
]


def load_shards(path: Path) -> list[dict]:
    shards = []
    for f in sorted(path.glob("*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        if not (d.get("content") or "").strip():
            continue
        shards.append(d)
    return shards


def fingerprint(text: str) -> np.ndarray:
    vec = np.zeros(len(INDUSTRY_SIGNALS), dtype=np.float64)
    sample = text[:120_000]
    for i, (pat, _name, weight) in enumerate(INDUSTRY_SIGNALS):
        hits = len(re.findall(pat, sample, flags=re.I))
        if hits:
            vec[i] = weight * np.log1p(hits)
    n = np.linalg.norm(vec)
    return vec / n if n > 1e-8 else vec


def knn_graph(X: np.ndarray, knn: int) -> csr_matrix:
    n = X.shape[0]
    k = min(knn, n - 1)
    sims = X @ X.T
    np.fill_diagonal(sims, -np.inf)
    rows, cols, data = [], [], []
    for i in range(n):
        idx = np.argpartition(-sims[i], k)[:k]
        for j in idx:
            w = float(max(sims[i, j], 0.0))
            if w <= 0:
                continue
            rows.append(i)
            cols.append(j)
            data.append(w)
            rows.append(j)
            cols.append(i)
            data.append(w)
    A = csr_matrix((data, (rows, cols)), shape=(n, n))
    A = (A + A.T) * 0.5
    A.setdiag(0)
    A.eliminate_zeros()
    return A


def heat_scores(A: csr_matrix, tau: float, k: int) -> tuple[np.ndarray, np.ndarray]:
    deg = np.asarray(A.sum(axis=1)).ravel()
    deg_inv_sqrt = np.where(deg > 0, 1.0 / np.sqrt(deg), 0.0)
    D_inv = diags(deg_inv_sqrt)
    L = diags(np.ones(A.shape[0])) - D_inv @ A @ D_inv
    k_actual = min(k, A.shape[0] - 2)
    eigvals, eigvecs = eigsh(L, k=k_actual, which="SM", tol=1e-5, maxiter=3000)
    weights = np.exp(-eigvals * tau)
    heat = (eigvecs**2) @ weights
    return heat, eigvals


def band(heat: float, mean: float, std: float, vec: np.ndarray) -> str:
    z = (heat - mean) / (std + 1e-8)
    nrm = float(np.linalg.norm(vec))
    if nrm < 0.05:
        return "noise"
    if z > 0.5:
        return "settled"
    if z < -0.5:
        return "noise"
    if abs(z) < 0.3 and nrm > 0.2:
        return "contested"
    return "active"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shards", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tau", type=float, default=0.05)
    ap.add_argument("--k", type=int, default=12)
    ap.add_argument("--knn", type=int, default=6)
    args = ap.parse_args()

    shards_dir = Path(args.shards).expanduser().resolve()
    out_path = Path(args.out).expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    shards = load_shards(shards_dir)
    if len(shards) < 3:
        print(f"ERROR: need ≥3 shards, found {len(shards)}", flush=True)
        return 2

    X = np.vstack([fingerprint(s["content"]) for s in shards])
    A = knn_graph(X, args.knn)
    heat, eigvals = heat_scores(A, args.tau, args.k)
    mean, std = float(heat.mean()), float(heat.std())

    rows = []
    for i, s in enumerate(shards):
        rows.append(
            {
                "id": s["id"],
                "title": s.get("title"),
                "source": s.get("source"),
                "heat_score": float(heat[i]),
                "spectral_band": band(float(heat[i]), mean, std, X[i]),
                "meta": s.get("meta") or {},
            }
        )
    rows.sort(key=lambda r: r["heat_score"], reverse=True)

    payload = {
        "schema": "naics_heatmap.v1",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "shard_count": len(rows),
        "tau": args.tau,
        "knn": args.knn,
        "eigval_range": [float(eigvals[0]), float(eigvals[-1])],
        "heat_mean": mean,
        "heat_std": std,
        "shards": rows,
    }
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"wrote {out_path}  shards={len(rows)}  elapsed={time.time()-t0:.1f}s")
    for r in rows[:8]:
        print(f"  {r['heat_score']:.4f}  {r['spectral_band']:10s}  {r['title'][:70]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
