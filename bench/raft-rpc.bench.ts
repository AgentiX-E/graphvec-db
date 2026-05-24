/**
 * Raft RPC 基准测试
 *
 * 使用 MockTransport 测试 RaftCore 的 RPC 延迟和吞吐量：
 * - AppendEntries roundtrip latency
 * - Proposal latency in 3-node simulation
 * - Log replication throughput
 *
 * 运行方式：npx ts-node bench/raft-rpc.bench.ts
 */
import { RaftCore } from '../src/consensus/raft-core'
import { MockTransport } from '../src/consensus/transport'
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const DATA_DIR = `/tmp/agentiX-raft-bench-${Date.now()}`
const ITERATIONS = 200
const PROPOSAL_COUNT = 100
const LOG_SIZE_BYTES = 256

function p50(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * 0.5)]
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * 0.95)]
}

function makeRaftCore(id: string, peers: string[], basePath: string): RaftCore {
  const transport = new MockTransport(id)
  return new RaftCore(
    {
      nodeId: id,
      peers,
      electionTimeoutMs: 500,
      heartbeatIntervalMs: 100,
      walPath: path.join(basePath, id, 'wal'),
    },
    transport,
  )
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  console.log('=== Raft RPC Benchmark ===\n')

  // ──────────────────────────────────────
  // 1. AppendEntries Roundtrip (2 nodes)
  // ──────────────────────────────────────
  console.log('--- 1. AppendEntries Roundtrip Latency ---')

  const workerDir = path.join(DATA_DIR, 'roundtrip')
  fs.mkdirSync(workerDir, { recursive: true })

  // Single node + AppendEntries direct via MockTransport
  const nodeA = makeRaftCore('node-a', [], workerDir)
  await nodeA.start()
  await nodeA.waitForLeader(3000)

  const singleNodeDir = path.join(workerDir, 'single-node')
  fs.mkdirSync(singleNodeDir, { recursive: true })
  const nodeB = new RaftCore(
    {
      nodeId: 'node-b',
      peers: [],
      electionTimeoutMs: 500,
      heartbeatIntervalMs: 100,
      walPath: path.join(singleNodeDir, 'wal'),
    },
    new MockTransport('node-b'),
  )
  await nodeB.start()

  const appendLatencies: number[] = []
  for (let i = 0; i < ITERATIONS; i++) {
    const data = Buffer.alloc(LOG_SIZE_BYTES, i % 256)
    const start = performance.now()
    const result = await nodeA.propose(data)
    const elapsed = performance.now() - start
    if (result.ok) {
      appendLatencies.push(elapsed)
    }
  }

  appendLatencies.sort((a, b) => a - b)
  const appendAvg = appendLatencies.reduce((s, v) => s + v, 0) / appendLatencies.length
  console.log(
    `  Single-node Append (+propose): avg=${appendAvg.toFixed(3)}ms ` +
    `p50=${p50(appendLatencies).toFixed(3)}ms p95=${p95(appendLatencies).toFixed(3)}ms ` +
    `(n=${appendLatencies.length})`
  )

  // ──────────────────────────────────────
  // 2. Proposal Latency (3-node cluster)
  // ──────────────────────────────────────
  console.log('\n--- 2. Proposal Latency (3-node cluster) ---')
  await nodeA.stop()
  await nodeB.stop()

  const clusterDir = path.join(DATA_DIR, 'cluster')
  fs.mkdirSync(clusterDir, { recursive: true })

  const peers = ['node-1', 'node-2', 'node-3']
  const clusterNodes: RaftCore[] = []

  for (let i = 0; i < 3; i++) {
    const id = `node-${i + 1}`
    const otherPeers = peers.filter(p => p !== id)
    const nodeDir = path.join(clusterDir, id)
    fs.mkdirSync(nodeDir, { recursive: true })
    const transport = new MockTransport(id)
    const node = new RaftCore(
      {
        nodeId: id,
        peers: otherPeers,
        electionTimeoutMs: 800,
        heartbeatIntervalMs: 100,
        walPath: path.join(nodeDir, 'wal'),
      },
      transport,
    )
    clusterNodes.push(node)
  }

  // Start all nodes
  for (const node of clusterNodes) {
    await node.start()
  }

  // Wait for leader election
  let leader: RaftCore | null = null
  for (let attempt = 0; attempt < 30; attempt++) {
    for (const node of clusterNodes) {
      if (node.role === 'leader') {
        leader = node
        break
      }
    }
    if (leader) break
    await new Promise(r => setTimeout(r, 200))
  }
  console.log(`  Leader elected: ${leader?.getNodeId() ?? 'none'} (term=${leader?.currentTerm})`)

  if (!leader) {
    console.log('  WARNING: No leader elected in 3-node cluster, skipping proposal benchmarks')
  } else {
    // Measure proposal latency
    const proposalLatencies: number[] = []
    for (let i = 0; i < PROPOSAL_COUNT; i++) {
      const data = Buffer.alloc(LOG_SIZE_BYTES, i % 256)
      const start = performance.now()
      const result = await leader.propose(data)
      const elapsed = performance.now() - start
      if (result.ok) {
        proposalLatencies.push(elapsed)
      }
    }

    proposalLatencies.sort((a, b) => a - b)
    const propAvg = proposalLatencies.reduce((s, v) => s + v, 0) / proposalLatencies.length
    console.log(
      `  Proposals (n=${proposalLatencies.length}): avg=${propAvg.toFixed(3)}ms ` +
      `p50=${p50(proposalLatencies).toFixed(3)}ms p95=${p95(proposalLatencies).toFixed(3)}ms`
    )

    // ──────────────────────────────────────
    // 3. Log Replication Throughput
    // ──────────────────────────────────────
    console.log('\n--- 3. Log Replication Throughput ---')
    const throughputBatch = 50
    const throughputStart = Date.now()
    let successCount = 0

    for (let i = 0; i < throughputBatch; i++) {
      const data = Buffer.alloc(LOG_SIZE_BYTES, i % 256)
      const result = await leader.propose(data)
      if (result.ok) successCount++
    }
    const throughputMs = Date.now() - throughputStart
    const opsPerSec = Math.round(successCount / (throughputMs / 1000))
    console.log(
      `  ${successCount}/${throughputBatch} proposals committed in ${throughputMs}ms` +
      ` (${opsPerSec.toLocaleString()} ops/s)`
    )
  }

  // ──────────────────────────────────────
  // 4. Cleanup
  // ──────────────────────────────────────
  for (const node of clusterNodes) {
    await node.stop()
  }
  execSync(`rm -rf "${DATA_DIR}"`)

  console.log('\n--- Benchmark Complete ---')
}

main().catch(err => {
  console.error('Benchmark failed:', err)
  try { execSync(`rm -rf "${DATA_DIR}"`) } catch { /* ignore */ }
  process.exit(1)
})
