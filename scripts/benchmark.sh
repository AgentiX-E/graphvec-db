#!/usr/bin/env bash
# benchmark.sh — GraphVec 性能基准
# 使用方式: bash scripts/benchmark.sh
# 依赖: npx tsx

set -euo pipefail
cd "$(dirname "$0")/.."

BOLD='\033[1m'; GREEN='\033[0;32m'; NC='\033[0m'
SUMMARY_FILE="temp/benchmark-result.json"
rm -f "$SUMMARY_FILE"

echo -e "${BOLD}═══════════════════════════════════════════${NC}"
echo -e "${BOLD}  GraphVec 性能基准${NC}"
echo -e "${BOLD}═══════════════════════════════════════════${NC}"

run_bench() {
  local name="$1" script="$2"
  echo -e "\n${BOLD}$name${NC}..."
  local tmpf; tmpf=$(mktemp)
  if npx tsx -e "$script" > "$tmpf" 2>&1; then
    echo -ne "  ${GREEN}✓${NC}  "
    head -1 "$tmpf"
    tail -n +2 "$tmpf" | while IFS= read -r line; do echo "  $line"; done
  else
    head -5 "$tmpf" | while IFS= read -r line; do echo "  $line"; done
    echo "  FAIL"
    echo "{\"pass\":false,\"name\":\"$name\"}" >> "$SUMMARY_FILE"
  fi
  rm -f "$tmpf"
}

# ════════════════════════════════════════════
# 1. GE _scanNodesByLabel（_labelStrIndex 加速验证）
# ════════════════════════════════════════════
run_bench "GE _scanNodesByLabel (50K, 35K Person)" '
const { GraphEngine } = require("./src/core/graph-engine")
const g = new GraphEngine({ path: "/tmp/bench-bl-" + Date.now() }); g.open()
for (let i = 0; i < 35000; i++) g.upsertNode(1, "p" + i, { props: { _label: "Person", name: "person-" + i } })
for (let i = 0; i < 15000; i++) g.upsertNode(2, "o" + i, { props: { _label: "Other" } })
console.log("scan(_label=Person) x20")
const t0 = performance.now(); let sum = 0
for (let r = 0; r < 20; r++) { const n = g._scanNodesByLabel("Person"); sum += n.length }
const ms = performance.now() - t0
console.log("  avg: " + (ms / 20).toFixed(3) + " ms, sum=" + sum)
g.close()
'

# ════════════════════════════════════════════
# 2. GE scanAllNodes 吞吐
# ════════════════════════════════════════════
run_bench "GE scanAllNodes (50K nodes x20)" '
const { GraphEngine } = require("./src/core/graph-engine")
const g = new GraphEngine({ path: "/tmp/bench-scan-" + Date.now() }); g.open()
for (let i = 0; i < 50000; i++) g.upsertNode(1, "n" + i, { props: { _label: "Node", seq: i } })
const t0 = performance.now()
for (let r = 0; r < 20; r++) { g.scanAllNodes() }
const ms = performance.now() - t0
console.log("  avg: " + (ms / 20).toFixed(2) + " ms, ops/sec: " + ((20 / ms) * 1000).toFixed(0))
g.close()
'

# ════════════════════════════════════════════
# 3. GE neighbors 吞吐
# ════════════════════════════════════════════
# ════════════════════════════════════════════
# 3. GE query MATCH (n) 吞吐（query-engine）
# ════════════════════════════════════════════
run_bench "GE query (10K nodes, MATCH (n:Person) RETURN n)" '
const { GraphEngine } = require("./src/core/graph-engine")
const g = new GraphEngine({ path: "/tmp/bench-q-" + Date.now() }); g.open()
for (let i = 0; i < 10000; i++) g.upsertNode(1, "n" + i, { props: { _label: "Person", name: "p" + i } })
const t0 = performance.now()
for (let r = 0; r < 50; r++) { g._scanNodesByLabel("Person") }
const ms = performance.now() - t0
console.log("  avg: " + (ms / 50).toFixed(3) + " ms, ops/sec: " + ((50 / ms) * 1000).toFixed(0))
g.close()
'

# ════════════════════════════════════════════
echo ""
echo -e "${BOLD}═══════════════════════════════════════════${NC}"
echo -e "${BOLD}  基准测试完成${NC}"
echo -e "${BOLD}═══════════════════════════════════════════${NC}"
