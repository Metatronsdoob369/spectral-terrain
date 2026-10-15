#!/usr/bin/env python3
"""
naics_agent.py — Thin silence-first vehicle that mounts the NAICS accessory.

Not WhiteGlove (carrier husk). This is a single-accessory demo agent:
  question → resolve sector → nearest industries → structured answer
  OR silence (no fabrication).

Sellable demo path: prove an agent can tell industries apart from sealed
processed data — shards/pack/overlay — without DNA, without LLM freestyle.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

QUERY = Path(__file__).resolve().parent / "query_naics.py"


def run_query(*args: str) -> tuple[int, dict]:
    proc = subprocess.run(
        [sys.executable, str(QUERY), *args],
        capture_output=True,
        text=True,
    )
    raw = proc.stdout.strip() or proc.stderr.strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = {"ok": False, "silence": True, "reason": raw or "query failed"}
    return proc.returncode, data


def answer(question: str, neighbors: int) -> dict:
    code, resolved = run_query("resolve", question)
    if resolved.get("silence") or not resolved.get("ok"):
        return {
            "agent": "naics-silence-vehicle",
            "accessory": "naics-2022-3d",
            "question": question,
            "silence": True,
            "reason": resolved.get("reason", "no sector"),
            "answer": None,
        }

    sector = resolved["sector"]
    _, near = run_query("near", sector["naics_sector"], str(neighbors))
    neighbor_titles = [
        f"{n['naics_sector']} ({n['title'].split('—', 1)[-1].strip()}, score={n['score']})"
        for n in near.get("neighbors", [])
    ]

    prose = (
        f"{sector['title']} (heat={sector['heat']}). "
        f"Nearest industries: {'; '.join(neighbor_titles) if neighbor_titles else 'none'}."
    )
    return {
        "agent": "naics-silence-vehicle",
        "accessory": "naics-2022-3d",
        "question": question,
        "silence": False,
        "method": resolved.get("method"),
        "confidence": resolved.get("confidence"),
        "sector": sector,
        "neighbors": near.get("neighbors", []),
        "answer": prose,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="NAICS silence-first demo agent")
    ap.add_argument("question", nargs="+", help="Industry question or label")
    ap.add_argument("--neighbors", type=int, default=3)
    ap.add_argument("--prose", action="store_true", help="Print answer line only")
    args = ap.parse_args()
    question = " ".join(args.question)
    out = answer(question, args.neighbors)
    if args.prose:
        if out["silence"]:
            print(f"SILENCE: {out['reason']}")
            return 2
        print(out["answer"])
        return 0
    print(json.dumps(out, indent=2))
    return 2 if out["silence"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
