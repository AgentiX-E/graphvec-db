/**
 * real-zmq-bus.ts — 真实 ZMQ EventBus 测试辅助层
 *
 * 提供创建/管理真实 EventBus 实例 + 子进程节点的辅助函数。
 * 避免重复写端口分配、CURVE 密钥、NAS 目录等样板代码。
 */

import { EventBus, type EventBusConfig } from '../core/event-bus'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

// ── 端口分配 ──

/** 基础端口：15000 + 随机偏移（避免跨进程/前次测试遗留端口占用） */
const PORT_BASE = 15000 + (Math.floor(Math.random() * 5000) % 5000)
let nextPort = PORT_BASE
/** 每个测试文件独立起始偏移，同一个文件内顺序递增 */
let fileOffset = 0

/** 顺序分配端口（每个测试唯一），测试间不会冲突 */
export function allocPort(): number {
  return nextPort++
}

/** 重置端口计数器——在同文件内用 fileOffset 保证连续递增 */
export function resetPortAllocator(): void {
  nextPort = PORT_BASE + fileOffset
  fileOffset += 30 // 每测试预留 30 个端口（足够双人 + 单人 + peerPair）
}

// ── 临时目录 ──

let dirCounter = 0

/** 创建唯一的测试目录（含 curve 子目录），返回 { root, curve } */
export function createTestDirs(prefix = 'real-zmq'): { root: string; curve: string } {
  const root = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${++dirCounter}`)
  const curve = path.join(root, 'curve')
  fs.mkdirSync(curve, { recursive: true })
  return { root, curve }
}

/** 删除测试目录 */
export function removeTestDirs(root: string): void {
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
}

// ── EventBus 节点管理 ──

export interface BusNode {
  bus: EventBus
  nodeId: string
  port: number
  curveDir: string
  rootDir: string
}

export interface BusNodeConfig {
  nodeId: string
  port: number
  curveDir: string
  /** 额外的 EventBus 配置 */
  extraConfig?: Partial<EventBusConfig>
}

/**
 * 创建一个 EventBus 实例并启动（使用真实 ZMQ）。
 *
 * 启动前 curveDir 里必须有已写入的 peer 公钥（否则 start() 会等到超时）。
 * 对于单个节点启动（无 peer），会自动跳过 peer 等待。
 *
 * 典型用法：
 * ```
 * // 1. 先写本机公钥（start() 会自动做）
 * // 2. 逐个启动 peer（start() 发现已有 peer 公钥即连接）
 * ```
 */
export async function createRealBus(config: BusNodeConfig): Promise<BusNode> {
  const bus = new EventBus({
    nodeId: config.nodeId,
    security: {
      curve: {
        server: true,
        publicKeyDir: config.curveDir,
        port: config.port,
        nodeId: config.nodeId,
      },
    },
    // NAS monitor 快一点，避免测试等太久
    nasMonitorIntervalMs: 200,
    ...config.extraConfig,
  })

  await bus.start()

  return { bus, nodeId: config.nodeId, port: config.port, curveDir: config.curveDir, rootDir: config.curveDir }
}

/**
 * 创建一个 2 节点 EventBus 对，共享同一个 curveDir。
 *
 * 启动策略：
 * 1. 先生成 node-1 的公钥写入 curveDir
 * 2. 生成 node-2 的公钥写入 curveDir
 * 3. 启动 node-1→ 发现 node-2 公钥（已有）
 * 4. 启动 node-2→ 发现 node-1 公钥（已有）
 * 5. 两个节点在全有公钥的情况下启动 → 立即互相建立 DEALER
 */
export async function createPeerPair(
  curveDir: string,
  opts?: { port1?: number; port2?: number },
): Promise<[BusNode, BusNode]> {
  const port1 = opts?.port1 ?? allocPort()
  const port2 = opts?.port2 ?? allocPort()

  // Step 1: 预生成两个节点的密钥并写入 curveDir
  // 这样 start() 里的 resolveCurveConfig 都能立即看到对方
  const kp1 = EventBus.generateCurveKeys()
  const kp2 = EventBus.generateCurveKeys()

  EventBus.writePublicKeyToDir(curveDir, 'node-1', port1, kp1.publicKey)
  EventBus.writePublicKeyToDir(curveDir, 'node-2', port2, kp2.publicKey)

  // Step 2: 启动两个 bus
  const bus1 = new EventBus({
    nodeId: 'node-1',
    security: { curve: { server: true, publicKeyDir: curveDir, port: port1, nodeId: 'node-1' } },
    nasMonitorIntervalMs: 200,
  })

  const bus2 = new EventBus({
    nodeId: 'node-2',
    security: { curve: { server: true, publicKeyDir: curveDir, port: port2, nodeId: 'node-2' } },
    nasMonitorIntervalMs: 200,
  })

  // 同时 start（两个节点都有对方公钥）
  await Promise.all([bus1.start(), bus2.start()])

  return [
    { bus: bus1, nodeId: 'node-1', port: port1, curveDir, rootDir: curveDir },
    { bus: bus2, nodeId: 'node-2', port: port2, curveDir, rootDir: curveDir },
  ]
}

/**
 * 等待 dealerSockets 达到预期数量
 */
export async function waitForPeers(
  bus: EventBus,
  expectedCount: number,
  timeoutMs = 5000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ids = bus.getPeerNodeIds()
    if (ids.length === expectedCount) return ids.length
    await new Promise(r => setTimeout(r, 100))
  }
  return bus.getPeerNodeIds().length
}

/**
 * 等待指定 peer 的 dealer 出现
 */
export async function waitForPeer(
  bus: EventBus,
  nodeId: string,
  timeoutMs = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (bus.getPeerNodeIds().includes(nodeId)) return true
    await new Promise(r => setTimeout(r, 100))
  }
  return false
}

/**
 * 停止一个或多个 BusNode
 */
export async function stopBuses(nodes: BusNode | BusNode[]): Promise<void> {
  const arr = Array.isArray(nodes) ? nodes : [nodes]
  await Promise.all(arr.map(n => n.bus.stop().catch(() => {})))
}
