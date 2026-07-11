/**
 * event-bus-test-node.ts — EventBus 子进程测试节点
 *
 * 通过 npx tsx 启动，通过 stdin JSON line 接收命令，stdout JSON line 返回结果。
 *
 * 环境变量:
 *   EBTN_NODE_ID    — Node ID
 *   EBTN_PORT       — ZMQ ROUTER PORT
 *   EBTN_PEER_ID    — 对端Node ID
 *   EBTN_PEER_PORT  — 对端 ZMQ ROUTER PORT
 *   EBTN_CURVE_DIR  — 公钥目录
 *   EBTN_ROLE       — 'sender' | 'receiver'
 *   EBTN_COUNT      — 发送消息数（sender 用）
 */

import { EventBus } from './event-bus'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as readline from 'node:readline'
import { Logger } from '../ops/logger'

const logger = new Logger('EBTN')

function logOut(msg: unknown): void {
  const str = JSON.stringify(msg) + '\n'
  try {
    fs.writeSync(process.stdout.fd, str)
  } catch {
    // ignore
  }
}

async function main() {
  const nodeId = process.env.EBTN_NODE_ID!
  const port = parseInt(process.env.EBTN_PORT!, 10)
  const peerId = process.env.EBTN_PEER_ID!
  const peerPort = parseInt(process.env.EBTN_PEER_PORT!, 10)
  const curveDir = process.env.EBTN_CURVE_DIR!
  const role = process.env.EBTN_ROLE! // 'sender' | 'receiver'

  // 确保对端公钥存在（格式：peerId_port.pub）
  const peerKeyFile = path.join(curveDir, `${peerId}_${peerPort}.pub`)
  if (!fs.existsSync(peerKeyFile)) {
    // 也检查旧格式
    const oldFormat = path.join(curveDir, `${peerId}.pub`)
    if (!fs.existsSync(oldFormat)) {
      logOut({ type: 'error', message: `peer key not found: ${peerKeyFile}` })
      process.exit(1)
    }
  }

  logOut({ type: 'config', nodeId, port, peerPort, role, curveDir })

  // 创建 EventBus
  const bus = new EventBus({
    nodeId,
    security: {
      curve: { server: true, publicKeyDir: curveDir, port, nodeId },
    },
    nasMonitorIntervalMs: 200,
  })

  await bus.start()

  // 等待发现对端
  await new Promise<void>((resolve) => {
    const check = () => {
      if (bus.getPeerNodeIds().includes(peerId)) resolve()
      else setTimeout(check, 100)
    }
    setTimeout(check, 500) // 第一次检查前等 500ms ZMQ 握手
  })

  const dealerCount = bus.getPeerNodeIds().length
  logOut({ type: 'ready', nodeId, dealerCount })

  if (role === 'receiver') {
    // ── 接收者：接收消息并计数 ──
    let receivedCount = 0
    let expectedCount = 0

    bus.setReceiveHandler((msg) => {
      receivedCount++
      // 每收 10% 或最后一条汇报一次
      if (receivedCount % Math.max(1, Math.floor(expectedCount / 10)) === 0 || receivedCount === expectedCount) {
        logOut({ type: 'progress', nodeId, received: receivedCount, expected: expectedCount })
      }
    })

    // 等待 setCount 命令
    const rl = readline.createInterface({ input: process.stdin, terminal: false })
    rl.on('line', async (line) => {
      const cmd = JSON.parse(line)
      if (cmd.type === 'setCount') {
        expectedCount = cmd.count
        logOut({ type: 'countSet', expected: expectedCount })
      } else if (cmd.type === 'getResult') {
        logOut({ type: 'result', nodeId, received: receivedCount, expected: expectedCount })
      }
    })
  }

  if (role === 'sender') {
    // ── 发送者：启动后立即发送 ──
    const sendCount = parseInt(process.env.EBTN_COUNT!, '10') || 100

    // 额外等 500ms 确保对端 ready
    await new Promise((r) => setTimeout(r, 1000))

    logOut({ type: 'sendStart', nodeId, target: peerId, count: sendCount })

    const startMs = Date.now()
    for (let i = 0; i < sendCount; i++) {
      await bus.send(peerId, {
        msgId: `ebtn-${nodeId}-${i}`,
        type: 'data',
        srcNodeId: nodeId,
        data: { idx: i },
      } as any)
    }
    const elapsed = Date.now() - startMs
    logOut({ type: 'sendDone', nodeId, count: sendCount, elapsedMs: elapsed })

    // 额外等 500ms 确保对端收到 ACK
    await new Promise((r) => setTimeout(r, 500))

    await bus.stop()
    logOut({ type: 'done', nodeId })
    process.exit(0)
  }
}

main().catch((err) => {
  logOut({ type: 'error', message: err.message, stack: err.stack })
  process.exit(1)
})
