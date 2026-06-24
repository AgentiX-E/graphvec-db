#!/usr/bin/env bash
# perf.sh — Quick benchmark smoke test (~30s)
set -euo pipefail
cd "$(dirname "$0")/.."
npx tsx src/benchmark/run-perf.ts
