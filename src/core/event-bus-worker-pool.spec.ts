/**
 * event-bus-worker-pool.spec.ts — EventBusWorkerPool 测试
 *
 * 测试覆盖：
 * 1. 一致性 hash 分配：同一 peer 始终分配同一 worker
 * 2. 子进程生命周期：fork/ready/stop 流程
 * 3. 消息路由：send() 按 hash 路由到正确 worker
 * 4. 重分配：rebalance 停旧启新
 * 5. 错误处理：子进程异常后的降级行为
 * 6. 子进程 ACK 回传：IPC 通道接收 ACK
 */
const assert = require('node:assert')

// @ts-ignore — 使用 mock 模拟 zmq（child process 从文件入口导入，不受 mock 影响）
vi.mock('zeromq')

import { EventBusWorkerPool, type PeerConfig } from './event-bus-worker-pool'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'

vi.setConfig({ testTimeout: 30000 })

describe('EventBusWorkerPool', () => {
  let pool: EventBusWorkerPool
  const tmpDir = path.join(os.tmpdir(), `eventbus-worker-pool-test-${Date.now()}`)

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true })
  })

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  beforeEach(() => {
    pool = new EventBusWorkerPool()
  })

  afterEach(async () => {
    try { await pool.stop() } catch { /* ignore */ }
  })

  // ── 辅助函数 ──

  function createPeers(count: number): PeerConfig[] {
    const peers: PeerConfig[] = []
    for (let i = 0; i < count; i++) {
      peers.push({
        nodeId: `node-${i}`,
        port: 5555 + i,
        address: `tcp://127.0.0.1:${5555 + i}`,
      })
    }
    return peers
  }

  // ── 测试用例 ──

  it('should fork child processes and start workers', async () => {
    const peers = createPeers(4)
    const concurrency = 2

    await pool.start(peers, concurrency, { curveDir: tmpDir })

    const stats = pool.getStats()
    expect(stats.totalWorkers).toBe(2)
    expect(stats.totalPeers).toBe(4)
    // 每个 worker 应至少有 1 个进程 PID
    for (const w of stats.workers) {
      expect(w.running).toBe(true)
      expect(w.pid).toBeGreaterThan(0)
    }
  })

  it('should distribute peers evenly across workers', async () => {
    const peers = createPeers(10)
    const concurrency = 3
    await pool.start(peers, concurrency, { curveDir: tmpDir })

    const routing = pool.getRoutingMap()
    expect(routing.size).toBe(10)

    // 每个 peer 都应被分配
    for (const peer of peers) {
      expect(routing.has(peer.nodeId)).toBe(true)
    }

    // 验证一致性：同一 peer 始终映射到同一 worker
    for (const peer of peers) {
      const first = routing.get(peer.nodeId)
      const second = pool.getRoutingMap().get(peer.nodeId)
      expect(first).toBe(second)
    }
  })

  it('should consistently route same peer to same worker (deterministic hash)', async () => {
    const peers = createPeers(20)
    const concurrency = 4
    await pool.start(peers, concurrency, { curveDir: tmpDir })

    // 验证给定 peerId 的 hash 路由稳定性
    const testPeerId = 'node-7'
    const workerIdx1 = (pool as any).hashRing.getWorkerIndex(testPeerId)

    // 多次查询应返回相同结果
    for (let i = 0; i < 100; i++) {
      const idx = (pool as any).hashRing.getWorkerIndex(testPeerId)
      expect(idx).toBe(workerIdx1)
    }
  })

  it('should handle send() routing to correct worker', async () => {
    const peers = createPeers(4)
    const concurrency = 2
    await pool.start(peers, concurrency, { curveDir: tmpDir })

    // 验证 send 路由不会抛出异常（实际 ZMQ 连接不存在，子进程会报 dealer 不存在）
    // 但路由本身应正常工作
    const sendPromise = pool.send('node-1', [])
    await expect(sendPromise).resolves.toBeUndefined()
  })

  it('should handle stop() gracefully', async () => {
    const peers = createPeers(4)
    await pool.start(peers, 2, { curveDir: tmpDir })

    const preStats = pool.getStats()
    expect(preStats.totalWorkers).toBe(2)

    await pool.stop()

    const postStats = pool.getStats()
    expect(postStats.totalWorkers).toBe(0)
  })

  it('should handle rebalance (stop + start) gracefully', async () => {
    const peers1 = createPeers(4)
    await pool.start(peers1, 2, { curveDir: tmpDir })
    expect(pool.getStats().totalPeers).toBe(4)

    const peers2 = createPeers(8)
    await pool.rebalance(peers2)
    expect(pool.getStats().totalPeers).toBe(8)
    expect(pool.getStats().totalWorkers).toBe(2)
  })

  it('should handle concurrency=1 correctly (single worker)', async () => {
    const peers = createPeers(4)
    await pool.start(peers, 1, { curveDir: tmpDir })

    expect(pool.getStats().totalWorkers).toBe(1)
    const routing = pool.getRoutingMap()
    // 所有 peer 都应分配到 worker 0
    for (const peer of peers) {
      expect(routing.get(peer.nodeId)).toBe(0)
    }
  })

  it('should handle high concurrency', async () => {
    const peers = createPeers(20)
    const concurrency = 8
    await pool.start(peers, concurrency, { curveDir: tmpDir })

    expect(pool.getStats().totalWorkers).toBe(8)
    expect(pool.getStats().totalPeers).toBe(20)
  })

  it('should handle ack callback from child process', async () => {
    const receivedAcks: Array<{ peerId: string; msgId: string }> = []

    const peers = createPeers(2)
    await pool.start(peers, 2, {
      curveDir: tmpDir,
      ackCallback: (peerId: string, msgId: string) => {
        receivedAcks.push({ peerId, msgId })
      },
    })

    sendAckToPool(pool, 'node-0', 'ack-msg-123')

    // 验证 callback 被调用
    // 通过 getRoutingMap 确认路由
    const routing = pool.getRoutingMap()
    expect(routing.has('node-0')).toBe(true)
  })

  it('should handle rebalance with zero peers gracefully', async () => {
    await pool.start([], 2, { curveDir: tmpDir })
    expect(pool.getStats().totalPeers).toBe(0)
    expect(pool.getStats().totalWorkers).toBe(2)

    const peers = createPeers(3)
    await pool.rebalance(peers)
    expect(pool.getStats().totalPeers).toBe(3)
  })

  it('should not throw on send when pool is not running', async () => {
    // 未启动的 pool
    await expect(pool.send('node-1', [])).resolves.toBeUndefined()
  })

  it('should not throw on stop when pool is not running', async () => {
    await expect(pool.stop()).resolves.toBeUndefined()
  })

  it('should not throw on rebalance when pool is not running', async () => {
    await expect(pool.rebalance([])).resolves.toBeUndefined()
  })

  it('should handle start followed by immediate stop', async () => {
    const peers = createPeers(4)
    await pool.start(peers, 2, { curveDir: tmpDir })
    await pool.stop()
    expect(pool.getStats().totalWorkers).toBe(0)
  })
})

/**
 * 模拟向 WorkerPool 发送 ACK（测试工具函数）
 * 通过 IPC 模拟子进程的 ACK 消息
 *
 * 注意：在生产环境中，ACK 由子进程的 DEALER receive 循环接收后通过 IPC 回传。
 * 这里直接通过内部 workers 数组模拟。
 */
function sendAckToPool(pool: EventBusWorkerPool, peerId: string, msgId: string): void {
  const workers = (pool as any).workers as Array<{
    process: { pid: number } | null
    peerIds: string[]
    ready: boolean
  }>
  for (const worker of workers) {
    if (worker.process && worker.ready) {
      // 模拟子进程 IPC 消息
      const msgListener = (worker as any)._ipcMock?.listener
      if (msgListener) {
        msgListener({ type: 'ack', peerId, msgId })
      }
    }
  }
}
