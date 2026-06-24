#!/usr/bin/env bash
# bench-full.sh — Full benchmark baseline (all spec files, ~10min)
set -euo pipefail
cd "$(dirname "$0")/.."
npx tsx src/benchmark/run-full.ts
