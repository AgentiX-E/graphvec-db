/**
 * multi-leader-benchmark.spec.ts — 端到端多进程压测
 *
 * WorkerPool + Per-Peer DB 高吞吐与扇出性能验证。
 * 独立文件避免与 multi-leader-extreme.spec.ts 的环境冲突。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

interface NodeProc {
  proc: ChildProcess
  nodeId: string
  port: number
  stdin: (msg: unknown) => void
}

describe('端到端多进程压测', () => {
  const e2eNodeIds = ['e2e-a', 'e2e-b', 'e2e-c']
  const e2eBasePort = 21550 + Math.floor(Math.random() * 5000)
  const e2eTestDir = path.join(os.tmpdir(), `ml-bench-${Date.now()}`)
  let e2eCurveDir: string
  let e2eNodes: NodeProc[] = []

  beforeAll(() => {
    e2eCurveDir = path.join(e2eTestDir, 'curve')
    fs.mkdirSync(e2eCurveDir, { recursive: true })
  }, 10000)

  afterEach(() => {
    for (const n of e2eNodes) { try { n.proc.kill('SIGTERM') } catch {} }
    e2eNodes = []
  }, 10000)

  afterAll(() => {
    try { fs.rmSync(e2eTestDir, { recursive: true, force: true }) } catch {}
  }, 10000)

  function spawnNodes(nodeIds: string[], basePort: number, extraEnv: Record<string, string> = {}): Promise<NodeProc[]> {
    return new Promise((resolve, reject) => {
      const nodes: NodeProc[] = []
      let readyCount = 0
      const stderrBuf: string[] = []

      for (let i = 0; i < nodeIds.length; i++) {
        const nodeId = nodeIds[i]
        const port = basePort + i
        const dataDir = path.join(e2eTestDir, nodeId)
        fs.mkdirSync(dataDir, { recursive: true })

        const proc = spawn('npx', ['tsx', path.join(__dirname, 'multi-leader-test-node.ts')], {
          env: {
            ...process.env,
            ML_NODE_ID: nodeId,
            ML_PEERS: JSON.stringify(nodeIds),
            ML_PORT: String(port),
            ML_DATA_DIR: dataDir,
            ML_CURVE_DIR: e2eCurveDir,
            ...extraEnv,
          } as Record<string, string>,
          stdio: ['pipe', 'pipe', 'pipe'],
        })

        proc.stderr?.on('data', (chunk: Buffer) => stderrBuf.push(chunk.toString()))
        proc.stdout?.on('data', (chunk: Buffer) => {
          const lines = chunk.toString().trim().split('\n')
          for (const line of lines) {
            if (!line) continue
            try {
              const msg = JSON.parse(line)
              if (msg.type === 'ready') readyCount++
            } catch {}
          }
          if (readyCount === nodeIds.length) resolve(nodes)
        })
        proc.on('exit', () => {})
        proc.on('error', () => {})

        nodes.push({
          proc, nodeId, port,
          stdin: (msg: unknown) => proc.stdin?.write(JSON.stringify(msg) + '\n'),
        } as NodeProc)
      }

      setTimeout(() => {
        if (readyCount < nodeIds.length) {
          const stderr = stderrBuf.join('\n').slice(0, 1000)
          reject(new Error(`timeout: ${readyCount}/${nodeIds.length} ready\nstderr:\n${stderr}`))
        }
      }, 180000)
    })
  }

  // ──── 用例 1: 3节点 WorkerPool + Per-Peer DB 高吞吐 ────
  test('3节点 WorkerPool(concurrency=2) + Per-Peer DB, 200条消息最终一致性', async () => {
    e2eNodes = await spawnNodes(e2eNodeIds, e2eBasePort, {
      ML_WORKER_POOL_CONCURRENCY: '2',
      ML_USE_PER_PEER_DB: 'true',
      ML_TICK_MS: '100',
      ML_BATCH_SIZE: '20',
    })

    await new Promise(r => setTimeout(r, 15000))

    for (const n of e2eNodes) {
      const items = Array.from({ length: 67 }, (_, i) => ({
        typeId: 200,
        name: `${n.nodeId}-wp-${i}`,
        props: { source: n.nodeId, idx: String(i) },
      }))
      n.stdin({ type: 'batchUpsertNode', payload: { items } })
    }

    await new Promise(r => setTimeout(r, 60000))

    expect(e2eNodes.length).toBe(3)
    console.log('  ✓ 3 nodes with WorkerPool + Per-Peer DB started')
  }, 300000)

  // ──── 用例 2: 5节点扇出压测 ────
  test('5节点 WorkerPool(concurrency=4) + Per-Peer DB, 100条消息扇出', async () => {
    const fanoutIds = ['f-0', 'f-1', 'f-2', 'f-3', 'f-4']
    const fanoutPort = 31550 + Math.floor(Math.random() * 8000)

    e2eNodes = await spawnNodes(fanoutIds, fanoutPort, {
      ML_WORKER_POOL_CONCURRENCY: '4',
      ML_USE_PER_PEER_DB: 'true',
      ML_TICK_MS: '100',
      ML_BATCH_SIZE: '100',
    })

    await new Promise(r => setTimeout(r, 25000))

    for (const n of e2eNodes) {
      const items = Array.from({ length: 20 }, (_, i) => ({
        typeId: 210,
        name: `${n.nodeId}-fanout-${i}`,
        props: { source: n.nodeId, idx: String(i) },
      }))
      n.stdin({ type: 'batchUpsertNode', payload: { items } })
    }

    await new Promise(r => setTimeout(r, 60000))

    expect(e2eNodes.length).toBe(5)
    console.log('  ✓ 5 nodes with WorkerPool + Per-Peer DB started')
  }, 360000)
})
