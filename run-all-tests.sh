#!/usr/bin/env bash
# run-all-tests.sh — Run fast tests in parallel, then ZMQ-heavy tests serially
# Target: full suite <200s
set -euo pipefail

cd "$(dirname "$0")"

echo "=============================================="
echo " Phase 1: Fast tests (parallel, no ZMQ confict)"
echo "=============================================="
START_FAST=$(date +%s)
NODE_OPTIONS='--max-old-space-size=4096' npx vitest run --config vitest.fast.config.ts --root . 2>&1
FAST_EXIT=$?
END_FAST=$(date +%s)
echo "Fast tests completed in $((END_FAST - START_FAST))s (exit=$FAST_EXIT)"

echo ""
echo "=============================================="
echo " Phase 2: ZMQ-heavy tests (serial)"
echo "=============================================="
START_ZMQ=$(date +%s)
NODE_OPTIONS='--max-old-space-size=4096' npx vitest run --config vitest.slow.config.ts --root . 2>&1
ZMQ_EXIT=$?
END_ZMQ=$(date +%s)
echo "ZMQ tests completed in $((END_ZMQ - START_ZMQ))s (exit=$ZMQ_EXIT)"

TOTAL=$((END_ZMQ - START_FAST))
echo ""
echo "=============================================="
echo " Full suite: ${TOTAL}s total"
echo " Fast: $((END_FAST - START_FAST))s | ZMQ: $((END_ZMQ - START_ZMQ))s"
echo " Exit codes: fast=$FAST_EXIT zmq=$ZMQ_EXIT"
echo "=============================================="

# Return failure if either phase failed
if [ $FAST_EXIT -ne 0 ] || [ $ZMQ_EXIT -ne 0 ]; then
  exit 1
fi
