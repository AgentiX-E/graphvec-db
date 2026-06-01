#!/bin/bash
set -e
cd /home/admin/openclaw/workspace/agentiX-graphvec
rm -rf test-data/
export NODE_OPTIONS='--max-old-space-size=4096'
echo "[$(date)] Starting full suite..." >> /tmp/final-suite-status.txt
npx vitest run --config vitest.config.ts > /tmp/final-suite.log 2>&1
echo "[$(date)] Exit code: $?" >> /tmp/final-suite-status.txt
grep -E '(Test Files|Tests|FAIL|passed|failed)' /tmp/final-suite.log >> /tmp/final-suite-status.txt
