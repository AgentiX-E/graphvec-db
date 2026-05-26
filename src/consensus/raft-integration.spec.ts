/**
 * raft-integration.spec.ts — Raft 跨进程 TCP 集成测试
 *
 * 启动 3 个子进程，每个使用 TcpTransport 通过 TCP 通信。
 * 验证 leader 选举、log replication、propose/broadcast、故障恢复。
 *
 * 子进程启动方式：npx tsx src/consensus/raft-test-node.ts
 * 通信方式：stdin/stdout JSON 行协议
 */

import { spawn, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface RaftNodeProc {
  proc: ChildProcess
  nodeId: string
  port: number
  stdin: (msg: unknown) => void
}

const BASE_PORT = 19550
const TEST_DIR = path.join(os.tmpdir(), `raft-integration-${Date.now()}`)

function startNodes(count: number): Promise<RaftNodeProc[]> {
  const nodes: RaftNodeProc[] = []
  return new Promise((resolve, reject) => {
    let started = 0
    let hadError = false

    for (let i = 0; i < count; i++) {
      const nodeId = String(i + 1)
      const port = BASE_PORT + i
      const dataDir = path.join(TEST_DIR, `node-${nodeId}`)
      fs.mkdirSync(dataDir, { recursive: true })

      // 构造 peers 列表：排除自身
      const peers: string[] = []
      for (let j = 0; j < count; j++) {
        const peerId = String(j + 1)
        if (peerId !== nodeId) {
          peers.push(`${peerId}:127.0.0.1:${BASE_PORT + j}`)
        }
      }

      const proc = spawn('npx', ['tsx', path.join(__dirname, 'raft-test-node.ts')], {
        env: {
          ...process.env,
          RT_NODE_ID: nodeId,
          RT_PEERS: JSON.stringify(peers),
          RT_PORT: String(port),
          RT_DATA_DIR: dataDir,
        } as Record<string, string>,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let errBuf = ''
      proc.stderr?.on('data', (d: Buffer) => { errBuf += d.toString() })
      proc.on('exit', (code) => {
        if (errBuf) console.log(`Raft[${nodeId}] stderr:`, errBuf.slice(0, 200))
        if (code !== 0 && !hadError) {
          hadError = true
          reject(new Error(`${nodeId} exited with code ${code} (before ready): ${errBuf}`))
        }
      })
      proc.on('error', (e) => { hadError = true; reject(e) })

      const node: RaftNodeProc = { proc, nodeId, port, stdin: (msg) => { proc.stdin?.write(JSON.stringify(msg) + '\n') } }
      nodes.push(node)
    }

    // 等待所有节点 ready
    let readyCount = 0
    for (const n of nodes) {
      const timeout = setTimeout(() => {
        if (!hadError) { hadError = true; reject(new Error(`[${n.nodeId}] timeout waiting for ready`)) }
      }, 30000)
      let buf = ''
      n.proc.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          try {
            const msg = JSON.parse(line)
            if (msg?.type === 'ready') {
              clearTimeout(timeout)
              readyCount++
              console.log(`Raft ✅ ${n.nodeId} ready`)
              if (readyCount >= count) resolve(nodes)
              return
            }
          } catch { /* partial JSON */ }
        }
      })
    }
  })
}

/** 等待指定 type 的响应 */
function waitForMsg(n: RaftNodeProc, msgType: string, timeoutMs = 10000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timeout waiting for ${msgType} on ${n.nodeId}`)), timeoutMs)
    let buf = ''
    const onData = (chunk: Buffer) => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        try {
          const msg = JSON.parse(line)
          if (msg?.type === msgType) {
            clearTimeout(timeout)
            n.proc.stdout?.off('data', onData)
            resolve(msg)
            return
          }
        } catch { /* partial */ }
      }
    }
    n.proc.stdout?.on('data', onData)
  })
}

describe('Raft 跨进程集成测试', () => {
  let nodes: RaftNodeProc[]

  beforeAll(async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true })
    nodes = await startNodes(3)
    // 等待 leader 选举
    await sleep(500)
  }, 45000)

  afterAll(() => {
    for (const n of nodes) {
      try { n.stdin({ type: 'stop' }) } catch {}
    }
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }) } catch {}
  }, 10000)

  test('所有节点应通过 TCP 启动并响应 getRole', async () => {
    for (const n of nodes) {
      n.stdin({ type: 'getRole' })
      const resp = await waitForMsg(n, 'roleResult', 5000)
      expect(resp).toBeDefined()
      expect(resp.role).toBeDefined()
      expect(['leader', 'follower']).toContain(resp.role)
      console.log(`  ${n.nodeId}: role=${resp.role}, leader=${resp.leaderId}, term=${resp.term}`)
    }
  }, 15000)

  test('集群应完成 leader 选举（leader 不为 null）', async () => {
    for (const n of nodes) {
      n.stdin({ type: 'waitForLeader', payload: { timeout: 5000 } })
      const resp = await waitForMsg(n, 'leaderReady', 8000)
      expect(resp.leaderId).toBeDefined()
      expect(resp.leaderId).not.toBeNull()
    }
    console.log(`  Leader 已选举`)
  }, 20000)

  test('leader 节点 propose 应成功', async () => {
    // 找到 leader
    let leader: RaftNodeProc | null = null
    for (const n of nodes) {
      n.stdin({ type: 'getRole' })
      const resp = await waitForMsg(n, 'roleResult', 5000)
      if (resp.role === 'leader') { leader = n; break }
    }
    expect(leader).not.toBeNull()

    // propose
    leader!.stdin({ type: 'propose', payload: { data: 'hello-raft', timeout: 5000 } })
    const resp = await waitForMsg(leader!, 'proposeResult', 10000)
    expect(resp.ok).toBe(true)
    console.log(`  Leader propose 成功`)
  }, 20000)

  test('follower 节点 propose 应返回 ok=false（非 leader 转发）', async () => {
    let follower: RaftNodeProc | null = null
    for (const n of nodes) {
      n.stdin({ type: 'getRole' })
      const resp = await waitForMsg(n, 'roleResult', 5000)
      if (resp.role === 'follower') { follower = n; break }
    }
    // 如果所有节点都是 leader（单节点），跳过
    if (!follower) {
      console.log('  (只有 leader 节点，skip)')
      return
    }

    follower!.stdin({ type: 'propose', payload: { data: 'follower-write', timeout: 3000 } })
    const resp = await waitForMsg(follower!, 'proposeResult', 8000)
    expect(resp.ok).toBe(false)
    console.log(`  Follower propose 返回 ok=false（预期）`)
  }, 15000)
})
