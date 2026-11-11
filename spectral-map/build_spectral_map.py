#!/usr/bin/env python3
"""
spectral-map — structural fingerprint of this repo across its own git history.

Builds a [file x band x commit] cube using the SAME 5-D structural provider as
engine/embed.ts (structuralFingerprint), treats commit order as a geometric axis,
and writes human-visible maps plus Qdrant-ready points.

Usage (from repo root):
    python3 spectral-map/build_spectral_map.py            # writes into spectral-map/out/

Requires: numpy, pandas, matplotlib, plotly
"""
import json, math, os, re, subprocess, uuid
from pathlib import Path
import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
OUT = HERE / "out"
EXT = (".ts", ".py", ".lua")
BANDS = ["d1_size", "d2_hash", "d3_struct", "d4_defs", "d5_coupling"]
STRUCT = [0, 2, 3, 4]                     # hash-free bands for the centred 4-D view
ANCHOR, ALARM = 0.05, 0.15                # ARCHITECTURE.md shatter bands


def git(*a):
    return subprocess.run(["git", "-c", "safe.directory=*", "-C", str(REPO), *a],
                          capture_output=True, check=True).stdout


# ── port of engine/embed.ts structuralFingerprint (raw, pre-normalization) ──
DEF = re.compile(r"\b(function|def|class|struct|impl|interface|type|fn)\b", re.ASCII)
IMP = re.compile(r"\b(import|from|require|include|use)\b", re.ASCII)


def fingerprint(text):
    u16 = text.encode("utf-16-le"); n = len(u16) // 2      # JS string.length
    h = 0
    for i in range(n):                                       # Math.imul(31,h)+c | 0
        h = (31 * h + (u16[2 * i] | (u16[2 * i + 1] << 8))) & 0xFFFFFFFF
    if h >= 2 ** 31: h -= 2 ** 32
    return [math.log1p(n), (abs(h) % 1000) / 1000, math.log1p(text.count("\n") + 1),
            math.log1p(len(DEF.findall(text))), math.log1p(len(IMP.findall(text)))], h


def band(s):
    return np.where(s < ANCHOR, "ANCHOR", np.where(s < ALARM, "REVIEW", "ALARM"))


def main():
    assert fingerprint("hello")[1] == 99162322 and fingerprint("abc")[1] == 96354
    OUT.mkdir(exist_ok=True)

    # ── 1. cube over history ──
    commits = [c.split("|", 2) for c in
               git("log", "--reverse", "--format=%H|%ad|%s", "--date=short").decode().strip().split("\n")]
    cache, rows = {}, []
    for k, (h, d, s) in enumerate(commits):
        for line in git("ls-tree", "-r", h).decode().splitlines():
            meta, path = line.split("\t", 1); _, typ, blob = meta.split()
            if typ != "blob" or not path.endswith(EXT) or "node_modules" in path or path.startswith("spectral-map/"):
                continue
            if blob not in cache:
                cache[blob] = fingerprint(git("cat-file", "-p", blob).decode("utf-8", "replace"))[0]
            rows.append((k, path, blob, *cache[blob]))
    df = pd.DataFrame(rows, columns=["k", "path", "blob", *BANDS])
    files = sorted(df.path.unique(), key=lambda p: (p.split("/")[0], p))
    F, K = len(files), len(commits); fi = {p: i for i, p in enumerate(files)}
    dates = [c[1] for c in commits]
    raw = np.full((F, 5, K), np.nan)
    for r in df.itertuples():
        raw[fi[r.path], :, r.k] = [getattr(r, b) for b in BANDS]
    exists = ~np.isnan(raw[:, 0, :])
    nrm = raw / np.linalg.norm(raw, axis=1, keepdims=True)

    # ── 2. geometry ──
    cen = np.nanmean(nrm[:, :, -1], axis=0)                  # HEAD-terrain centroid
    shatter = np.linalg.norm(nrm - cen[None, :, None], axis=1)
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)       # absent files → NaN heat
        heat = np.nanmean(np.abs(nrm), axis=1)
    dv = np.diff(nrm, axis=2); mut = np.linalg.norm(dv, axis=1)
    trip = np.concatenate([nrm[:, :, :-2], nrm[:, :, 1:-1], nrm[:, :, 2:]], axis=1)
    share = np.nansum(dv ** 2, axis=(0, 2)) / np.nansum(dv ** 2)
    head = raw[:, STRUCT, -1][exists[:, -1]]; mu, sd = head.mean(0), head.std(0)
    Z = (raw[:, STRUCT, :] - mu[None, :, None]) / sd[None, :, None]
    Zn = Z / np.linalg.norm(Z, axis=1, keepdims=True); zdist = np.linalg.norm(Z, axis=1)

    # ── 3. tabular + Qdrant exports ──
    recs, p5, p4 = [], [], []
    for f in range(F):
        for k in np.where(exists[f])[0]:
            r = dict(file=files[f], dir=files[f].split("/")[0], commit_idx=int(k), commit=commits[k][0][:7],
                     date=dates[k], subject=commits[k][2],
                     **{b: round(float(raw[f, i, k]), 6) for i, b in enumerate(BANDS)},
                     **{"n_" + b: round(float(nrm[f, i, k]), 6) for i, b in enumerate(BANDS)},
                     heat=round(float(heat[f, k]), 6), shatter=round(float(shatter[f, k]), 6),
                     shatter_band=str(band(shatter[f, k])),
                     mutated_since_prev=bool(k > 0 and exists[f, k - 1] and mut[f, k - 1] > 1e-12))
            recs.append(r)
            pid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"spectral-terrain:{files[f]}@{commits[k][0]}"))
            pl = {"domain": "source-audit", "kind": "git-history-state-5d", "embed_provider": "structural",
                  **{a: v for a, v in r.items() if not a.startswith("n_")}}
            p5.append({"id": pid, "vector": [r["n_" + b] for b in BANDS], "payload": pl})
            pl4 = dict(pl, kind="git-history-state-4d-centred", z_distance=round(float(zdist[f, k]), 6))
            p4.append({"id": pid, "vector": [round(float(x), 6) for x in Zn[f, :, k]], "payload": pl4})
    pd.DataFrame(recs).to_csv(OUT / "spectral_cube_long.csv", index=False)
    json.dump({"points": p5}, open(OUT / "qdrant_points_5d.json", "w"))
    json.dump({"points": p4}, open(OUT / "qdrant_points_4d_centred.json", "w"))
    json.dump({"bands": [BANDS[i] for i in STRUCT], "mean": mu.round(6).tolist(), "std": sd.round(6).tolist(),
               "recipe": "z=(log-bands - mean)/std ; vector = z/||z|| ; centre = HEAD terrain",
               "head_commit": commits[-1][0]}, open(OUT / "centring_transform_4d.json", "w"), indent=1)
    np.savez_compressed(OUT / "spectral_cube.npz", raw=raw, normalized=nrm, shatter=shatter, triplets=trip,
                        files=np.array(files), commits=np.array([c[0] for c in commits]),
                        dates=np.array(dates), bands=np.array(BANDS), centroid=cen)

    # ── 4. figures ──
    overview(raw, exists, mut, shatter, share, files, dates, OUT / "spectral_map_overview.png")
    viewer(raw, nrm, exists, shatter, mut, share, files, commits, dates, OUT / "spectral_terrain_viewer.html")

    trip_valid = ~np.isnan(trip).any(axis=1)
    vvv = np.mean([np.allclose(trip[f, 0:5, k], trip[f, 5:10, k]) and np.allclose(trip[f, 5:10, k], trip[f, 10:15, k])
                   for f, k in zip(*np.where(trip_valid))])
    summary = dict(commits=K, files=F, distinct_blobs=len(cache), file_states=int(exists.sum()),
                   mutation_events=int(np.nansum(mut > 1e-12)), vvv_triplet_fraction=round(float(vvv), 4),
                   band_share_of_mutation_energy=dict(zip(BANDS, share.round(4).tolist())),
                   head_shatter_bands=pd.Series(band(shatter[exists[:, -1], -1])).value_counts().to_dict())
    json.dump(summary, open(OUT / "summary.json", "w"), indent=1)
    print(json.dumps(summary, indent=1))


def overview(raw, exists, mut, shatter, share, files, dates, path):
    import matplotlib; matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import ListedColormap
    from matplotlib.patches import Patch
    plt.rcParams.update({"font.size": 8, "xtick.labelsize": 6, "ytick.labelsize": 6,
                         "axes.spines.top": False, "axes.spines.right": False})
    dirs = [p.split("/")[0] for p in files]
    mm = lambda x: (x - np.nanmin(x)) / (np.nanmax(x) - np.nanmin(x))
    rgb = np.stack([mm(raw[:, 0, :]), mm(raw[:, 3, :]), mm(raw[:, 4, :])], axis=-1); rgb[~exists] = 1.0
    fig, ((a, b), (c, d)) = plt.subplots(2, 2, figsize=(7.2, 6.4), gridspec_kw=dict(hspace=0.45, wspace=0.32))

    def rows(ax):
        ax.set_yticks([]); s = 0
        for g in dict.fromkeys(dirs):
            n = dirs.count(g); ax.axhline(s - 0.5, color="0.4", lw=0.4)
            ax.text(-0.6, s + n / 2 - 0.5, g, ha="right", va="center", fontsize=6); s += n
    K = len(dates); xt = [0, K // 3, 2 * K // 3, K - 1]
    lab = lambda i: f"#{i} · {dates[i][5:]}"
    a.imshow(rgb, aspect="auto", interpolation="nearest"); rows(a)
    a.set_xticks(xt, [lab(i) for i in xt], rotation=30, ha="right"); a.set_xlabel("commit")
    a.set_title("Each file's spectrum over time\n(R = size, G = definitions, B = coupling)", loc="left")
    n_mut = int(np.nansum(mut > 1e-12)); n_steps = int(np.sum(~np.isnan(mut)))
    im = b.imshow(np.where(mut > 1e-12, mut, np.nan), aspect="auto", interpolation="nearest", cmap="magma_r", vmin=0)
    b.set_facecolor("0.95"); rows(b)
    xs = [0, (K - 1) // 3, 2 * (K - 1) // 3, K - 2]
    b.set_xticks(xs, [f"#{i}→{i+1}" for i in xs], rotation=30, ha="right"); b.set_xlabel("commit step")
    b.set_title(f"Only {n_mut} of {n_steps} file-steps mutate", loc="left")
    fig.colorbar(im, ax=b, fraction=0.05, pad=0.02).set_label("‖v(t) − v(t−1)‖ (5-D, L2-normalized)")
    cat = np.where(~exists, np.nan, np.where(shatter < ANCHOR, 0, np.where(shatter < ALARM, 1, 2)))
    cm = ListedColormap(["#3b6ea8", "#c9c9c9", "#d1495b"])
    c.imshow(cat, aspect="auto", interpolation="nearest", cmap=cm, vmin=-0.5, vmax=2.5); rows(c)
    c.set_xticks(xt, [lab(i) for i in xt], rotation=30, ha="right"); c.set_xlabel("commit")
    n_alarm = int(np.sum(shatter[exists[:, -1], -1] >= ALARM))
    c.set_title(f"Shatter bands: {n_alarm} files in ALARM at HEAD", loc="left")
    c.legend(handles=[Patch(color=col, label=l) for col, l in
                      zip(cm.colors, ["ANCHOR <0.05", "REVIEW <0.15", "ALARM ≥0.15"])],
             loc="upper center", bbox_to_anchor=(0.5, -0.32), ncol=3, frameon=False, fontsize=7)
    d.bar(range(5), share, color=["0.6", "#d1495b", "0.6", "0.6", "0.6"])
    d.set_xticks(range(5), ["size", "complexity\nhash", "lines", "defs", "coupling"], fontsize=6)
    d.text(1, share[1] + 0.02, f"{share[1]:.1%}", ha="center", fontsize=7)
    d.set_ylim(0, 1); d.set_ylabel("share of mutation energy (Σ‖Δv‖²)")
    d.set_title("The hash band dominates movement through time", loc="left")
    for ax, l in zip([a, b, c, d], "abcd"):
        ax.text(-0.02, 1.08, l, transform=ax.transAxes, fontsize=10, fontweight="bold", ha="right")
    fig.savefig(path, dpi=200, bbox_inches="tight"); plt.close(fig)


def viewer(raw, nrm, exists, shatter, mut, share, files, commits, dates, path):
    import plotly.graph_objects as go
    F, K = len(files), len(commits)

    def pca2(X):
        m = ~np.isnan(X).any(1); mu = X[m].mean(0); _, S, Vt = np.linalg.svd(X[m] - mu, full_matrices=False)
        Y = np.full((len(X), 2), np.nan); Y[m] = (X[m] - mu) @ Vt[:2].T; return Y, (S ** 2 / np.sum(S ** 2))[:2]
    st = nrm.transpose(0, 2, 1).reshape(-1, 5)
    Ya, eva = pca2(st); s4 = st[:, STRUCT]; Ys, evs = pca2(s4 / np.linalg.norm(s4, axis=1, keepdims=True))
    Ya, Ys = Ya.reshape(F, K, 2), Ys.reshape(F, K, 2)
    nmut = np.nansum(mut > 1e-12, axis=1); n_events = int(np.nansum(mut > 1e-12))
    tr = []
    for f in range(F):
        ks = np.where(exists[f])[0]; m = nmut[f] > 0
        cd = [[files[f], int(k), dates[k], commits[k][2][:70], *np.round(raw[f, :, k], 4),
               round(float(shatter[f, k]), 4), str(band(shatter[f, k]))] for k in ks]
        tr.append(go.Scatter3d(
            x=Ya[f, ks, 0], y=Ya[f, ks, 1], z=ks, mode="lines+markers", customdata=cd, name=files[f], showlegend=False,
            line=dict(color="rgba(40,40,40,0.8)" if m else "rgba(150,150,150,0.35)", width=4 if m else 2),
            marker=dict(size=3.5 if m else 2.5, color=shatter[f, ks], cmin=0, cmax=0.225, showscale=(f == 0),
                        colorscale=[[0, "#3b6ea8"], [0.33, "#c9c9c9"], [0.66, "#c9c9c9"], [1, "#d1495b"]],
                        colorbar=dict(title="shatter", tickvals=[0, 0.05, 0.15, 0.225],
                                      ticktext=["0", "0.05 ANCHOR|", "0.15 |ALARM", "0.225"])),
            hovertemplate="<b>%{customdata[0]}</b><br>commit #%{customdata[1]} %{customdata[2]}<br>%{customdata[3]}<br>"
                          "size %{customdata[4]} · hash %{customdata[5]} · lines %{customdata[6]} · defs %{customdata[7]}"
                          " · coupling %{customdata[8]}<br>shatter %{customdata[9]} (%{customdata[10]})<extra></extra>"))
    fig = go.Figure(tr)
    btn = lambda Y, ev, lab: dict(label=lab, method="restyle", args=[
        {"x": [Y[f, np.where(exists[f])[0], 0] for f in range(F)],
         "y": [Y[f, np.where(exists[f])[0], 1] for f in range(F)]}, list(range(F))])
    fig.update_layout(height=720, margin=dict(l=0, r=0, t=60, b=0),
        title=f"Spectral terrain — {F} files × {K} commits. Vertical pillar = static file; kink = mutation "
              f"({n_events} events). Click a point.",
        scene=dict(xaxis_title="PC1", yaxis_title="PC2", zaxis_title="commit #", aspectmode="manual",
                   aspectratio=dict(x=1, y=1, z=1.4)),
        updatemenus=[dict(type="buttons", direction="right", x=0, y=1.06, buttons=[
            btn(Ya, eva, f"PCA: all 5 bands ({eva.sum():.0%} var)"),
            btn(Ys, evs, f"PCA: drop hash band ({evs.sum():.0%} var)")])])
    spec = go.Figure(layout=dict(height=320, barmode="group", margin=dict(t=50, l=50, r=10, b=40),
        title="Click a point → its [t−1 | t | t+1] structural spectrum",
        xaxis=dict(title="band"), yaxis=dict(title="L2-normalized value", range=[0, 1])))
    for nm, col in [("t−1", "#bbbbbb"), ("t", "#222222"), ("t+1", "#8fa8c8")]:
        spec.add_bar(x=["size", "hash", "lines", "defs", "coupling"], y=[0] * 5, name=nm, marker_color=col)
    NRM = {files[f]: [None if np.isnan(nrm[f, 0, k]) else np.round(nrm[f, :, k], 4).tolist() for k in range(K)]
           for f in range(F)}
    js = ("<script>const NRM=" + json.dumps(NRM) + ";"
          "document.getElementById('terrain').on('plotly_click',function(e){"
          "const p=e.points[0],f=p.customdata[0],k=p.customdata[1],s=NRM[f];"
          "const g=i=>(i>=0&&i<s.length&&s[i])?s[i]:[0,0,0,0,0];"
          "Plotly.restyle('spectrum',{y:[g(k-1),g(k),g(k+1)]},[0,1,2]);"
          "Plotly.relayout('spectrum',{title:f+' @ commit #'+k+' — shatter '+p.customdata[9]+' ('+p.customdata[10]+')'});"
          "});</script>")
    page = ("<!doctype html><html><head><meta charset='utf-8'><title>Spectral terrain — git history</title>"
            "<style>body{font-family:-apple-system,Helvetica,sans-serif;margin:16px;color:#222}"
            ".note{font-size:13px;color:#555;max-width:1100px}</style></head><body>"
            "<h2>spectral-terrain · structural fingerprint over git history</h2>"
            "<p class='note'>Each point is one file at one commit, embedded with the repo's own "
            "<code>structuralFingerprint</code> (5-D, L2-normalized), projected by PCA; height is commit index "
            "(time as a geometric axis). Colour = shatter (L2 distance to the HEAD-terrain centroid; bands ANCHOR "
            f"&lt;0.05, REVIEW &lt;0.15, ALARM ≥0.15). The complexity-hash band supplies {share[1]:.1%} of all "
            "movement through time — use the buttons to drop it.</p>"
            + fig.to_html(full_html=False, include_plotlyjs="inline", div_id="terrain")
            + spec.to_html(full_html=False, include_plotlyjs=False, div_id="spectrum") + js + "</body></html>")
    Path(path).write_text(page, encoding="utf-8")


if __name__ == "__main__":
    main()
