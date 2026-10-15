#!/usr/bin/env python3
"""
experiment_naics_lowdim.py — Static text at WAY fewer dimensions

Hypothesis: NAICS sector geometry doesn't need 1024-D. Classification prose
lives in a low-rank industry subspace. We test retrieval quality vs dim.

Unit of analysis: ONE VECTOR PER SECTOR (20 points) — not chunk soup.
That alone is the first experimental control.

Ladders:
  A) industry-signal fingerprint (~20-D, no Ollama) — from naics_heatmap signals
  B) structural fingerprint (3-D, no Ollama) — geo-style
  C) one mxbai embed / sector → PCA to {8,16,32,64,128,256,1024}

Probes: short queries with expected sector codes. Score recall@1 / @3.

Usage:
  conda run -n agents python scripts/experiment_naics_lowdim.py
  python3 scripts/experiment_naics_lowdim.py --skip-embed   # A+B only
"""
from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path

import numpy as np
import requests

SHARDS = Path(
    "/Users/joewales/NODE_OUT_Master/book-pipeline/library/new/export/naics-2022-sectors-20260726"
)
OUT = Path("/Users/joewales/spectral-terrain/store/naics_lowdim_experiment.json")
OLLAMA = "http://127.0.0.1:11434"
MODEL = "mxbai-embed-large"

# Reuse industry signals from naics_heatmap
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

PROBES = [
    ("commercial banking and credit intermediation", "52"),
    ("crude petroleum oil and gas extraction", "21"),
    ("general medical and surgical hospitals", "62"),
    ("electric power generation and distribution", "22"),
    ("residential building construction contractors", "23"),
    ("legal services and accounting", "54"),
    ("crop production and farming", "11"),
    ("real estate property managers and lessors", "53"),
]


def sanitize(t: str) -> str:
    return re.sub(r"[^\x09\x0A\x0D\x20-\x7E]", " ", t)


def load_sectors() -> list[dict]:
    rows = []
    for f in sorted(SHARDS.glob("naics2022_sector_*.json")):
        d = json.loads(f.read_text())
        code = (d.get("meta") or {}).get("naics_sector")
        if not code:
            continue
        rows.append(
            {
                "code": code,
                "title": d.get("title"),
                "text": d.get("content") or "",
            }
        )
    return rows


def industry_fp(text: str) -> np.ndarray:
    sample = text[:120_000]
    vec = np.zeros(len(INDUSTRY_SIGNALS), dtype=np.float64)
    for i, (pat, w) in enumerate(INDUSTRY_SIGNALS):
        hits = len(re.findall(pat, sample, flags=re.I))
        if hits:
            vec[i] = w * np.log1p(hits)
    n = np.linalg.norm(vec)
    return vec / n if n > 1e-8 else vec


def structural_fp(text: str, code: str) -> np.ndarray:
    words = text.split()
    six = len(re.findall(r"(?m)^\d{6}\b", text))
    # sector ordinal proxy from first two digits
    try:
        ord_code = int(str(code).split("-")[0]) / 100.0
    except ValueError:
        ord_code = 0.5
    raw = np.array(
        [
            np.log1p(len(words)),
            np.log1p(six),
            ord_code,
        ],
        dtype=np.float64,
    )
    return raw


def l2(x: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(x)
    return x / n if n > 1e-8 else x


def embed(text: str) -> np.ndarray:
    # One short window per sector — enough for taxonomy signal, avoids wedge
    safe = sanitize(text)[:1600]
    r = requests.post(
        f"{OLLAMA}/api/embed",
        json={"model": MODEL, "input": safe},
        timeout=45,
    )
    r.raise_for_status()
    return l2(np.array(r.json()["embeddings"][0], dtype=np.float64))


def pca_project(X: np.ndarray, k: int) -> np.ndarray:
    """X: (n, d) row-normalized-ish. Return (n, k) via truncated SVD on centered data."""
    k = min(k, X.shape[0] - 1, X.shape[1])
    mu = X.mean(axis=0)
    XC = X - mu
    # economy SVD
    _, _, Vt = np.linalg.svd(XC, full_matrices=False)
    return XC @ Vt[:k].T, mu, Vt[:k]


def project_query(q: np.ndarray, mu: np.ndarray, components: np.ndarray) -> np.ndarray:
    return (q - mu) @ components.T


def recall(matrix: np.ndarray, codes: list[str], qvec: np.ndarray, expected: str, k: int) -> bool:
    # cosine ≈ dot if rows normalized
    M = matrix / (np.linalg.norm(matrix, axis=1, keepdims=True) + 1e-8)
    q = qvec / (np.linalg.norm(qvec) + 1e-8)
    sims = M @ q
    top = np.argsort(-sims)[:k]
    return expected in {codes[i] for i in top}


def score_ladder(name: str, matrix: np.ndarray, codes: list[str], qvecs: list[np.ndarray], dims: list[int] | None = None) -> dict:
    """If dims is None, score matrix as-is. Else PCA each dim and score."""
    results = {}
    if dims is None:
        r1 = r3 = 0
        for qv, (_, exp) in zip(qvecs, PROBES):
            if recall(matrix, codes, qv, exp, 1):
                r1 += 1
            if recall(matrix, codes, qv, exp, 3):
                r3 += 1
        results["native"] = {
            "dim": int(matrix.shape[1]),
            "recall@1": r1 / len(PROBES),
            "recall@3": r3 / len(PROBES),
            "hits@1": r1,
            "hits@3": r3,
        }
        return results

    for k in dims:
        if k >= matrix.shape[1]:
            # full space
            proj, mu, comp = matrix, np.zeros(matrix.shape[1]), np.eye(matrix.shape[1])
            # actually just use matrix
            M = matrix
            qs = qvecs
        else:
            proj, mu, comp = pca_project(matrix, k)
            M = proj
            qs = [project_query(q, mu, comp) for q in qvecs]
        r1 = r3 = 0
        for qv, (_, exp) in zip(qs, PROBES):
            if recall(M, codes, qv, exp, 1):
                r1 += 1
            if recall(M, codes, qv, exp, 3):
                r3 += 1
        # energy retained
        if k < matrix.shape[1]:
            XC = matrix - matrix.mean(axis=0)
            full = np.linalg.norm(XC) ** 2
            kept = np.linalg.norm(M) ** 2
            energy = float(kept / full) if full > 0 else 1.0
        else:
            energy = 1.0
        results[f"pca-{k}"] = {
            "dim": k if k < matrix.shape[1] else int(matrix.shape[1]),
            "recall@1": r1 / len(PROBES),
            "recall@3": r3 / len(PROBES),
            "hits@1": r1,
            "hits@3": r3,
            "energy_retained": round(energy, 4),
        }
    return results


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-embed", action="store_true")
    args = ap.parse_args()

    sectors = load_sectors()
    codes = [s["code"] for s in sectors]
    print(f"sectors={len(sectors)} probes={len(PROBES)}", flush=True)

    # A) industry fingerprint
    t0 = time.time()
    Ind = np.vstack([industry_fp(s["text"]) for s in sectors])
    # probe fps from query text alone
    Ind_q = [industry_fp(q) for q, _ in PROBES]
    res_ind = score_ladder("industry", Ind, codes, Ind_q)
    print(f"\nA) industry-signal  dim={Ind.shape[1]}  {res_ind['native']}  ({time.time()-t0:.2f}s)", flush=True)

    # B) structural
    t0 = time.time()
    Str = np.vstack([structural_fp(s["text"], s["code"]) for s in sectors])
    # normalize columns
    Str = (Str - Str.mean(0)) / (Str.std(0) + 1e-8)
    Str_q = []
    for q, exp in PROBES:
        # structural query is weak — use expected sector's structural as oracle? No — use text stats of query
        Str_q.append(structural_fp(q * 50, exp))  # thin; expect poor
    # Better structural probe: match by sector ordinal only is cheating.
    # Use industry for probes against structural matrix? Keep honest: structural of query text.
    Str_q = [structural_fp(q, "00") for q, _ in PROBES]
    Str_q = [(v - Str.mean(0)) / (Str.std(0) + 1e-8) for v in [structural_fp(q, "00") for q, _ in PROBES]]
    # recompute cleanly
    mu_s, sd_s = Str.mean(0), Str.std(0) + 1e-8
    Str_n = (Str - mu_s) / sd_s
    Str_q = [((structural_fp(q, "00") - mu_s) / sd_s) for q, _ in PROBES]
    res_str = score_ladder("structural", Str_n, codes, Str_q)
    print(f"B) structural       dim=3  {res_str['native']}  ({time.time()-t0:.2f}s)", flush=True)

    payload = {
        "hypothesis": "static NAICS sector geometry is low-rank; 1024-D is waste",
        "unit": "one vector per sector (n=20)",
        "probes": [{"q": q, "expected": e} for q, e in PROBES],
        "A_industry_signal": res_ind,
        "B_structural": res_str,
        "C_embed_pca": None,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    if not args.skip_embed:
        print("\nC) embedding sectors (1 window each)...", flush=True)
        t0 = time.time()
        Embs = []
        for s in sectors:
            print(f"  embed {s['code']}...", flush=True)
            Embs.append(embed(s["text"]))
        X = np.vstack(Embs)
        print(f"  embedded {len(Embs)} in {time.time()-t0:.1f}s", flush=True)
        Qs = []
        for q, _ in PROBES:
            Qs.append(embed(q))
        dims = [8, 16, 32, 64, 128, 256, 1024]
        res_pca = score_ladder("embed", X, codes, Qs, dims=dims)
        # also native 1024
        res_native = score_ladder("embed-native", X, codes, Qs)
        payload["C_embed_pca"] = {**res_native, **res_pca}
        print("\nC) mxbai → PCA ladder:", flush=True)
        for k, v in payload["C_embed_pca"].items():
            print(f"  {k:12s}  dim={v['dim']:4d}  R@1={v['recall@1']:.2f}  R@3={v['recall@3']:.2f}  energy={v.get('energy_retained',1)}", flush=True)

    OUT.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"\nwrote {OUT}", flush=True)

    # Verdict line
    print("\n── VERDICT ──", flush=True)
    print("Compare R@1 across ladders. If pca-32 ≈ native-1024, static taxonomy does not earn 1024-D.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
