/**
 * event-bus.live.spec.ts — EventBus NAS 动态监控集成测试（真实 ZMQ）
 *
 * 使用真实 ZeroMQ 连接验证：
 * 1. 启动 EventBus → 无 DEALER（无 peer 公钥）
 * 2. 写入 peer 公钥 → 自动创建 DEALER（通过 NAS 扫描）
 * 3. 删除 peer 公钥 → 自动关闭 DEALER
 * 4. _recoverDealerByNodeId 重建 DEALER
 * 5. NAS 监控定时器在 stop() 后正确清理
 */

import { EventBus } from './event-bus'
import { createRealBus, type BusNode, createTestDirs, removeTestDirs, waitForPeer, waitForPeers, stopBuses, allocPort, resetPortAllocator } from '../test-utils/real-zmq-bus'
import * as path from 'node:path'
import * as fs from 'node:fs'

vi.setConfig({ testTimeout: 15000 })

describe('EventBus NAS dynamic monitoring (real ZMQ)', () => {
  let dirs: ReturnType<typeof createTestDirs>

  beforeEach(async () => {
    resetPortAllocator()
    await new Promise(r => setTimeout(r, 150))
    dirs = createTestDirs('live-real')
  })

  afterEach(() => {
    removeTestDirs(dirs.root)
  })

  it('should start with NO dealers when no peer keys exist', async () => {
    const node1 = await createRealBus({
      nodeId: 'node-1',
      port: allocPort(),
      curveDir: dirs.curve,
    })

    // NAS monitor 200ms 间隔，等一轮确保没扫描到 peer
    await new Promise(r => setTimeout(r, 500))
    expect(node1.bus.getPeerNodeIds()).toEqual([])

    await node1.bus.stop()
  })

  it('should auto-create dealer when a peer pub key appears', async () => {
    const node1 = await createRealBus({
      nodeId: 'node-1',
      port: allocPort(),
      curveDir: dirs.curve,
    })

    // 写入 node-2 公钥
    const kp2 = EventBus.generateCurveKeys()
    EventBus.writePublicKeyToDir(dirs.curve, 'node-2', 16003, kp2.publicKey)

    // 等 NAS 扫描发现 node-2
    const found = await waitForPeer(node1.bus, 'node-2', 5000)
    expect(found).toBe(true)
    expect(node1.bus.getPeerNodeIds()).toContain('node-2')

    await node1.bus.stop()
  })

  it('should close dealer when peer pub key is deleted', async () => {
    const node1 = await createRealBus({
      nodeId: 'node-1',
      port: allocPort(),
      curveDir: dirs.curve,
    })

    // 写入 node-2 公钥
    const kp2 = EventBus.generateCurveKeys()
    EventBus.writePublicKeyToDir(dirs.curve, 'node-2', 16005, kp2.publicKey)

    // 等 node-2 dealer 出现
    const found = await waitForPeer(node1.bus, 'node-2', 5000)
    expect(found).toBe(true)

    // 记录初始 dealer 数量
    const beforeDelete = node1.bus.getPeerNodeIds().length

    // 删除 node-2 公钥
    const entries = fs.readdirSync(dirs.curve).filter(e => e.endsWith('.pub'))
    for (const entry of entries) {
      if (entry.startsWith('node-2_')) {
        fs.unlinkSync(path.join(dirs.curve, entry))
        break
      }
    }

    // 等 dealer 被移除
    const closed = await waitForPeers(node1.bus, beforeDelete - 1, 5000)
    expect(closed).toBe(beforeDelete - 1)
    expect(node1.bus.getPeerNodeIds()).not.toContain('node-2')

    await node1.bus.stop()
  })

  it('should clear NAS monitor timer on stop()', async () => {
    const node1 = await createRealBus({
      nodeId: 'node-1',
      port: allocPort(),
      curveDir: dirs.curve,
    })

    // 验证 timer 存在
    expect((node1.bus as any)._nasMonitorTimer).not.toBeNull()

    await node1.bus.stop()

    // 验证 timer 已清除
    expect((node1.bus as any)._nasMonitorTimer).toBeNull()
  })

  it('should recover dealer by nodeId with _recoverDealerByNodeId', async () => {
    // 使用 createPeerPair 让两个节点都看到对方
    const curveDir2 = path.join(dirs.root, 'curve2')
    fs.mkdirSync(curveDir2, { recursive: true })

    // 预写入两个节点的公钥
    const kp1 = EventBus.generateCurveKeys()
    const kp2 = EventBus.generateCurveKeys()
    const port1 = allocPort()
    const port2 = allocPort()

    EventBus.writePublicKeyToDir(curveDir2, 'node-1', port1, kp1.publicKey)
    EventBus.writePublicKeyToDir(curveDir2, 'node-2', port2, kp2.publicKey)

    const bus1 = new EventBus({
      nodeId: 'node-1',
      security: { curve: { server: true, publicKeyDir: curveDir2, port: port1, nodeId: 'node-1' } },
      nasMonitorIntervalMs: 200,
    })
    const bus2 = new EventBus({
      nodeId: 'node-2',
      security: { curve: { server: true, publicKeyDir: curveDir2, port: port2, nodeId: 'node-2' } },
      nasMonitorIntervalMs: 200,
    })

    await Promise.all([bus1.start(), bus2.start()])

    // 等互相发现
    await waitForPeer(bus1, 'node-2', 5000)
    expect(bus1.getPeerNodeIds()).toContain('node-2')

    // 删除 dealer 模拟断连
    const oldDealer = (bus1 as any).dealerSockets.get('node-2')
    ;(bus1 as any).dealerSockets.delete('node-2')

    // 恢复 dealer（node-2 公钥仍在 curveDir 中）
    const result = await bus1._recoverDealerByNodeId('node-2')
    expect(result).toBe(true)
    expect(bus1.getPeerNodeIds()).toContain('node-2')

    await Promise.all([bus1.stop(), bus2.stop()])

    // 不存在的 peer 返回 false
    const result2 = await bus1._recoverDealerByNodeId('node-999')
    expect(result2).toBe(false)
  })

  // ── 新增 tests ──

  it('should start with empty curve dir and have no peers', async () => {
    const node1 = await createRealBus({
      nodeId: 'empty-peer',
      port: allocPort(),
      curveDir: dirs.curve,
    })

    // NAS monitor 200ms 间隔，等一轮确保没扫描到 peer
    await new Promise(r => setTimeout(r, 500))
    expect(node1.bus.getPeerNodeIds()).toEqual([])

    await node1.bus.stop()
  })

  it('should handle multiple peer key files simultaneously', async () => {
    const node1 = await createRealBus({
      nodeId: 'multi-a',
      port: allocPort(),
      curveDir: dirs.curve,
    })

    // 写入三个 peer 公钥
    for (let i = 0; i < 3; i++) {
      const kp = EventBus.generateCurveKeys()
      EventBus.writePublicKeyToDir(dirs.curve, `peer-${i}`, 16100 + i, kp.publicKey)
    }

    // 等所有 peer 被发现
    const allFound = await waitForPeers(node1.bus, 3, 5000)
    expect(allFound).toBe(3)
    expect(node1.bus.getPeerNodeIds().length).toBe(3)

    await node1.bus.stop()
  })

  it('should not create duplicate dealers for same peer', async () => {
    const node1 = await createRealBus({
      nodeId: 'no-dup',
      port: allocPort(),
      curveDir: dirs.curve,
    })

    const kp = EventBus.generateCurveKeys()
    EventBus.writePublicKeyToDir(dirs.curve, 'unique-peer', 16200, kp.publicKey)

    await waitForPeer(node1.bus, 'unique-peer', 5000)

    // Same key file still present — monitoring should not add duplicate
    const dealersBefore = node1.bus.getPeerNodeIds().length
    await new Promise(r => setTimeout(r, 800))

    expect(node1.bus.getPeerNodeIds().length).toBe(dealersBefore)

    await node1.bus.stop()
  })

  it('should handle bus stop when no peers exist (cleanup)', async () => {
    // Verify multiple stop calls don't throw
    const node1 = await createRealBus({
      nodeId: 'clean-stop',
      port: allocPort(),
      curveDir: dirs.curve,
    })

    await expect(node1.bus.stop()).resolves.toBeUndefined()
  })

  it('should handle bus restart after stop', async () => {
    // start → stop → start 应该正常工作
    const node1 = await createRealBus({
      nodeId: 'restart-node',
      port: allocPort(),
      curveDir: dirs.curve,
    })

    await node1.bus.stop()

    // 重新启动
    await expect(node1.bus.start()).resolves.toBeUndefined()

    // check NAS monitor restarted
    expect((node1.bus as any)._nasMonitorTimer).not.toBeNull()

    await node1.bus.stop()
  }, 10000)
})
