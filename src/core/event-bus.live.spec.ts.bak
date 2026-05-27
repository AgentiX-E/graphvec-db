/**
 * event-bus.live.spec.ts — EventBus NAS 动态监控集成测试
 *
 * 验证：
 * 1. 启动 EventBus → 无 DEALER（无 peer 公钥）
 * 2. 写入 peer 公钥 → 自动创建 DEALER
 * 3. 删除 peer 公钥 → 自动关闭 DEALER
 * 4. _recoverDealerByNodeId 重建 DEALER
 * 5. NAS 监控定时器在 stop() 后正确清理
 *
 * Mock ZMQ：zeromq 由 jest 的 moduleNameMapper 替换，
 * 测试只验证 dealerSockets 状态，不涉及实际 ZMQ 网络通信。
 */

import { EventBus, type EventBusConfig } from './event-bus'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

jest.setTimeout(15000)

describe('EventBus NAS dynamic monitoring', () => {
  let testDir: string
  let curveDir: string

  /**
   * 生成一对本机 CURVE 密钥（用于 _resolvedCurve）
   * 因为 mock zeromq.curveKeyPair() 未提供，手动构造。
   */
  function makeKeyPair() {
    return {
      publicKey: 'YtRw7qTkP9sG2fH5jD8mN1bV4cX7zA0eF3iL6oQ9wE',
      secretKey: 'aB3dF6hI9kL2nO5pR8sU1vX4yZ7cE0gH2jM5pS8wR0t',
    }
  }

  /** 写一个 peer 的公钥文件到 curveDir */
  function writePubKey(nodeId: string, port: number, publicKey: string): void {
    EventBus.writePublicKeyToDir(curveDir, nodeId, port, publicKey)
  }

  /** 删除指定 peer 的公钥文件 */
  function deletePubKey(nodeId: string): void {
    const entries = fs.readdirSync(curveDir)
    for (const entry of entries) {
      if (!entry.endsWith('.pub')) continue
      if (entry.startsWith(nodeId + '_')) {
        fs.unlinkSync(path.join(curveDir, entry))
        break
      }
    }
  }

  /** 等待 dealerSockets 达到预期大小 */
  async function waitForDealerCount(
    bus: EventBus,
    expectedCount: number,
    timeoutMs = 5000,
  ): Promise<number> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const count = bus.getPeerNodeIds().length
      if (count === expectedCount) return count
      await new Promise(r => setTimeout(r, 100))
    }
    return bus.getPeerNodeIds().length
  }

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), 'eventbus-live-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))
    curveDir = path.join(testDir, 'curve')
    fs.mkdirSync(curveDir, { recursive: true })
  })

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true })
    } catch { /* ignore */ }
  })

  it('should start with NO dealers when no peer keys exist', async () => {
    const kp = makeKeyPair()
    const bus = new EventBus({
      nodeId: 'node-1',
      security: {
        curve: {
          server: true,
          publicKeyDir: curveDir,
          port: 5555,
          nodeId: 'node-1',
        },
      },
    })

    // Manually inject _resolvedCurve so start() can proceed
    ;(bus as any).config._resolvedCurve = {
      secretKey: kp.secretKey,
      publicKey: kp.publicKey,
      peerKeys: {},
    }
    ;(bus as any).config._peerNodeIds = []
    ;(bus as any).nasKeyDir = curveDir

    // Write our own pub key (so it doesn't get confused as peer)
    EventBus.writePublicKeyToDir(curveDir, 'node-1', 5555, kp.publicKey)

    // Start the bus — but we bypass the full start() which calls waitForPeerKeys + generateCurveKeys
    // We call the manual init then startNasMonitor directly
    ;(bus as any).running = true
    ;(bus as any)._startNasMonitor(500)

    // Should have 0 dealers since no peers
    await waitForDealerCount(bus, 0, 2000)
    expect(bus.getPeerNodeIds()).toEqual([])

    await bus.stop()
  })

  it('should auto-create dealer when a peer pub key appears', async () => {
    const kp1 = makeKeyPair()
    const kp2 = makeKeyPair()
    kp2.publicKey = 'XoW9rT5kP2sG4fH7jD0mN3bV6cY9zA1eF4iL7oQ0wE2' // distinct from kp1

    const bus = new EventBus({
      nodeId: 'node-1',
      security: {
        curve: {
          server: true,
          publicKeyDir: curveDir,
          port: 5555,
          nodeId: 'node-1',
        },
      },
    })

    ;(bus as any).config._resolvedCurve = {
      secretKey: kp1.secretKey,
      publicKey: kp1.publicKey,
      peerKeys: {},
    }
    ;(bus as any).config._peerNodeIds = []
    ;(bus as any).nasKeyDir = curveDir

    // Write node-1 own pub key
    EventBus.writePublicKeyToDir(curveDir, 'node-1', 5555, kp1.publicKey)

    // Start bus manually
    ;(bus as any).running = true
    ;(bus as any)._startNasMonitor(500)

    // Verify 0 dealers initially
    await waitForDealerCount(bus, 0, 1500)
    expect(bus.getPeerNodeIds()).toEqual([])

    // Now write node-2's pub key
    writePubKey('node-2', 5556, kp2.publicKey)

    // Wait for dealer creation
    const count = await waitForDealerCount(bus, 1, 5000)
    expect(count).toBe(1)
    expect(bus.getPeerNodeIds()).toContain('node-2')

    await bus.stop()
  })

  it('should close dealer when peer pub key is deleted', async () => {
    const kp1 = makeKeyPair()
    const kp2 = makeKeyPair()
    kp2.publicKey = 'Op8sR5uY2wG4jH7kD0mN3bV6cX9zA1eF4iL7oQ0wE2'

    const bus = new EventBus({
      nodeId: 'node-1',
      security: {
        curve: {
          server: true,
          publicKeyDir: curveDir,
          port: 5555,
          nodeId: 'node-1',
        },
      },
    })

    ;(bus as any).config._resolvedCurve = {
      secretKey: kp1.secretKey,
      publicKey: kp1.publicKey,
      peerKeys: {},
    }
    ;(bus as any).config._peerNodeIds = []
    ;(bus as any).nasKeyDir = curveDir

    // Write node-1 own pub key
    EventBus.writePublicKeyToDir(curveDir, 'node-1', 5555, kp1.publicKey)

    // Write node-2 pub key first (before starting)
    writePubKey('node-2', 5556, kp2.publicKey)

    // Start bus manually — manually inject dealer
    ;(bus as any).running = true
    // Manually add a mock dealer for node-2 (simulating the dealer was created earlier)
    const mockDealer = { close: jest.fn() }
    ;(bus as any).dealerSockets.set('node-2', mockDealer)
    ;(bus as any).config._peerNodeIds = ['node-2']

    // Start NAS monitor
    ;(bus as any)._startNasMonitor(500)

    // Verify dealer exists initially
    expect(bus.getPeerNodeIds()).toContain('node-2')

    // Delete node-2's pub key
    deletePubKey('node-2')

    // Wait for dealer removal
    const count = await waitForDealerCount(bus, 0, 5000)
    expect(count).toBe(0)
    // Verify close was called on the old dealer
    expect(mockDealer.close).toHaveBeenCalled()

    await bus.stop()
  })

  it('should clear NAS monitor timer on stop()', async () => {
    const kp = makeKeyPair()
    const bus = new EventBus({
      nodeId: 'node-1',
      security: {
        curve: {
          server: true,
          publicKeyDir: curveDir,
          port: 5555,
          nodeId: 'node-1',
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

    EventBus.writePublicKeyToDir(curveDir, 'node-1', 5555, kp.publicKey)

    ;(bus as any).running = true
    ;(bus as any)._startNasMonitor(500)

    // Verify timer exists
    expect((bus as any)._nasMonitorTimer).not.toBeNull()

    await bus.stop()

    // Verify timer is cleared
    expect((bus as any)._nasMonitorTimer).toBeNull()
  })

  it('should recover dealer by nodeId with _recoverDealerByNodeId', async () => {
    const kp1 = makeKeyPair()
    const kp2 = makeKeyPair()
    kp2.publicKey = 'Mn4bV7cX9zA1eF3iL6oQ0wE2rT5yU8pS1dG4jH7kD0m'

    const bus = new EventBus({
      nodeId: 'node-1',
      security: {
        curve: {
          server: true,
          publicKeyDir: curveDir,
          port: 5555,
          nodeId: 'node-1',
        },
      },
    })

    ;(bus as any).config._resolvedCurve = {
      secretKey: kp1.secretKey,
      publicKey: kp1.publicKey,
      peerKeys: {},
    }
    ;(bus as any).config._peerNodeIds = []
    ;(bus as any).nasKeyDir = curveDir

    EventBus.writePublicKeyToDir(curveDir, 'node-1', 5555, kp1.publicKey)
    writePubKey('node-2', 5556, kp2.publicKey)

    // Start bus manually
    ;(bus as any).running = true
    ;(bus as any)._startNasMonitor(500)

    // Write and re-sync to let it auto-create dealer for node-2
    // Call _syncPeerDealers manually to simulate the NAS poll cycle
    ;(bus as any)._syncPeerDealers()

    await waitForDealerCount(bus, 1, 3000)
    expect(bus.getPeerNodeIds()).toContain('node-2')

    // Now "close" the dealer without deleting pub key — simulate broken connection
    const oldDealer = (bus as any).dealerSockets.get('node-2')
    const closeSpy = oldDealer.close
    ;(bus as any).dealerSockets.delete('node-2')

    // Recover the dealer
    const result = await bus._recoverDealerByNodeId('node-2')
    expect(result).toBe(true)

    // Verify dealer is back
    expect(bus.getPeerNodeIds()).toContain('node-2')

    await bus.stop()

    // _recoverDealerByNodeId for non-existent peer returns false
    const result2 = await bus._recoverDealerByNodeId('node-999')
    expect(result2).toBe(false)
  })
})
