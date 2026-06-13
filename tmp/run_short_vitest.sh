#!/usr/bin/env bash
# 只跑一小部分测试，快速验证基线
set -euo pipefail
BASEDIR="/home/admin/openclaw/workspace/agentiX-graphvec"
cd "$BASEDIR"

# 1) 先试试只跑 3 个关键测试文件
timeout 20 node node_modules/.bin/vitest run --coverage.enabled=false --reporter=verbose src/core/graph-engine.spec.ts 2>&1 || exit 1
