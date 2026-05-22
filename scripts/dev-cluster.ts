/**
 * dev-cluster.ts — 开发集群脚本
 *
 * 启动一个 3 节点的 AgentiX GraphVec 模拟集群
 * 每个节点在独立端口上运行
 *
 * 使用方式：
 *   npx ts-node scripts/dev-cluster.ts
 */
import { GraphEngine } from '../src/core/graph-engine'
import { RaftNode } from '../src/consensus/raft-node'
import { HlcClock } from '../src/replication/hlc-clock'
import { RangeInstance } from '../src/shard/range-instance'
import { ShardRouter } from '../src/shard/shard-router'
import { ShardManager } from '../src/shard/shard-manager'
import { Health } from '../src/ops/health'
import { Logger } from '../src/ops/logger'

// Set consensus mode for the cluster
process.env.CONSENSUS_MODE = 'simulated-raft'

const log = new Logger('dev-cluster')

async function main() {
  log.info('Starting AgentiX GraphVec dev cluster...')

  const timestamp = Date.now()

  // Create 3 ranges (each with its own Raft group & OverGraph)
  const configs = [
    { rangeId: 'range-0', port: 9010, dataDir: `./dev-data/range-0-${timestamp}` },
    { rangeId: 'range-1', port: 9011, dataDir: `./dev-data/range-1-${timestamp}` },
    { rangeId: 'range-2', port: 9012, dataDir: `./dev-data/range-2-${timestamp}` },
  ]

  const clock = new HlcClock()
  const ranges: RangeInstance[] = []

  for (const cfg of configs) {
    const engine = new GraphEngine({
      path: `${cfg.dataDir}/graph`,
      denseVector: { dimension: 384 },
    })

    const raft = new RaftNode(
      {
        nodeId: cfg.rangeId,
        peers: configs
          .filter(c => c.rangeId !== cfg.rangeId)
          .map(c => ({ id: c.rangeId, address: `localhost:${c.port}` })),
        storagePath: cfg.dataDir,
      },
      engine,
      clock,
    )

    const range = new RangeInstance(
      {
        rangeId: cfg.rangeId,
        dataDir: cfg.dataDir,
        raftConfig: {
          nodeId: cfg.rangeId,
          peers: configs.map(c => ({ id: c.rangeId, address: `localhost:${c.port}` })),
          storagePath: cfg.dataDir,
        },
        overgraphConfig: {
          path: `${cfg.dataDir}/graph`,
          denseVector: { dimension: 384 },
        },
      },
      clock,
    )

    ranges.push(range)
    await range.start()
    log.info(`Range ${cfg.rangeId} started`, { raftRole: range.getStatus().raft.role })
  }

  // Create ShardManager
  const shardMap = {
    version: 1,
    ranges: configs.map(cfg => ({
      rangeId: cfg.rangeId,
      dataDir: cfg.dataDir,
      raftConfig: {
        nodeId: cfg.rangeId,
        peers: configs.map(c => ({ id: c.rangeId, address: `localhost:${c.port}` })),
        storagePath: cfg.dataDir,
      },
      overgraphConfig: {
        path: `${cfg.dataDir}/graph`,
        denseVector: { dimension: 384 },
      },
    })),
    hashRing: {
      virtualNodes: 160,
      nodes: configs.map(cfg => ({ hash: cfg.rangeId, rangeId: cfg.rangeId })),
    },
  }

  const shardManager = new ShardManager(shardMap, clock)

  log.info('Dev cluster is ready!')
  log.info('Shard status:', { shards: shardManager.getShardStatus() })

  // Demonstrate basic operations
  const nodeId = await shardManager.upsertNode(1, 'hello-graphvec', {
    props: { message: 'Hello from AgentiX GraphVec!', ts: timestamp },
  })
  log.info('Created node', { id: nodeId })

  const node = await shardManager.getNode(nodeId)
  log.info('Read node', { node })

  const status = shardManager.getShardStatus()
  log.info('Cluster status', { status })

  log.info('Dev cluster running. Press Ctrl+C to stop.')

  // Graceful shutdown
  process.on('SIGINT', async () => {
    log.info('Shutting down...')
    for (const range of ranges) {
      await range.stop()
    }
    process.exit(0)
  })

  // Keep alive
  await new Promise(() => {})
}

main().catch(err => {
  console.error('Dev cluster failed:', err)
  process.exit(1)
})
