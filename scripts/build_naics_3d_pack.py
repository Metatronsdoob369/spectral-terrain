#!/usr/bin/env python3
"""
build_naics_3d_pack.py — Sealed NAICS terrain pack (compute rich → display 3-D)

Produces an offline pack an agent vehicle can load without owning spectral:
  - industry-signal vectors (20-D)
  - PCA-3 coordinates for Textual / radar display
  - heat scores on the 3-D k-NN graph
  - sector metadata

Does NOT touch WhiteGlove, legal, or medical collections.
Spectral remains the producer; this pack is the accessory layer.

Usage:
  python3 scripts/build_naics_3d_pack.py
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy.sparse import csr_matrix, diags
from scipy.sparse.linalg import eigsh

SHARDS = Path(
    "/Users/joewales/NODE_OUT_Master/book-pipeline/library/new/export/naics-2022-sectors-20260726"
)
OUT = Path("/Users/joewales/spectral-terrain/store/naics-2022-3d.pack.json")

INDUSTRY_SIGNALS = [
    (r"\bestablishments?\b", 1.2),
    (r"\bindustr(?:y|ies)\b", 1.0),
    (r"\bNAICS\b", 1.5),
    (r"\bsector\b", 1.1),
    (r"\bsubsector\b", 1.0),
    (r"\bmanufactur", 1.0),
    (r"\bfinanc|\binsurance\b|\bbank", 1.2),
    (r"\breal\s+estate\b|\bleas", 1.1),
    (r"\butilit|\belectric|\bnatural\s+gas", 1.1),
    (r"\bconstruct|\bcontractor", 1.0),
    (r"\bwholesale\b|\bmerchant", 1.0),
    (r"\bretail\b|\bstore\b", 1.0),
    (r"\bhealth\s+care\b|\bhospitals?\b", 1.1),
    (r"\bprofessional\b|\bscientific\b|\blegal\s+services", 1.0),
    (r"\bpublic\s+administration\b|\bgovernment", 1.1),
    (r"\bmining\b|\boil\b|\bgas\s+extraction", 1.0),
    (r"\bagricultur|\bforestry\b|\bfishing\b", 1.0),
    (r"\btransport|\bwarehous", 1.0),
    (r"\binformation\b|\btelecom|\bpublish", 1.0),
    (r"\beducational\s+services\b|\bschool", 0.9),
]


def industry_fp(text: str) -> np.ndarray:
    sample = text[:120_000]
    vec = np.zeros(len(INDUSTRY_SIGNALS), dtype=np.float64)
    for i, (pat, w) in enumerate(INDUSTRY_SIGNALS):
        hits = len(re.findall(pat, sample, flags=re.I))
        if hits:
            vec[i] = w * np.log1p(hits)
    n = np.linalg.norm(vec)
    return vec / n if n > 1e-8 else vec


def knn(X: np.ndarray, k: int = 5) -> csr_matrix:
    n = X.shape[0]
    k = min(k, n - 1)
    S = X @ X.T
    np.fill_diagonal(S, -np.inf)
    rows, cols, data = [], [], []
    for i in range(n):
        idx = np.argpartition(-S[i], k)[:k]
        for j in idx:
            w = float(max(S[i, j], 0.0))
            if w <= 0:
                continue
            rows += [i, j]
            cols += [j, i]
            data += [w, w]
    A = csr_matrix((data, (rows, cols)), shape=(n, n))
    A = (A + A.T) * 0.5
    A.setdiag(0)
    A.eliminate_zeros()
    return A


def heat_scores(A: csr_matrix, tau: float = 0.05, k: int = 8) -> np.ndarray:
    deg = np.asarray(A.sum(axis=1)).ravel()
    d = np.where(deg > 0, 1.0 / np.sqrt(deg), 0.0)
    L = diags(np.ones(A.shape[0])) - diags(d) @ A @ diags(d)
    kk = min(k, A.shape[0] - 2)
    ev, evec = eigsh(L, k=kk, which="SM", tol=1e-5, maxiter=3000)
    return (evec**2) @ np.exp(-ev * tau)


def main() -> int:
    sectors = []
    for f in sorted(SHARDS.glob("naics2022_sector_*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        code = (d.get("meta") or {}).get("naics_sector")
        if not code:
            continue
        sectors.append(
            {
                "code": code,
                "title": d.get("title"),
                "text": d.get("content") or "",
                "char_count": len(d.get("content") or ""),
            }
        )

    Ind = np.vstack([industry_fp(s["text"]) for s in sectors])
    mu = Ind.mean(axis=0)
    XC = Ind - mu
    _, svals, Vt = np.linalg.svd(XC, full_matrices=False)
    comps = Vt[:3]
    coords = XC @ comps.T
    energy = float((svals[:3] ** 2).sum() / (svals**2).sum())

    N = coords / (np.linalg.norm(coords, axis=1, keepdims=True) + 1e-8)
    A = knn(N, k=5)
    heat = heat_scores(A)
    heat_cv = float(heat.std() / (heat.mean() + 1e-8))

    points = []
    for i, s in enumerate(sectors):
        points.append(
            {
                "id": f"naics2022:{s['code']}",
                "naics_sector": s["code"],
                "title": s["title"],
                "coords_3d": [float(x) for x in coords[i]],
                "heat": float(heat[i]),
                "industry_fp_20d": [float(x) for x in Ind[i]],
                "char_count": s["char_count"],
            }
        )

    body = {
        "schema": "naics_terrain_pack.v1",
        "domain": "naics-2022",
        "sealed": True,
        "geometry": {
            "compute_dim": 20,
            "display_dim": 3,
            "method": "industry-signal → PCA-3 → heat-kernel",
            "pca_energy_retained": round(energy, 4),
            "heat_cv": round(heat_cv, 4),
            "temporal": False,
        },
        "centroid_3d": [float(x) for x in coords.mean(axis=0)],
        "pca_components": [[float(x) for x in row] for row in comps],
        "pca_mean_20d": [float(x) for x in mu],
        "points": points,
        "point_count": len(points),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_shards": str(SHARDS),
        "carrier_note": (
            "Accessory layer for any silence-first vehicle (e.g. WhiteGlove husk). "
            "Spectral produces; agent loads. Not a medical/legal corpus."
        ),
    }

    raw = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
    body["blake2b_16"] = hashlib.blake2b(raw, digest_size=16).hexdigest()

    OUT.write_text(json.dumps(body, indent=2), encoding="utf-8")
    print(f"wrote {OUT}")
    print(f"  points={len(points)}  pca_energy={energy:.3f}  heat_cv={heat_cv:.3f}")
    top = sorted(points, key=lambda p: p["heat"], reverse=True)[:5]
    for p in top:
        print(f"  heat={p['heat']:.3f}  {p['naics_sector']:6s}  {p['title'][:50]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
