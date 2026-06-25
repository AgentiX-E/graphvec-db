#!/usr/bin/env bash
# perf.sh — Quick benchmark + regression gate
#
# Usage:
#   ./scripts/perf.sh                          # perf mode + gate
#   ./scripts/perf.sh --save                   # perf mode + save baseline
#   ./scripts/perf.sh --full --save             # full mode + save baseline
#   ./scripts/perf.sh --threshold=30            # custom threshold%
set -euo pipefail
cd "$(dirname "$0")/.."

FULL=false
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--full" ]; then FULL=true; else ARGS+=("$arg"); fi
done

if $FULL; then
  exec npx tsx -e "
    import { full } from './src/benchmark/runner'
    const baseline = await full()
    console.log('✅ Full baseline completed:', baseline.results.length, 'metrics')
  "
else
  # Default: enable flaky-skip for stable gate
  if [[ "$*" != *"--threshold="* ]] && [[ "$*" != *"--flaky"* ]] && [[ "$*" != *"--no-flaky"* ]]; then
    set -- "$@" --flaky
  fi
  exec npx tsx src/benchmark/gate.ts "$@"
fi
