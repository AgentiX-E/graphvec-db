#!/usr/bin/env bash
# perf.sh — Quick benchmark smoke test + regression gate (~30s)
#
# Usage:
#   ./scripts/perf.sh              # run perf + compare vs latest baseline
#   ./scripts/perf.sh --save       # run perf + compare + save new baseline
#   ./scripts/perf.sh --threshold=30  # custom threshold%
set -euo pipefail
cd "$(dirname "$0")/.."

# Default: enable flaky-skip for stable gate
if [[ "$*" != *"--threshold="* ]] && [[ "$*" != *"--flaky"* ]] && [[ "$*" != *"--no-flaky"* ]]; then
  set -- "$@" --flaky
fi

exec npx tsx src/benchmark/gate.ts "$@"
