#!/usr/bin/env bash
# benchmark.sh — GraphVec 性能基准
# 使用方式: bash scripts/benchmark.sh
# 依赖: npx tsx

set -euo pipefail
cd "$(dirname "$0")/.."

BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'
SUMMARY_FILE="temp/benchmark-result.json"
rm -f "$SUMMARY_FILE"

echo -e "${BOLD}═══════════════════════════════════════════${NC}"
echo -e "${BOLD}  GraphVec 性能基准 v2${NC}"
echo -e "${BOLD}  日期: $(date '+%Y-%m-%d %H:%M')${NC}"
echo -e "${BOLD}═══════════════════════════════════════════${NC}"

run_bench() {
  local name="$1" script="$2"
  echo -e "\n${CYAN}▶ ${BOLD}$name${NC}${NC}"
  local tmpf; tmpf=$(mktemp)
  if npx tsx -e "$script" > "$tmpf" 2>&1; then
    while IFS= read -r line; do echo -e "  ${GREEN}▸${NC} $line"; done < "$tmpf"
    echo -e "  ${GREEN}✓ 完成${NC}"
  else
    while IFS= read -r line; do echo -e "  ${YELLOW}▸${NC} $line"; done < "$tmpf"
    echo -e "  ${BOLD}✗ FAIL${NC}"
    echo "{\"pass\":false,\"name\":\"$name\"}" >> "$SUMMARY_FILE"
  fi
  rm -f "$tmpf"
}

# ════════════════════════════════════════════
# 1. GE _scanNodesByLabel（_labelStrIndex 40x 加速）
# ════════════════════════════════════════════
GE_TS=$(cat << 'TSEOF'
import { GraphEngine } from "./src/core/graph-engine"
import fs from "fs"
const dir = "/tmp/bench-bl-" + Date.now()
fs.mkdirSync(dir, { recursive: true })
const g = new GraphEngine({ path: dir }); g.open()
for (let i = 0; i < 35000; i++) g.upsertNode(1, "p" + i, { props: { _label: "Person", name: "person-" + i } })
for (let i = 0; i < 15000; i++) g.upsertNode(2, "o" + i, { props: { _label: "Other" } })
console.log("scan(_label=Person, 35K+15K nodes) x20")
const t0 = performance.now(); let sum = 0
for (let r = 0; r < 20; r++) { const n = g._scanNodesByLabel("Person"); sum += n.length }
const ms = performance.now() - t0
console.log("avg: " + (ms / 20).toFixed(3) + " ms, total returned: " + sum)
g.close()
TSEOF
)

# ════════════════════════════════════════════
# 2. GE scanAllNodes 吞吐
# ════════════════════════════════════════════
SCAN_TS=$(cat << 'TSEOF'
import { GraphEngine } from "./src/core/graph-engine"
import fs from "fs"
const dir = "/tmp/bench-scan-" + Date.now()
fs.mkdirSync(dir, { recursive: true })
const g = new GraphEngine({ path: dir }); g.open()
for (let i = 0; i < 50000; i++) g.upsertNode(1, "n" + i, { props: { _label: "Node", seq: i } })
const t0 = performance.now()
for (let r = 0; r < 20; r++) { g.scanAllNodes() }
const ms = performance.now() - t0
console.log("scanAllNodes(50K) x20")
console.log("avg: " + (ms / 20).toFixed(2) + " ms, ops/sec: " + ((20 / ms) * 1000).toFixed(0))
g.close()
TSEOF
)

# ════════════════════════════════════════════
# 3. GE MATCH (n:Person) 全链路
# ════════════════════════════════════════════
MATCH_TS=$(cat << 'TSEOF'
import { GraphEngine } from "./src/core/graph-engine"
import fs from "fs"
const dir = "/tmp/bench-match-" + Date.now()
fs.mkdirSync(dir, { recursive: true })
const g = new GraphEngine({ path: dir }); g.open()
for (let i = 0; i < 10000; i++) g.upsertNode(1, "n" + i, { props: { _label: "Person", name: "p" + i, age: (i % 100) } })
console.log("query 'MATCH (n:Person) WHERE n.age > 25 RETURN n' x50")
const q = "MATCH (n:Person) WHERE n.age > 25 RETURN n"
const t0 = performance.now()
for (let r = 0; r < 50; r++) { g.query(q) }
const ms = performance.now() - t0
console.log("avg: " + (ms / 50).toFixed(3) + " ms, ops/sec: " + ((50 / ms) * 1000).toFixed(0))
g.close()
TSEOF
)

# ════════════════════════════════════════════
# 4. GE MATCH 含边查询
# ════════════════════════════════════════════
EDGE_TS=$(cat << 'TSEOF'
import { GraphEngine } from "./src/core/graph-engine"
import fs from "fs"
const dir = "/tmp/bench-edge-" + Date.now()
fs.mkdirSync(dir, { recursive: true })
const g = new GraphEngine({ path: dir }); g.open()
// 5K Person + 5K City, 15K KNOWS 边
for (let i = 0; i < 5000; i++) g.upsertNode(1, "p" + i, { props: { _label: "Person", name: "p" + i } })
for (let i = 0; i < 5000; i++) g.upsertNode(2, "c" + i, { props: { _label: "City", name: "city" + i } })
for (let i = 0; i < 15000; i++) {
  const s = Math.floor(Math.random() * 5000); const d = Math.floor(Math.random() * 5000)
  g.upsertEdge(s, d, 1)
}
console.log("query 'MATCH (n:Person)-[:KNOWS]->(m:Person) RETURN m' x30")
const q = "MATCH (n:Person)-[:KNOWS]->(m:Person) RETURN m"
const t0 = performance.now(); let sumEdge = 0
for (let r = 0; r < 30; r++) { const res = g.query(q); sumEdge += res.length }
const ms = performance.now() - t0
console.log("avg: " + (ms / 30).toFixed(3) + " ms, total rows: " + sumEdge)
g.close()
TSEOF
)

# ════════════════════════════════════════════
# 5. query-engine _executeQuery 全链路
# ════════════════════════════════════════════
QE_TS=$(cat << 'TSEOF'
import { GraphEngine } from "./src/core/graph-engine"
import { parseQuery, _executeQuery } from "./src/query/query-engine"
import fs from "fs"
const nodes: any[] = []
for (let i = 0; i < 10000; i++) nodes.push({ name: "p" + i, age: i % 100, _label: "Person" })
const plan = parseQuery("MATCH (n:Person) WHERE n.age > 25 RETURN n")
console.log("query-engine _executeQuery (10K nodes, MATCH+WHERE) x20")
const t0 = performance.now()
for (let r = 0; r < 20; r++) { const res = _executeQuery(plan, nodes) }
const ms = performance.now() - t0
console.log("avg: " + (ms / 20).toFixed(3) + " ms")
TSEOF
)

# ════════════════════════════════════════════
# 6. query-engine MATCH 含边全链路
# ════════════════════════════════════════════
QE_EDGE_TS=$(cat << 'TSEOF'
import { parseQuery, _executeQuery } from "./src/query/query-engine"
const nodes: any[] = []
// 500 Person + 边 (Person -> KNOWS -> Person)
for (let i = 0; i < 500; i++) nodes.push({ name: "p" + i, age: i % 100, _label: "Person" })
const edges: any[] = []
for (let i = 0; i < 3000; i++) edges.push({ srcIdx: Math.floor(Math.random() * 500), dstIdx: Math.floor(Math.random() * 500), label: "KNOWS" })
nodes[0].__edges = edges
const plan = parseQuery("MATCH (n:Person)-[:KNOWS]->(m:Person) RETURN m")
console.log("query-engine _executeQuery (500 nodes, 3K edges) x30")
const t0 = performance.now()
for (let r = 0; r < 30; r++) { const res = _executeQuery(plan, nodes) }
const ms = performance.now() - t0
console.log("avg: " + (ms / 30).toFixed(3) + " ms")
TSEOF
)

# ════════════════════════════════════════════
# Execute all benchmarks
# ════════════════════════════════════════════
run_bench "1. GE _scanNodesByLabel (35K Person + 15K Other) x20" "$GE_TS"
run_bench "2. GE scanAllNodes (50K) x20" "$SCAN_TS"
run_bench "3. GE query MATCH (n:Person) WHERE n.age > 25 (10K) x50" "$MATCH_TS"
run_bench "4. GE query MATCH (5K Person)-(15K edges)->Person x30" "$EDGE_TS"
run_bench "5. QE _executeQuery MATCH(n:Person) WHERE age>25 (10K) x20" "$QE_TS"
run_bench "6. QE _executeQuery MATCH (500 nodes, 3K edges) x30" "$QE_EDGE_TS"

# ════════════════════════════════════════════
echo ""
echo -e "${BOLD}═══════════════════════════════════════════${NC}"
echo -e "${BOLD}  基准测试完成${NC}"
echo -e "${BOLD}═══════════════════════════════════════════${NC}"
