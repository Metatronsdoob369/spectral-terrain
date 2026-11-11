#!/usr/bin/env bash
# Load spectral-map points into their OWN Qdrant collections (never touches existing ones).
#   spectral-git-history-5   5-D structuralFingerprint (L2-normalized), cosine
#   spectral-git-history-4c  4-D hash-free, HEAD-centred + standardized, cosine
# Usage: spectral-map/load_qdrant.sh [http://127.0.0.1:6333]
set -euo pipefail
Q="${1:-http://127.0.0.1:6333}"
OUT="$(cd "$(dirname "$0")" && pwd)/out"
load () {  # name dim file
  curl -s -X PUT "$Q/collections/$1" -H 'Content-Type: application/json' \
       -d "{\"vectors\":{\"size\":$2,\"distance\":\"Cosine\"}}" >/dev/null || true
  curl -s -X PUT "$Q/collections/$1/points?wait=true" -H 'Content-Type: application/json' \
       --data-binary @"$OUT/$3"; echo
  echo "$1: $(curl -s "$Q/collections/$1" | grep -o '"points_count":[0-9]*')"
}
load spectral-git-history-5  5 qdrant_points_5d.json
load spectral-git-history-4c 4 qdrant_points_4d_centred.json
