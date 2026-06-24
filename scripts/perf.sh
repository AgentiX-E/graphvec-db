#!/usr/bin/env bash
# perf.sh — Quick benchmark smoke test + regression gate (~30s)
#
# Usage:
#   ./scripts/perf.sh              # run perf + compare vs latest baseline
#   ./scripts/perf.sh --save       # run perf + compare + save new baseline
#   ./scripts/perf.sh --threshold=15  # custom threshold%
set -euo pipefail
cd "$(dirname "$0")/.."
npx tsx src/benchmark/gate.ts "$@"
