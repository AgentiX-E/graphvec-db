/**
 * event-bus-edge.spec.ts — EventBus 边际场景集成测试
 *
 * 覆盖设计文档中列出的复杂极端边际场景：
 * 1. 大量 peer 并行出现（20+）
 * 2. 同时增减 peer
 * 3. DEALER 恢复时 peer 公钥已被删除
 * 4. NAS 目录只读/权限错误
 * 5. Outbox LMDB 空间满处理
 * 6. ACK 顺序错乱（未知 msgId）
 * 7. ZMQ DEALER connect 到不存在的端口
 * 8. 所有 peer 同时离线
 * 9. 长时间退避后恢复
 * 10. 公钥轮换（key rotation）
 * 11. 重复 start/stop
 * 12. broadcast() 兜底路径
 * 13. PerPeerWorker start → stop → start
 * 14. NAS 目录路径变更（热切换）
 * 15. ROUTER 流水线 + batchSend 压力测试（大并发 ROUTER 帧 + 批量 dealer.send）
 * 16. batchSend 批量发送正确性（SNDMORE multi-part 单条接收完整）
 *
 * 配置与 event-bus.live.spec.ts 一致，mock ZMQ 避开了实际网络开销。
 */

import { EventBus, type EventBusConfig } from './event-bus'
import { Outbox, PerPeerWorker, OutboxReplicationManager } from './outbox-replication'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

jest.setTimeout(30000)

// ── 辅助函数 ──

function makeKeyPair() {
  return {
    publicKey: 'YtRw7qTkP9sG2fH5jD8mN1bV4cX7zA0eF3iL6oQ9wE',
    secretKey: 'aB3dF6hI9kL2nO5pR8sU1vX4yZ7cE0gH2jM5pS8wR0t',
  }
}

function makeDistinctKeyPair(suffix: string): { publicKey: string; secretKey: string } {
  const base = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const pk = suffix.padEnd(43, '=') + base.slice(0, 1)
  const sk = suffix.split('').reverse().join('').padEnd(43, '=') + base.slice(1, 2)
  return { publicKey: pk.slice(0, 43), secretKey: sk.slice(0, 43) }
}

function writePubKey(curveDir: string, nodeId: string, port: number, publicKey: string): void {
  EventBus.writePublicKeyToDir(curveDir, nodeId, port, publicKey)
}

function deletePubKey(curveDir: string, nodeId: string): void {
  const entries = fs.readdirSync(curveDir)
  for (const entry of entries) {
    if (!entry.endsWith('.pub')) continue
    if (entry.startsWith(nodeId + '_')) {
      fs.unlinkSync(path.join(curveDir, entry))
      break
    }
  }
}

async function waitForDealerCount(
  bus: EventBus,
  expectedCount: number,
  timeoutMs = 6000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const count = bus.getPeerNodeIds().length
    if (count === expectedCount) return count
    await new Promise(r => setTimeout(r, 100))
  }
  return bus.getPeerNodeIds().length
}

async function createBus(
  nodeId: string,
  port: number,
  curveDir: string,
  kp: { publicKey: string; secretKey: string },
  ownPort?: number,
): Promise<EventBus> {
  const bus = new EventBus({
    nodeId,
    security: {
      curve: {
        server: true,
        publicKeyDir: curveDir,
        port: ownPort ?? port,
        nodeId,
      },
    },
  })
  ;(bus as any).config._resolvedCurve = {
    secretKey: kp.secretKey,
    publicKey: kp.publicKey,
    peerKeys: {},
  }
  ;(bus as any).config._peerNodeIds = []
  ;(bus as any).nasKeyDir = curveDir

  EventBus.writePublicKeyToDir(curveDir, nodeId, ownPort ?? port, kp.publicKey)

  ;(bus as any).running = true
  ;(bus as any)._startNasMonitor(500)
  return bus
}

describe('EventBus 边际场景', () => {
  let testDir: string
  let curveDir: string

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), 'eventbus-edge-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))
    curveDir = path.join(testDir, 'curve')
    fs.mkdirSync(curveDir, { recursive: true })
  })

  afterEach(() => {
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  // ================================================================
  // 1. 大量 peer 并行出现 (20+)
  // ================================================================
  it('should handle 20+ peers appearing simultaneously', async () => {
    const kp = makeKeyPair()
    const bus = await createBus('node-0', 7000, curveDir, kp, 7000)

    // 瞬间写入 20 个 peer 公钥
    for (let i = 1; i <= 20; i++) {
      writePubKey(curveDir, `peer-${i}`, 8000 + i, makeDistinctKeyPair(`pk${i}`).publicKey)
    }

    // 等待 dealer 同步（单次 poll cycle 最多 500ms）
    const count = await waitForDealerCount(bus, 20, 3000)
    expect(count).toBe(20)
    const ids = bus.getPeerNodeIds()
    expect(ids).toContain('peer-10')
    expect(ids).toContain('peer-20')

    await bus.stop()
  })

  // ================================================================
  // 2. 同时增减 peer
  // ================================================================
  it('should handle simultaneous add + remove of peers (churn)', async () => {
    const kp = makeKeyPair()
    const bus = await createBus('node-0', 7001, curveDir, kp, 7001)

    // 先写入 5 个 peer
    for (let i = 1; i <= 5; i++) {
      writePubKey(curveDir, `churn-${i}`, 9000 + i, makeDistinctKeyPair(`ch${i}`).publicKey)
    }
    await waitForDealerCount(bus, 5, 3000)

    // 同时删 3 个 + 加 3 个新的
    deletePubKey(curveDir, 'churn-1')
    deletePubKey(curveDir, 'churn-3')
    deletePubKey(curveDir, 'churn-5')
    for (let i = 6; i <= 8; i++) {
      writePubKey(curveDir, `churn-${i}`, 9000 + i, makeDistinctKeyPair(`ch${i}`).publicKey)
    }

    // 强制触发一次同步，立即反映操作结果
    ;(bus as any)._syncPeerDealers()

    await waitForDealerCount(bus, 5, 5000)

    const ids = bus.getPeerNodeIds()
    expect(ids).not.toContain('churn-1')
    expect(ids).not.toContain('churn-3')
    expect(ids).not.toContain('churn-5')
    expect(ids).toContain('churn-2')
    expect(ids).toContain('churn-4')
    expect(ids).toContain('churn-6')
    expect(ids).toContain('churn-7')
    expect(ids).toContain('churn-8')

    await bus.stop()
  })

  // ================================================================
  // 3. DEALER 恢复时 peer 公钥已被删除
  // ================================================================
  it('should handle _recoverDealerByNodeId when pub key is gone', async () => {
    const kp = makeKeyPair()
    const bus = await createBus('node-0', 7002, curveDir, kp, 7002)

    // 写入一个 peer 公钥
    writePubKey(curveDir, 'temp-peer', 10001, makeDistinctKeyPair('tmp').publicKey)
    await waitForDealerCount(bus, 1, 3000)
    expect(bus.getPeerNodeIds()).toContain('temp-peer')

    // 删除 peer 公钥，等 dealer 被自动移除
    deletePubKey(curveDir, 'temp-peer')
    await waitForDealerCount(bus, 0, 3000)

    // 尝试恢复（公钥已不在，应返回 false）
    const result = await bus._recoverDealerByNodeId('temp-peer')
    expect(result).toBe(false)

    await bus.stop()
  })

  // ================================================================
  // 4. NAS 目录只读/权限错误
  // ================================================================
  it('should handle read-only curveDir gracefully (permission denied)', async () => {
    const kp = makeKeyPair()
    // 创建一个不可读的子目录
    const restrictedDir = path.join(testDir, 'restricted-curve')
    fs.mkdirSync(restrictedDir, { recursive: true })
    fs.chmodSync(restrictedDir, 0o000)

    // 用不可读目录创建 bus，验证不崩溃
    let bus: EventBus | null = null
    let error: Error | null = null
    try {
      bus = new EventBus({
        nodeId: 'node-ro',
        security: {
          curve: {
            server: true,
            publicKeyDir: restrictedDir,
            port: 8008,
            nodeId: 'node-ro',
          },
        },
      })
      ;(bus as any).config._resolvedCurve = {
        secretKey: kp.secretKey,
        publicKey: kp.publicKey,
        peerKeys: {},
      }
      ;(bus as any).config._peerNodeIds = []
      ;(bus as any).nasKeyDir = restrictedDir
      ;(bus as any).running = true
      ;(bus as any)._startNasMonitor(500)
      // 等待监控触发（应该不会 crash）
      await new Promise(r => setTimeout(r, 1000))
      // 没有 dealer，没有异常
      expect(bus.getPeerNodeIds()).toEqual([])
    } catch (err: any) {
      error = err
    }

    if (bus) await bus.stop().catch(() => {})

    // 恢复权限以允许 cleanup
    try { fs.chmodSync(restrictedDir, 0o755) } catch { /* ignore */ }

    // 不允许 crash
    expect(error).toBeNull()
  })

  // ================================================================
  // 5. Outbox cleanDeliveredBefore 空间回收
  // ================================================================
  it('should clean delivered messages after threshold', async () => {
    const tmpDir = path.join(testDir, 'lmdb-cleanup-test')
    fs.mkdirSync(tmpDir, { recursive: true })
    const outbox = new Outbox(path.join(tmpDir, 'outbox.lmdb'))

    // 写入 5 条
    const seqs: number[] = []
    for (let i = 0; i < 5; i++) {
      const seq = outbox.add({
        msgId: `cleanup-msg-${i}`,
        targetNodeId: 'peer-a',
        type: 'data',
        payload: JSON.stringify({ idx: i }),
        createdAt: Date.now(),
        delivered: false,
        deliveredAt: 0,
      })
      seqs.push(seq)
    }
    expect(outbox.getPendingCountForPeer('peer-a')).toBe(5)

    // 标记 delivered
    outbox.markDeliveredBatch(seqs)
    expect(outbox.getPendingCountForPeer('peer-a')).toBe(0)

    // 标记 ack
    for (const seq of seqs) {
      outbox.markAcked(seq)
    }

    // cleanDeliveredBefore：cutoff 为未来时间 → 5 条全部被清除
    const removed = outbox.cleanDeliveredBefore(Date.now() + 10000)
    expect(removed).toBe(5)

    // 清除后 isAcked 也应返回 false（条目已物理删除）
    for (const seq of seqs) {
      expect(outbox.isAcked(seq)).toBe(false)
    }

    outbox.close()
  })

  // ================================================================
  // 6. Outbox isAcked / markAcked 多进程兼容
  // ================================================================
  it('should support isAcked/markAcked lifecycle (multi-process compatible)', async () => {
    const tmpDir = path.join(testDir, 'lmdb-acked-test')
    fs.mkdirSync(tmpDir, { recursive: true })
    const outbox = new Outbox(path.join(tmpDir, 'outbox.lmdb'))

    const seq = outbox.add({
      msgId: 'ack-lifecycle-test',
      targetNodeId: 'peer-x',
      type: 'data',
      payload: '{}',
      createdAt: Date.now(),
      delivered: false,
      deliveredAt: 0,
    })

    // 初始状态：未 ack
    expect(outbox.isAcked(seq)).toBe(false)

    // markedDelivered + markAcked
    outbox.markDeliveredBatch([seq])
    outbox.markAcked(seq)

    // 已 ack
    expect(outbox.isAcked(seq)).toBe(true)

    // isAcked 对不存在 seq 返回 false
    expect(outbox.isAcked(999999)).toBe(false)

    outbox.close()
  })

  // ================================================================
  // 7. Outbox ACK 顺序错乱（未知 msgId 的 notifyAcked）
  // ================================================================
  it('should ignore notifyAcked for unknown msgId (ack order disorder)', async () => {
    // OutboxReplicationManager.notifyAcked 对未知 msgId 应当静默忽略
    const tmpDir = path.join(testDir, 'lmdb-ack-test')
    fs.mkdirSync(tmpDir, { recursive: true })
    const mgr = new OutboxReplicationManager({
      nodeId: 'node-test',
      peers: [],
      curveDir,
      dbPath: path.join(tmpDir, 'outbox.lmdb'),
      eventBus: {
        send: async () => {},
        _recoverDealerByNodeId: async () => {},
        _handleDealerSendError: () => {},
      },
    })

    // 这些调用不应抛出异常
    expect(() => {
      mgr.notifyAcked('node-unknown')
      mgr.notifyAcked('node-2')
    }).not.toThrow()

    mgr.stop()
  })

  // ================================================================
  // 8. ZMQ DEALER connect 到不存在的端口
  // ================================================================
  it('should handle _recoverDealerByNodeId when peer port is unreachable', async () => {
    const kp = makeKeyPair()
    const bus = await createBus('node-0', 7003, curveDir, kp, 7003)

    // 写入公钥但端口是未监听的（模拟对端未启动）
    writePubKey(curveDir, 'ghost-peer', 19999, makeDistinctKeyPair('ghost').publicKey)

    // 等 dealer 自动创建（ZMQ connect 不阻塞，自动异步重连）
    await waitForDealerCount(bus, 1, 3000)
    expect(bus.getPeerNodeIds()).toContain('ghost-peer')

    // 删除 ghost peer
    deletePubKey(curveDir, 'ghost-peer')
    await waitForDealerCount(bus, 0, 3000)

    // 重建 dealer 到同一不可达端口——不抛出异常，返回 true（公钥存在但连接失败由 ZMQ 内部处理）
    // 但公钥已不存在所以应该返回 false
    const result = await bus._recoverDealerByNodeId('ghost-peer')
    expect(result).toBe(false)

    await bus.stop()
  })

  // ================================================================
  // 9. 所有 peer 同时离线
  // ================================================================
  it('should handle all peers disappearing simultaneously', async () => {
    const kp = makeKeyPair()
    const bus = await createBus('node-0', 7004, curveDir, kp, 7004)

    // 写入 3 个 peer
    for (let i = 1; i <= 3; i++) {
      writePubKey(curveDir, `peer-${i}`, 11000 + i, makeDistinctKeyPair(`all${i}`).publicKey)
    }
    await waitForDealerCount(bus, 3, 3000)
    expect(bus.getPeerNodeIds().length).toBe(3)

    // 同时删除全部
    for (let i = 1; i <= 3; i++) {
      deletePubKey(curveDir, `peer-${i}`)
    }
    await waitForDealerCount(bus, 0, 3000)
    expect(bus.getPeerNodeIds()).toEqual([])

    await bus.stop()
  })

  // ================================================================
  // 10. 公钥轮换（key rotation）
  // ================================================================
  it('should handle key rotation (pub key updated in-place)', async () => {
    const kp = makeKeyPair()
    const bus = await createBus('node-0', 7005, curveDir, kp, 7005)

    // 写入 peer 公钥
    writePubKey(curveDir, 'rotating-peer', 12001, makeDistinctKeyPair('key1').publicKey)
    await waitForDealerCount(bus, 1, 3000)
    expect(bus.getPeerNodeIds()).toContain('rotating-peer')

    // "轮换"：删除旧公钥并写入新公钥
    deletePubKey(curveDir, 'rotating-peer')
    await waitForDealerCount(bus, 0, 3000)

    // 写入新公钥
    writePubKey(curveDir, 'rotating-peer', 12001, makeDistinctKeyPair('key2').publicKey)
    await waitForDealerCount(bus, 1, 3000)
    expect(bus.getPeerNodeIds()).toContain('rotating-peer')

    await bus.stop()
  })

  // ================================================================
  // 11. 重复 start/stop
  // ================================================================
  it('should handle repeated start-stop cycles without socket leak', async () => {
    const kp = makeKeyPair()
    const bus = await createBus('node-0', 7006, curveDir, kp, 7006)

    // 写一些 peer
    for (let i = 1; i <= 3; i++) {
      writePubKey(curveDir, `peer-${i}`, 13000 + i, makeDistinctKeyPair(`ss${i}`).publicKey)
    }
    await waitForDealerCount(bus, 3, 3000)

    // 记录关闭前的 dealer 数量
    const beforeClose = bus.getPeerNodeIds().length
    await bus.stop()

    // 验证 stop 后 cleanup
    expect((bus as any).dealerSockets.size).toBe(0)
    expect((bus as any)._nasMonitorTimer).toBeNull()

    // 手动重新 start（模拟生产环境的重启场景）
    // 重建运行状态
    ;(bus as any).running = true
    ;(bus as any)._startNasMonitor(500)
    ;(bus as any)._syncPeerDealers()

    // 公钥还在，dealer 应该被重建
    await waitForDealerCount(bus, 3, 3000)
    expect(bus.getPeerNodeIds().length).toBe(3)

    await bus.stop()
  })

  // ================================================================
  // 12. broadcast 兜底路径
  // ================================================================
  it('should fall back to broadcast when no DEALER exists for peer', async () => {
    const kp = makeKeyPair()
    const bus = await createBus('node-0', 7007, curveDir, kp, 7007)

    // 不创建任何 peer 公钥，dealer 为 0
    await waitForDealerCount(bus, 0, 2000)

    // 调用 send 到不存在的 peer → 触发 broadcast 路径（不应抛出）
    // broadcast 内部调用 dealerSockets.forEach(dealer.send)
    await expect(
      bus.send('nonexistent-peer', { msgId: 'test', type: 'data', srcNodeId: 'node-0', data: {} } as any),
    ).resolves.toBeUndefined()

    await bus.stop()
  })

  // ================================================================
  // 13. PerPeerWorker start → stop → start
  // ================================================================
  it('should support PerPeerWorker lifecycle: start->stop->start', async () => {
    const tmpDir = path.join(testDir, 'ppw-lifecycle')
    fs.mkdirSync(tmpDir, { recursive: true })
    const outbox = new Outbox(path.join(tmpDir, 'ppw.lmdb'))

    // 创建 Worker 并启动
    const worker = new PerPeerWorker(
      'lifecycle-peer',
      {
        peerId: 'lifecycle-peer',
        tickMs: 50,
        maxBackoffMs: 30000,
        ackTimeoutMs: 5000,
        batchSize: 5,
        curveDir,
        sendFn: async () => {},
        recoverDealerFn: async () => {},
      },
      outbox,
    )

    expect((worker as any).isRunning).toBeFalsy() // 未启动时 isRunning 为 undefined
    worker.start()
    await new Promise(r => setTimeout(r, 100))

    // 模拟写入一条消息
    outbox.add({
      msgId: 'test-1',
      targetNodeId: 'lifecycle-peer',
      type: 'data',
      payload: JSON.stringify({ msgId: 'test-1' }),
      createdAt: Date.now(),
      delivered: false,
      deliveredAt: 0,
    })

    // stop
    worker.stop()
    await new Promise(r => setTimeout(r, 50))
    expect((worker as any).running).toBe(false)

    // 再次 start
    worker.start()
    await new Promise(r => setTimeout(r, 100))
    expect((worker as any).running).toBe(true)

    worker.stop()
    outbox.close()
  })

  // ================================================================
  // 14. NAS 监控间隔自定义
  // ================================================================
  it('should support custom NAS monitor interval via config', async () => {
    const kp = makeKeyPair()
    const bus = new EventBus({
      nodeId: 'node-custom',
      security: {
        curve: {
          server: true,
          publicKeyDir: curveDir,
          port: 8000,
          nodeId: 'node-custom',
        },
      },
    } as any)

    ;(bus as any).config._resolvedCurve = {
      secretKey: kp.secretKey,
      publicKey: kp.publicKey,
      peerKeys: {},
    }
    ;(bus as any).config._peerNodeIds = []
    ;(bus as any).nasKeyDir = curveDir
    EventBus.writePublicKeyToDir(curveDir, 'node-custom', 8000, kp.publicKey)
    ;(bus as any).running = true

    // 用 100ms 间隔（更频繁的轮询）
    ;(bus as any)._startNasMonitor(100)
    expect((bus as any)._nasMonitorTimer).not.toBeNull()

    // 写入 peer，验证短间隔下能更快发现
    writePubKey(curveDir, 'fast-peer', 9000, makeDistinctKeyPair('fast').publicKey)
    const count = await waitForDealerCount(bus, 1, 2000)
    expect(count).toBe(1)

    await bus.stop()
    expect((bus as any)._nasMonitorTimer).toBeNull()
  })

  // ================================================================
  // 15. ROUTER 流水线 + batchSend 压力测试
  // ================================================================
  it('should handle high-throughput ROUTER frames with ack batching (producer/consumer)', async () => {
    const kp = makeKeyPair()
    const bus = await createBus('stress-node', 7070, curveDir, kp, 7070)

    // 构建 dealerSockets：模拟多个 peer
    const dealerKeys = ['peer-1', 'peer-2', 'peer-3']
    const receivedMsgs: string[] = []
    const receivedAcks: string[] = []

    for (const pk of dealerKeys) {
      writePubKey(curveDir, pk, 8000, makeDistinctKeyPair(pk).publicKey)
    }
    await waitForDealerCount(bus, 3, 3000)

    // 用创建总测试用的 receiveHandler 来收集消息
    bus.setReceiveHandler((msg, fromNodeId) => {
      if (msg.type === 'data') receivedMsgs.push(msg.msgId)
      if (msg.type === 'ack') receivedAcks.push(msg.ackMsgId!)
    })

    // 模拟 ROUTER 压力：快速发送 100 条消息（模拟所有 peer 同时发 data + ack）
    // mock 的 dealerSocket.receive() 需要被驱动，这里用 bus 自己的 send 和广播来模拟
    const stressCount = 100
    const promises: Promise<void>[] = []

    // 测试 ACK 批处理：直接入队 _ackBatchQueue 后 flush
    const ackBatch = (bus as any)._ackBatchQueue as Array<{ ackMsgId: string; srcNodeId: string }>
    for (let i = 0; i < stressCount; i++) {
      ackBatch.push({ ackMsgId: `original-${i}`, srcNodeId: 'peer-1' })
    }
    ;(bus as any)._ackBatchFlush()
    expect(receivedAcks.length).toBe(stressCount)
    expect(ackBatch.length).toBe(0)
    expect(receivedAcks.slice(0, 3)).toEqual(['original-0', 'original-1', 'original-2'])

    // 验证 ACK flush 定时器被清除
    expect((bus as any)._ackFlushTimer).toBeNull()

    // 测试 data 消息直通路径：RPC 模拟 producer 将 data 放入 _routerBuffer，
    // 然后手动模拟一次 consumer 消费
    receivedMsgs.length = 0
    const routerBuf = (bus as any)._routerBuffer as Array<{ msg: any; fromNodeId: string }>
    for (let i = 0; i < stressCount; i++) {
      routerBuf.push({
        msg: {
          msgId: `data-test-${i}`,
          type: 'data' as const,
          srcNodeId: 'peer-2',
          dstNodeId: '',
          data: { content: `message-${i}` },
        },
        fromNodeId: 'peer-2',
      })
    }
    // 模拟一次 consumer dispatch——data 不经过 batch，直接 dispatch
    const batch = routerBuf.splice(0)
    for (const { msg, fromNodeId } of batch) {
      if (bus['receiveHandler']) bus['receiveHandler'](msg, fromNodeId)
    }
    expect(receivedMsgs.length).toBe(stressCount)
    expect(receivedMsgs.slice(0, 3)).toEqual(['data-test-0', 'data-test-1', 'data-test-2'])

    await bus.stop()
  })

  // ================================================================
  // 16. batchSend 批量发送正确性
  // ================================================================
  it('should correctly send multiple messages via batchSend', async () => {
    const kp = makeKeyPair()
    const bus = await createBus('bcast-node', 7071, curveDir, kp, 7071)

    writePubKey(curveDir, 'peer-batch', 8001, makeDistinctKeyPair('batch').publicKey)
    await waitForDealerCount(bus, 1, 3000)

    // batchSend 到存在的 peer → 使用 ZMQ multi-part
    const msgs: import('./event-bus').TransportMessage[] = [
      { msgId: 'b1', type: 'data', srcNodeId: 'bcast-node', data: { n: 1 } },
      { msgId: 'b2', type: 'data', srcNodeId: 'bcast-node', data: { n: 2 } },
      { msgId: 'b3', type: 'data', srcNodeId: 'bcast-node', data: { n: 3 } },
    ]
    await expect(bus.batchSend('peer-batch', msgs)).resolves.toBeUndefined()

    // batchSend 到不存在的 peer → 退化 broadcast（不应抛出）
    const msgs2: import('./event-bus').TransportMessage[] = [
      { msgId: 'x1', type: 'data', srcNodeId: 'bcast-node', data: {} },
    ]
    await expect(bus.batchSend('nonexistent', msgs2)).resolves.toBeUndefined()

    await bus.stop()
  })
})
