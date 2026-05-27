/**
 * disable-router.test.ts — EventBus disableRouter 集成测试
 *
 * 覆盖场景：
 * 1. disableRouter=true → 不创建 ROUTER socket，但仍可发送(DEALER 侧正常)
 * 2. disableRouter=false（默认）→ 正常创建 ROUTER socket
 */
import { EventBus, type EventBusConfig } from '../../src/core/event-bus'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

let portCounter = 20000

function allocPort(): number {
  return portCounter++
}

function createTestDirs(prefix: string): { root: string; curve: string } {
  const root = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const curve = path.join(root, 'curve')
  fs.mkdirSync(curve, { recursive: true })
  return { root, curve }
}

function removeTestDirs(root: string): void {
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
}

describe('EventBus disableRouter', () => {
  it('1. disableRouter=true → ROUTER socket 不创建，DEALER 发送正常', async () => {
    const dirs1 = createTestDirs('disable-router-true')
    const dirs2 = createTestDirs('disable-router-peer')
    const port1 = allocPort()
    const port2 = allocPort()

    try {
      // 预先生成两个节点的密钥并互相写入对方目录
      const kp1 = EventBus.generateCurveKeys()
      const kp2 = EventBus.generateCurveKeys()

      EventBus.writePublicKeyToDir(dirs1.curve, 'node-a', port1, kp1.publicKey)
      EventBus.writePublicKeyToDir(dirs1.curve, 'node-b', port2, kp2.publicKey)

      EventBus.writePublicKeyToDir(dirs2.curve, 'node-a', port1, kp1.publicKey)
      EventBus.writePublicKeyToDir(dirs2.curve, 'node-b', port2, kp2.publicKey)

      // 节点 A: disableRouter=true
      const busA = new EventBus({
        nodeId: 'node-a',
        security: { curve: { server: true, publicKeyDir: dirs1.curve, port: port1, nodeId: 'node-a' } },
        publishAddress: `tcp://127.0.0.1:${port1}`,
        subscribeAddresses: [`tcp://127.0.0.1:${port2}`],
        disableRouter: true,
        nasMonitorIntervalMs: 200,
      })

      // 节点 B: disableRouter=undefined（默认 false）
      const busB = new EventBus({
        nodeId: 'node-b',
        security: { curve: { server: true, publicKeyDir: dirs2.curve, port: port2, nodeId: 'node-b' } },
        publishAddress: `tcp://127.0.0.1:${port2}`,
        subscribeAddresses: [`tcp://127.0.0.1:${port1}`],
        disableRouter: false,
        nasMonitorIntervalMs: 200,
      })

      await busA.start()
      await busB.start()

      // === 断言 1: disableRouter=true → routerSocket 为 null ===
      expect(busA.hasRouterSocket()).toBe(false)

      // === 断言 2: disableRouter=false → routerSocket 已创建 ===
      expect(busB.hasRouterSocket()).toBe(true)

      // === 断言 3: DEALER 侧可以发送消息 ===
      // busA 作为 DEALER 应该能连接到 busB 的 ROUTER 并发送消息
      const msgFromA = { type: 'data', payload: 'hello from A' } as any
      await expect(busA.send('node-b', msgFromA)).resolves.not.toThrow()

      // busB 作为 DEALER 应该能连接到 busA (虽然 busA 没有 ROUTER，DEALER 也会尝试连接但不一定成功)
      // 至少 send 不会抛出异常（DEALER 端 connect 是异步的，ZMQ 自动处理）
      const msgFromB = { type: 'data', payload: 'hello from B' } as any
      await expect(busB.send('node-a', msgFromA)).resolves.not.toThrow()

      await busA.stop()
      await busB.stop()
    } finally {
      removeTestDirs(dirs1.root)
      removeTestDirs(dirs2.root)
    }
  })

  it('2. disableRouter=false → 正常创建 ROUTER socket', async () => {
    const dirs = createTestDirs('disable-router-false')
    const port = allocPort()

    try {
      const kp = EventBus.generateCurveKeys()
      EventBus.writePublicKeyToDir(dirs.curve, 'node-x', port, kp.publicKey)

      const bus = new EventBus({
        nodeId: 'node-x',
        security: { curve: { server: true, publicKeyDir: dirs.curve, port, nodeId: 'node-x' } },
        publishAddress: `tcp://127.0.0.1:${port}`,
        disableRouter: false,
        nasMonitorIntervalMs: 200,
      })

      await bus.start()

      // disableRouter=false → routerSocket 应已创建
      expect(bus.hasRouterSocket()).toBe(true)

      await bus.stop()
    } finally {
      removeTestDirs(dirs.root)
    }
  })

  it('3. disableRouter 未设置（默认）→ 正常创建 ROUTER socket', async () => {
    const dirs = createTestDirs('disable-router-default')
    const port = allocPort()

    try {
      const kp = EventBus.generateCurveKeys()
      EventBus.writePublicKeyToDir(dirs.curve, 'node-y', port, kp.publicKey)

      const bus = new EventBus({
        nodeId: 'node-y',
        security: { curve: { server: true, publicKeyDir: dirs.curve, port, nodeId: 'node-y' } },
        publishAddress: `tcp://127.0.0.1:${port}`,
        // disableRouter 未设置 → undefined → falsy → 走正常创建路径
        nasMonitorIntervalMs: 200,
      })

      await bus.start()

      expect(bus.hasRouterSocket()).toBe(true)

      await bus.stop()
    } finally {
      removeTestDirs(dirs.root)
    }
  })
})
