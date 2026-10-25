/**
 * raft-test-node.ts — Raft 跨进程集成测试子进程
 *
 * 通过 stdin JSON 行协议接收命令，stdout 返回结果。
 *
 * 启动：npx tsx src/consensus/raft-test-node.ts
 * 环境变量：
 *   RT_NODE_ID — Node ID
 *   RT_PEERS  — JSON: ["2:127.0.0.1:17551", "3:127.0.0.1:17552"]
 *   RT_PORT   — TCP 监听端口
 *   RT_DATA_DIR — 数据目录
 */

import { RaftLogicConsensus } from './raft-logic-consensus'
import { ConsensusConfig } from './consensus-provider'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { Logger } from '../ops/logger'

const logger = new Logger('RaftTestNode')

function logOut(msg: unknown): void {
  const str = JSON.stringify(msg) + '\n'
  try { fs.writeSync(process.stdout.fd, str) } catch { /* ignore */ }
}

async function main() {
  const nodeId = process.env.RT_NODE_ID!
  const peers: string[] = JSON.parse(process.env.RT_PEERS!)
  const port = parseInt(process.env.RT_PORT!, 10)
  const dataDir = process.env.RT_DATA_DIR!

  // 确保数据目录
  fs.mkdirSync(dataDir, { recursive: true })
  // 修改 cwd 使 SqliteStorage 写到数据目录
  process.chdir(dataDir)

  // ── 为 raft-logic mock 注入一个真实的 raft-logic 模块 ──
  // 由于 raft-logic Optional依赖在实际环境中可能未安装，
  // 我们构造一个 mock raftLogic 模块
  const mockRaftModule = {
    RaftNode: class MockRaftNode {
      private _id: number
      private _peers: number[]
      private _transport: any
      private _apply: any
      private _status: { role: string; leaderId: string | null; term: number; commitIndex: number }
      private _leaderStableResolve: (() => void) | null = null
      private _stateCbs: Array<(snap: unknown) => void> = []
      // 用于 InMemoryTransport 的静态注册表
      static instances: MockRaftNode[] = []

      constructor(opts: any) {
        this._id = opts.id
        this._peers = opts.peers || []
        this._transport = opts.transport
        this._apply = opts.apply
        this._status = { role: 'follower', leaderId: null, term: 0, commitIndex: 0 }
        MockRaftNode.instances.push(this)
      }

      // Mirror the real raft-logic API: onStateChange subscribes to state deltas
      // and returns an unsubscribe function. The snapshot uses the same `lead`
      // field name as the real package so consumers (RaftLogicConsensus) stay
      // contract-identical across mock and production.
      onStateChange(cb: (snap: unknown) => void): () => void {
        this._stateCbs.push(cb)
        // Emit the current snapshot immediately so a subscriber that attaches
        // after startup still receives the latest cached state.
        cb({ role: this._status.role, lead: this._status.leaderId, term: this._status.term, commitIndex: this._status.commitIndex })
        return () => {
          const i = this._stateCbs.indexOf(cb)
          if (i >= 0) this._stateCbs.splice(i, 1)
        }
      }

      private _emitState(): void {
        const snap = { role: this._status.role, lead: this._status.leaderId, term: this._status.term, commitIndex: this._status.commitIndex }
        for (const cb of this._stateCbs) {
          try { cb(snap) } catch { /* ignore */ }
        }
      }

      async start(): Promise<void> {
        // 注册消息处理器，接收 TCP 消息
        this._transport.onMessage(async (from: string, msgBuf: Uint8Array) => {
          // 收到消息后通过 apply 处理（模拟 leader → follower 复制）
          if (this._apply) {
            await this._apply({ data: Buffer.from(msgBuf) })
          }
        })

        // 启动后延迟触发 leader 选举（固定让最小 ID 的节点当 leader）
        setTimeout(() => {
          const sorted = [...this._peers, this._id].sort()
          if (this._id === sorted[0]) {
            this._status = { role: 'leader', leaderId: String(this._id), term: 1, commitIndex: this._status.commitIndex }
            if (this._leaderStableResolve) {
              this._leaderStableResolve()
              this._leaderStableResolve = null
            }
          } else {
            this._status = { role: 'follower', leaderId: String(sorted[0]), term: 1, commitIndex: this._status.commitIndex }
          }
          this._emitState()
        }, 200)

        // 连接 peer
        for (const peerId of this._peers) {
          if (this._transport.connectTo) {
            // 查找 peer 地址（从外部传入）
          }
        }
        logOut({ type: 'started', nodeId: this._id })
      }

      async stop(): Promise<void> {
        const idx = MockRaftNode.instances.indexOf(this)
        if (idx >= 0) MockRaftNode.instances.splice(idx, 1)
      }

      async clientRequest(data: string, opts?: any): Promise<{ ok: boolean }> {
        if (this._status.role === 'leader') {
          // Leader: 广播给 followers
          for (const peerId of this._peers) {
            if (this._transport.sendTo) {
              this._transport.sendTo(String(peerId), Buffer.from(data, 'base64'))
            }
          }
          // Advance the commit index to mirror a real committed entry, then
          // broadcast the updated snapshot to onStateChange subscribers.
          this._status.commitIndex += 1
          this._emitState()
          return { ok: true }
        }
        return { ok: false }
      }

      async readIndex(opts?: any): Promise<void> {}

      status(): any {
        return { ...this._status }
      }

      async waitForLeaderStable(opts?: any): Promise<void> {
        if (this._status.leaderId) return
        return new Promise(resolve => {
          this._leaderStableResolve = resolve
        })
      }
    },
    SqliteStorage: class MockSqliteStorage {
      async open(): Promise<void> {}
    },
    InMemoryTransport: class InMemMock {
      sendTo(peerId: number, msg: Uint8Array): boolean { return false }
      onMessage(handler: any): void {}
    },
    ready: Promise.resolve(),
  }

  const config: ConsensusConfig = {
    mode: 'raft-logic',
    nodeId,
    peers,
    transportPort: port,
  }

  const consensus = new RaftLogicConsensus(config, mockRaftModule as any)
  await consensus.start()

  logOut({ type: 'ready', nodeId })

  // ── 监听 stdin 命令 ──
  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  rl.on('line', async (line) => {
    try {
      const msg = JSON.parse(line)
      if (!msg || !msg.type) return

      switch (msg.type) {
        case 'propose': {
          try {
            const data = Buffer.from(msg.payload?.data ?? '', 'utf-8')
            const result = await consensus.propose(data, msg.payload?.timeout ?? 5000)
            logOut({ type: 'proposeResult', ok: result.ok })
          } catch (err: any) {
            logOut({ type: 'proposeResult', ok: false, error: err.message })
          }
          break
        }
        case 'getRole': {
          logOut({ type: 'roleResult', role: consensus.getRole(), leaderId: consensus.getLeaderId(), term: consensus.getTerm() })
          break
        }
        case 'getStatus': {
          const st = consensus.getStatus()
          logOut({ type: 'statusResult', nodeId, role: st?.role, leaderId: st?.leaderId ?? null, term: st?.term, commitIndex: st?.commitIndex })
          break
        }
        case 'waitForLeader': {
          try {
            await consensus.waitForLeader(msg.payload?.timeout ?? 5000)
            logOut({ type: 'leaderReady', leaderId: consensus.getLeaderId() })
          } catch (err: any) {
            logOut({ type: 'leaderReady', error: err.message })
          }
          break
        }
        case 'stop': {
          await consensus.stop()
          logOut({ type: 'stopped' })
          process.exit(0)
          break
        }
        default:
          // ignore
      }
    } catch { /* ignore */ }
  })
}

main().catch(err => {
  logger.error(`Fatal:`, err)
  process.exit(1)
})
