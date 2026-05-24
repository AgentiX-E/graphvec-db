/**
 * ReshardWorker 基准测试
 *
 * 模拟分片迁移场景：创建 GraphEngine -> 添加节点和边 -> 模拟 ReshardWorker 迁移。
 * 运行方式：npx ts-node bench/reshard.bench.ts
 */
import { GraphEngine } from '../src/core/graph-engine'
import { MockTransport } from '../src/consensus/transport'
import { HlcClock } from '../src/replication/hlc-clock'
import { RangeInstance } from '../src/shard/range-instance'
import { ReshardWorker } from '../src/reshard/reshard-worker'
import { ReshardSplit, RangeConfig } from '../src/types'
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const DATA_DIR = `/tmp/agentiX-reshard-bench-${Date.now()}`
const NODE_COUNT = 5000
const EDGE_COUNT = 10000

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const sourceDataDir = path.join(DATA_DIR, 'source')
  const targetDataDir = path.join(DATA_DIR, 'target')
  fs.mkdirSync(sourceDataDir, { recursive: true })
  fs.mkdirSync(targetDataDir, { recursive: true })

  console.log('=== ReshardWorker Benchmark ===\n')

  // ──────────────────────────────────────
  // 1. 创建源 Range 并填充数据
  // ──────────────────────────────────────
  console.log(`--- 1. Creating source graph with ${NODE_COUNT} nodes, ${EDGE_COUNT} edges ---`)

  const sourceConfig: RangeConfig = {
    rangeId: 'range-source',
    dataDir: sourceDataDir,
    raftConfig: {
      nodeId: 'source-node',
      peers: [],
      storagePath: path.join(sourceDataDir, 'raft'),
    },
    overgraphConfig: { path: path.join(sourceDataDir, 'og') },
  }

  const clock = new HlcClock('source')
  const sourceRange = new RangeInstance(sourceConfig, clock, new MockTransport('source-node'))
  await sourceRange.start()

  // Create engine directly for bulk data loading
  const engine = sourceRange['engine'] as GraphEngine
  engine.open()

  const writeStart = Date.now()
  // Batch upsert nodes
  const batchSize = 500
  for (let i = 0; i < NODE_COUNT; i += batchSize) {
    const batchEnd = Math.min(i + batchSize, NODE_COUNT)
    const inputs: Array<{ typeId: number; name: string }> = []
    for (let j = i; j < batchEnd; j++) {
      inputs.push({ typeId: 1, name: `node-${j}` })
    }
    const result = engine.batchUpsertNodes(inputs.map(inp => ({
      typeId: inp.typeId,
      name: inp.name,
    })))
    // Create edges between nodes in this batch and previous batch
    if (i > 0) {
      const ids = Object.values(result)
      for (let k = 1; k < ids.length && engine.neighbors(ids[0]).edges.length < EDGE_COUNT; k++) {
        try {
          engine.upsertEdge(ids[k - 1], ids[k], 10)
        } catch {
          // skip duplicates
        }
      }
    }
  }
  const writeMs = Date.now() - writeStart
  const stats = engine.stats()
  console.log(`  Write: ${writeMs}ms (${Math.round(NODE_COUNT / (writeMs / 1000))} nodes/s)`)
  console.log(`  Stats: ${JSON.stringify(stats)}`)

  engine.close()

  // ──────────────────────────────────────
  // 2. 创建目标 Range
  // ──────────────────────────────────────
  console.log('\n--- 2. Creating target range ---')

  const targetConfig: RangeConfig = {
    rangeId: 'range-target',
    dataDir: targetDataDir,
    raftConfig: {
      nodeId: 'target-node',
      peers: [],
      storagePath: path.join(targetDataDir, 'raft'),
    },
    overgraphConfig: { path: path.join(targetDataDir, 'og') },
  }

  const targetClock = new HlcClock('target')
  const targetRange = new RangeInstance(targetConfig, targetClock, new MockTransport('target-node'))
  // Target range will be started by ReshardWorker

  // ──────────────────────────────────────
  // 3. 运行 ReshardWorker 迁移
  // ──────────────────────────────────────
  console.log('\n--- 3. Running ReshardWorker Migration ---')

  const split: ReshardSplit = {
    sourceRangeId: 'range-source',
    targetRangeId: 'range-target',
    hashRangeStart: 0,
    hashRangeEnd: Math.floor(2147483647 / 2),
    targetNodeId: 'target-node',
    targetDataDir: targetDataDir,
  }

  const worker = new ReshardWorker(
    split,
    clock,
    sourceRange,
    targetRange,
  )

  const migrateStart = Date.now()
  await worker.execute()
  const migrateMs = Date.now() - migrateStart

  const throughput = Math.round(NODE_COUNT / (migrateMs / 1000))
  console.log(`\n  Migration time: ${migrateMs}ms`)
  console.log(`  Nodes migrated: ~${NODE_COUNT}`)
  console.log(`  Throughput: ${throughput.toLocaleString()} nodes/s`)

  // ──────────────────────────────────────
  // 4. 清理
  // ──────────────────────────────────────
  await targetRange.stop()
  await sourceRange.stop()
  execSync(`rm -rf "${DATA_DIR}"`)

  console.log('\n--- Benchmark Complete ---')
}

main().catch(err => {
  console.error('Benchmark failed:', err)
  try { execSync(`rm -rf "${DATA_DIR}"`) } catch { /* ignore */ }
  process.exit(1)
})
