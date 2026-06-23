#!/usr/bin/env bash
# benchmark.sh — GraphVec 性能基准 v3
# 使用方式: bash scripts/benchmark.sh
# 依赖: npx tsx
#
# 基准测试类别:
#   1. GE 原生 API 性能 — 插入 N 节点 + M 边后的查询性能
#   2. CALL 子句性能 — standalone CALL + in-query CALL 延迟
#   3. MATCH 扫描性能 — 全量扫描 vs hashIndex 查询
#   4. 回归对比 — 保存基线到 bench-results/ 目录

set -euo pipefail
cd "$(dirname "$0")/.."

BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; RED='\033[0;31m'; NC='\033[0m'
TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
TS_COMPACT=$(date '+%Y-%m-%d-%H%M')
RESULTS_FILE="bench-results/${TS_COMPACT}.json"

mkdir -p bench-results

echo -e "${BOLD}══════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  GraphVec 性能基准 v3                          ${NC}"
echo -e "${BOLD}  日期: ${TIMESTAMP}                              ${NC}"
echo -e "${BOLD}══════════════════════════════════════════════════════${NC}"

# ── 全局 JSON 汇总 ──
RESULTS_JSON='{}'

# ── 辅助函数 ──
run_bench() {
  local name="$1" script="$2" key="$3"
  echo -e "\n${CYAN}▶ ${BOLD}${name}${NC}${NC}"
  local tmpf; tmpf=$(mktemp)
  if npx tsx -e "$script" > "$tmpf" 2>&1; then
    local output; output=$(cat "$tmpf")
    echo "${output}" | while IFS= read -r line; do echo -e "  ${GREEN}▸${NC} $line"; done
    echo -e "  ${GREEN}✓ 完成${NC}"
    # 提取 JSON 行（以 BENCH_JSON: 开头）
    local json_line; json_line=$(echo "$output" | grep "^BENCH_JSON:" | head -1 | sed 's/^BENCH_JSON://')
    if [ -n "$json_line" ]; then
      RESULTS_JSON=$(echo "$RESULTS_JSON" | jq --argjson val "$json_line" ". + {\"$key\": \$val}" 2>/dev/null || echo "$RESULTS_JSON")
    fi
  else
    while IFS= read -r line; do echo -e "  ${YELLOW}▸${NC} $line"; done < "$tmpf"
    echo -e "  ${BOLD}${RED}✗ FAIL${NC}"
    RESULTS_JSON=$(echo "$RESULTS_JSON" | jq ". + {\"$key\": {\"status\": \"FAIL\"}}" 2>/dev/null || echo "$RESULTS_JSON")
  fi
  rm -f "$tmpf"
}

# ═══════════════════════════════════════════════════════════════════
# 1. GE 原生 API 性能
#   插入 N 节点 + M 边后的查询性能（getNode / neighbors / scanAllNodes）
# ═══════════════════════════════════════════════════════════════════
GE_NATIVE=$(cat << 'TSEOF'
import { GraphEngine } from "./src/core/graph-engine"
import fs from "fs"

function report(key: string, data: Record<string, number>) {
  process.stdout.write("BENCH_JSON:" + JSON.stringify(data) + "\n")
  const tbl = "| Metric | Value |\n|--------|-------|\n" +
    Object.entries(data).map(([k, v]) => `| ${k} | ${v.toFixed(3)} ms |`).join("\n")
  console.log(tbl)
}

const dir = "/tmp/bench-ge-" + Date.now()
fs.mkdirSync(dir, { recursive: true })
const g = new GraphEngine({ path: dir }); g.open()

// 插入 10K 节点 + 50K 边
const N = 10000, M = 50000
for (let i = 0; i < N; i++) g.upsertNode(1, "n" + i, { props: { _label: "Person", name: "p" + i, age: i % 100 } })
for (let i = 0; i < M; i++) {
  const s = Math.floor(Math.random() * N), d = Math.floor(Math.random() * N)
  if (s !== d) g.upsertEdge(s, d, 1, { props: { weight: Math.random() } })
}

// getNode 延迟 (50 runs median)
const getTimings: number[] = []
for (let r = 0; r < 50; r++) {
  const id = Math.floor(Math.random() * N)
  const t0 = performance.now(); g.getNode(id); getTimings.push(performance.now() - t0)
}
getTimings.sort((a, b) => a - b)
const getMed = getTimings[25]
const getP95 = getTimings[47]

// neighbors 延迟 (30 runs median)
const nbTimings: number[] = []
for (let r = 0; r < 30; r++) {
  const id = Math.floor(Math.random() * N)
  const t0 = performance.now(); g.neighbors(id); nbTimings.push(performance.now() - t0)
}
nbTimings.sort((a, b) => a - b)
const nbMed = nbTimings[15]

// scanAllNodes 延迟 (20 runs)
const scanTimings: number[] = []
for (let r = 0; r < 20; r++) { const t0 = performance.now(); g.scanAllNodes(); scanTimings.push(performance.now() - t0) }
scanTimings.sort((a, b) => a - b)
const scanMed = scanTimings[10]

// MATCH 查询 (30 runs)
const matchTimings: number[] = []
for (let r = 0; r < 30; r++) { const t0 = performance.now(); g.query("MATCH (n:Person) WHERE n.age > 25 RETURN n"); matchTimings.push(performance.now() - t0) }
matchTimings.sort((a, b) => a - b)
const matchMed = matchTimings[15]

g.close()
console.log(`\n**GE 原生 API (N=${N} nodes, M=${M} edges) — 50 getNode, 30 neighbors, 20 scan, 30 MATCH**`)
report("ge-native", {
  "nodes": N, "edges": M,
  "getNode_median_ms": getMed, "getNode_p95_ms": getP95,
  "neighbors_median_ms": nbMed, "scanAllNodes_median_ms": scanMed,
  "match_median_ms": matchMed
})
TSEOF
)

# ═══════════════════════════════════════════════════════════════════
# 2. CALL 子句性能
#   standalone CALL + in-query CALL 延迟
# ═══════════════════════════════════════════════════════════════════
CALL_PERF=$(cat << 'TSEOF'
import { GraphEngine } from "./src/core/graph-engine"
import fs from "fs"

function report(key: string, data: Record<string, number>) {
  process.stdout.write("BENCH_JSON:" + JSON.stringify(data) + "\n")
  const tbl = "| Metric | Value |\n|--------|-------|\n" +
    Object.entries(data).map(([k, v]) => `| ${k} | ${v.toFixed(3)} ms |`).join("\n")
  console.log(tbl)
}

const dir = "/tmp/bench-call-" + Date.now()
fs.mkdirSync(dir, { recursive: true })
const g = new GraphEngine({ path: dir }); g.open()

// 插入数据
for (let i = 0; i < 5000; i++) g.upsertNode(1, "p" + i, { props: { _label: "Person", name: "person-" + i, age: i % 80 } })

// standalone CALL: CALL { MATCH (n:Person) RETURN n.name } RETURN n.name
const standaloneTimings: number[] = []
const callQ = "CALL { MATCH (n:Person) RETURN n.name AS name } RETURN name"
for (let r = 0; r < 30; r++) { const t0 = performance.now(); g.query(callQ); standaloneTimings.push(performance.now() - t0) }
standaloneTimings.sort((a, b) => a - b)
const standaloneMed = standaloneTimings[15]

// in-query CALL (CALL 内嵌 MATCH WHERE)
const inQueryTimings: number[] = []
const inQueryQ = "CALL { MATCH (n:Person) WHERE n.age > 30 RETURN n.name AS name } RETURN name"
for (let r = 0; r < 30; r++) { const t0 = performance.now(); g.query(inQueryQ); inQueryTimings.push(performance.now() - t0) }
inQueryTimings.sort((a, b) => a - b)
const inQueryMed = inQueryTimings[15]

// CALL IN TRANSACTIONS (分批提交)
const batchTimings: number[] = []
const batchQ = "CALL { MATCH (n:Person) RETURN n.name AS name } IN TRANSACTIONS OF 100 ROWS RETURN name"
for (let r = 0; r < 10; r++) {
  try { const t0 = performance.now(); g.query(batchQ); batchTimings.push(performance.now() - t0) }
  catch { /* IN TRANSACTIONS may not fully support sync execution */ }
}

g.close()
console.log(`\n**CALL 子句性能 (5K Person nodes, 30 runs each)**`)
report("call-subquery", {
  "standalone_CALL_median_ms": standaloneMed,
  "inquery_CALL_median_ms": inQueryMed,
  "call_IN_TRANSACTIONS_median_ms": batchTimings.length > 0 ? batchTimings.sort((a,b)=>a-b)[Math.floor(batchTimings.length/2)] : -1
})
TSEOF
)

# ═══════════════════════════════════════════════════════════════════
# 3. MATCH 扫描性能
#   全量扫描 vs hashIndex 查询
# ═══════════════════════════════════════════════════════════════════
MATCH_SCAN=$(cat << 'TSEOF'
import { GraphEngine } from "./src/core/graph-engine"
import fs from "fs"

function report(key: string, data: Record<string, number>) {
  process.stdout.write("BENCH_JSON:" + JSON.stringify(data) + "\n")
  const tbl = "| Metric | Value |\n|--------|-------|\n" +
    Object.entries(data).map(([k, v]) => `| ${k} | ${v.toFixed(3)} ms |`).join("\n")
  console.log(tbl)
}

const dir = "/tmp/bench-scan-" + Date.now()
fs.mkdirSync(dir, { recursive: true })
const g = new GraphEngine({ path: dir }); g.open()

// 在 GE 有 label hashIndex 的情况下测试
// 插入 20K 节点: 10K Person (age 0-99) + 10K Other
for (let i = 0; i < 10000; i++) g.upsertNode(1, "p" + i, { props: { _label: "Person", name: "p" + i, age: i % 100 } })
for (let i = 0; i < 10000; i++) g.upsertNode(2, "o" + i, { props: { _label: "Other" } })

// 全量扫描: MATCH (n) RETURN n
const fullScanTimings: number[] = []
for (let r = 0; r < 20; r++) { const t0 = performance.now(); g.query("MATCH (n) RETURN n"); fullScanTimings.push(performance.now() - t0) }
fullScanTimings.sort((a, b) => a - b)
const fullScanMed = fullScanTimings[10]

// hashIndex 扫描: MATCH (n:Person) (利用 _labelStrIndex)
const indexTimings: number[] = []
for (let r = 0; r < 20; r++) { const t0 = performance.now(); g.query("MATCH (n:Person) RETURN n"); indexTimings.push(performance.now() - t0) }
indexTimings.sort((a, b) => a - b)
const indexMed = indexTimings[10]

// WHERE 过滤 (走 scan + filter)
const whereTimings: number[] = []
for (let r = 0; r < 20; r++) { const t0 = performance.now(); g.query("MATCH (n:Person) WHERE n.age > 50 RETURN n"); whereTimings.push(performance.now() - t0) }
whereTimings.sort((a, b) => a - b)
const whereMed = whereTimings[10]

// 全量扫描小数据集 (5K)
const smallerScanTimings: number[] = []
for (let r = 0; r < 20; r++) { const t0 = performance.now(); g.query("MATCH (n) RETURN n LIMIT 5000"); smallerScanTimings.push(performance.now() - t0) }
smallerScanTimings.sort((a, b) => a - b)
const smallerScanMed = smallerScanTimings[10]

g.close()
console.log(`\n**MATCH 扫描性能 (20K total: 10K Person + 10K Other, 20 runs each)**`)
console.log("")
report("match-scan", {
  "full_scan_20K_median_ms": fullScanMed,
  "label_index_scan_Person_median_ms": indexMed,
  "label_scan_WHERE_age_gt50_median_ms": whereMed,
  "full_scan_LIMIT_5K_median_ms": smallerScanMed,
  "index_vs_scan_speedup_x": indexMed > 0 ? (fullScanMed / indexMed) : 0
})
TSEOF
)

# ═══════════════════════════════════════════════════════════════════
# 4. 吞吐量 — 批量插入 + 边操作 (回归基线用)
# ═══════════════════════════════════════════════════════════════════
THROUGHPUT=$(cat << 'TSEOF'
import { GraphEngine } from "./src/core/graph-engine"
import fs from "fs"

function report(key: string, data: Record<string, number>) {
  process.stdout.write("BENCH_JSON:" + JSON.stringify(data) + "\n")
  const tbl = "| Metric | Value |\n|--------|-------|\n" +
    Object.entries(data).map(([k, v]) => `| ${k} | ${v.toFixed(3)} ms |`).join("\n")
  console.log(tbl)
}

const dir = "/tmp/bench-tp-" + Date.now()
fs.mkdirSync(dir, { recursive: true })
const g = new GraphEngine({ path: dir }); g.open()

// 批量插入 5K 节点吞吐
const t0 = performance.now()
for (let i = 0; i < 5000; i++) g.upsertNode(1, "tp" + i, { props: { _label: "Node", seq: i } })
const bulkInsertMs = performance.now() - t0

// 批量创建 20K 边吞吐
const t1 = performance.now()
for (let i = 0; i < 20000; i++) {
  const s = Math.floor(Math.random() * 5000), d = Math.floor(Math.random() * 5000)
  if (s !== d) g.upsertEdge(s, d, 1, { props: {} })
}
const bulkEdgeMs = performance.now() - t1

// 删除 500 节点吞吐
const t2 = performance.now()
for (let i = 0; i < 500; i++) g.deleteNode(i)
const deleteMs = performance.now() - t2

g.close()
console.log(`\n**吞吐量基线 (5000 nodes insert, 20000 edges, 500 deletes)**`)
report("throughput", {
  "bulkInsert_5K_nodes_ms": bulkInsertMs,
  "bulkInsert_5K_nodes_opsPerSec": 5000 / (bulkInsertMs/1000),
  "bulkEdge_20K_ms": bulkEdgeMs,
  "bulkEdge_20K_opsPerSec": 20000 / (bulkEdgeMs/1000),
  "delete_500_nodes_ms": deleteMs,
  "delete_500_nodes_opsPerSec": 500 / (deleteMs/1000)
})
TSEOF
)

# ═══════════════════════════════════════════════════════════════════
# Execute
# ═══════════════════════════════════════════════════════════════════
run_bench "1. GE 原生 API (10K nodes, 50K edges)" "$GE_NATIVE" "ge-native"
run_bench "2. CALL 子句 (5K nodes, standalone + in-query)" "$CALL_PERF" "call-subquery"
run_bench "3. MATCH 扫描 (20K nodes, full scan vs index)" "$MATCH_SCAN" "match-scan"
run_bench "4. 吞吐量基线 (5K nodes, 20K edges, 500 deletes)" "$THROUGHPUT" "throughput"

# ── 保存结果 ──
echo "$RESULTS_JSON" | jq ". + {\"timestamp\": \"${TS_COMPACT}\", \"date\": \"${TIMESTAMP}\"}" > "$RESULTS_FILE" 2>/dev/null || {
  echo "$RESULTS_JSON" > "$RESULTS_FILE"
}
echo ""
echo -e "${BOLD}══════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  结果已保存: ${RESULTS_FILE}${NC}"
echo -e "${BOLD}══════════════════════════════════════════════════════${NC}"
