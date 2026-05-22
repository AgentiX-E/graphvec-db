/**
 * 基准测试框架 — 核心操作延迟
 * 
 * 注意：这些基准使用真实 OverGraph，结果受磁盘 I/O 影响。
 * 运行方式：npx ts-node bench/core-ops.bench.ts
 */
import { GraphEngine } from '../src/core/graph-engine'
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const DATA_DIR = `/tmp/agentiX-bench-${Date.now()}`
const ITERATIONS = 1000

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true })

  const engine = new GraphEngine({ path: `${DATA_DIR}/graph` })
  engine.open()

  // 为所有 benchmark 创建一个节点
  const id = engine.upsertNode(1, 'bench-root', { props: { name: 'Benchmark Root' } })
  console.log('Created root node:', id)

  // Bench: 单点写入
  const writeStart = Date.now()
  for (let i = 0; i < ITERATIONS; i++) {
    engine.upsertNode(1, `bench-node-${i}`, { props: { idx: i } })
  }
  const writeMs = Date.now() - writeStart
  console.log(`Write ${ITERATIONS} nodes: ${writeMs}ms (${Math.round(ITERATIONS / (writeMs / 1000))} ops/s)`)

  // Bench: 单点读取
  const readStart = Date.now()
  for (let i = 0; i < ITERATIONS; i++) {
    engine.getNode(i + 1) // 假设 ID 连续
  }
  const readMs = Date.now() - readStart
  console.log(`Read ${ITERATIONS} nodes: ${readMs}ms (${Math.round(ITERATIONS / (readMs / 1000))} ops/s)`)

  // Bench: 边写入
  const edgeStart = Date.now()
  for (let i = 1; i <= ITERATIONS; i++) {
    engine.upsertEdge(id, i, 10)
  }
  const edgeMs = Date.now() - edgeStart

  // Bench: 邻居遍历
  const neighborStart = Date.now()
  for (let i = 0; i < 100; i++) {
    engine.neighbors(id)
  }
  const neighborMs = Date.now() - neighborStart

  console.log(`\n--- Benchmark Results (${ITERATIONS} iterations) ---`)
  console.log(`Write:     ${Math.round(ITERATIONS / (writeMs / 1000)).toLocaleString()} ops/s`)
  console.log(`Read:      ${Math.round(ITERATIONS / (readMs / 1000)).toLocaleString()} ops/s`)
  console.log(`Edge:      ${Math.round(ITERATIONS / (edgeMs / 1000)).toLocaleString()} ops/s`)
  console.log(`Neighbors: ${(neighborMs / 100).toFixed(2)}μs avg (${neighborMs}ms for 100)`)

  engine.close()
  execSync(`rm -rf "${DATA_DIR}"`)
}

main().catch(console.error)
