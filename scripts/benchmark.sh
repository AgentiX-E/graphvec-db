#!/usr/bin/env bash
# benchmark.sh — GraphEngine / QueryEngine 性能基准
# 使用方式: bash scripts/benchmark.sh [--quick]

set -euo pipefail
cd "$(dirname "$0")/.."

echo "═══════════════════════════════════════════"
echo "  GraphVec 性能基准"
echo "═══════════════════════════════════════════"
echo ""

# ── 1. GE 原生 API 吞吐 ──
echo "▶ [1/4] GE: 100K 节点扫描..."
timeout 30 node -e "
const { GraphEngine } = require('./src/core/graph-engine.ts' as any)
const g = new GraphEngine({ path: '/tmp/bench-ge-' + Date.now(), denseVector: { dimension: 384 } })
g.open()
for (let i = 0; i < 100000; i++) g.upsertNode(1, 'n' + i, { props: { _label: 'Person', name: 'node-' + i, age: Math.floor(Math.random() * 100) } })
const start = Date.now()
for (let i = 0; i < 100000; i++) g.getNode(i + 1)
const dur = Date.now() - start
const ops = (100000 / dur * 1000).toFixed(0)
console.log('  100K getNode: ' + dur + 'ms → ' + ops + ' ops/s')
g.close()
" 2>&1 || echo "  ⚠️  Skipped (GE requires tsx)"

# ── 2. query-engine 查询吞吐 ──
echo ""
echo "▶ [2/4] query-engine: 1000 节点 MATCH 查询..."
timeout 30 node -e "
const { _executeQuery, parseQuery } = require('./src/query/query-engine.ts' as any)
const nodes = Array.from({length: 1000}, (_,i) => ({_label: 'Person', name: 'node-'+i, age: i}))
const plan = parseQuery(\"MATCH (n:Person) WHERE n.age > 500 RETURN n.name\")
const start = Date.now()
for (let i = 0; i < 1000; i++) _executeQuery(plan, nodes)
const dur = Date.now() - start
const qps = (1000 / dur * 1000).toFixed(0)
console.log('  1000 queries: ' + dur + 'ms → ' + qps + ' qps')
" 2>&1 || echo "  ⚠️  Skipped"

# ── 3. 索引加速 benchmark ──
echo ""
echo "▶ [3/4] 索引加速: 10000 节点 + index..."
timeout 30 node -e "
const { _executeQuery, parseQuery, _registerIndex, _clearIndexes } = require('./src/query/query-engine.ts' as any)
_clearIndexes()
_registerIndex('Person', 'age')
const nodes = Array.from({length: 10000}, (_,i) => ({_label: 'Person', name: 'node-'+i, age: i}))
const plan = parseQuery(\"MATCH (n:Person) WHERE n.age = 5000 RETURN n.name\")
const start = Date.now()
for (let i = 0; i < 500; i++) _executeQuery(plan, nodes)
const dur = Date.now() - start
const qps = (500 / dur * 1000).toFixed(0)
console.log('  500 queries (with index): ' + dur + 'ms → ' + qps + ' qps')
_clearIndexes()
" 2>&1 || echo "  ⚠️  Skipped"

# ── 4. BFS 变量长度路径 ──
echo ""
echo "▶ [4/4] BFS 变量长度遍历 (chain 50 nodes)..."
timeout 30 node -e "
const { GraphEngine } = require('./src/core/graph-engine.ts' as any)
const g = new GraphEngine({ path: '/tmp/bench-bfs-' + Date.now(), denseVector: { dimension: 384 } })
g.open()
// 创建一条 50 个节点的链：1-2-3-...-50
for (let i = 0; i < 50; i++) {
  g.upsertNode(1, 'n' + i, { props: { _label: 'Node', name: 'node-' + i } })
}
for (let i = 0; i < 49; i++) {
  g.upsertEdge(i + 1, { _type: 'NEXT' }, i + 2)
}
const start = Date.now()
const count = g.neighbors(1, { maxDepth: 49 }).length
const dur = Date.now() - start
console.log('  BFS 49 hops: ' + dur + 'ms → ' + count + ' reachable nodes')
g.close()
" 2>&1 || echo "  ⚠️  Skipped"

echo ""
echo "═══════════════════════════════════════════"
echo "  基准完成"
echo "═══════════════════════════════════════════"
