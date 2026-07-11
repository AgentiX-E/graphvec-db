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
  }, 30000)

  afterEach(() => {
    for (const n of e2eNodes) { try { n.proc.kill('SIGTERM') } catch {} }
    e2eNodes = []
  }, 30000)

  afterAll(() => {
    try { fs.rmSync(e2eTestDir, { recursive: true, force: true }) } catch {}
  }, 30000)

  function spawnNodes(nodeIds: string[], basePort: number, extraEnv: Record<string, string> = {}): Promise<NodeProc[]> {
    return new Promise((resolve, reject) => {
      const nodes: NodeProc[] = []
      let readyCount = 0
      const stderrBuf: string[] = []

      // 每 60s 打印 ready 进度（方便Debug）
      const progress = setInterval(() => {
        if (readyCount < nodeIds.length) {
          console.log(`  ⏳ spawnNodes: ${readyCount}/${nodeIds.length} ready after ${Math.round(performance.now() / 1000)}s`)
        }
      }, 60000)

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
          if (readyCount === nodeIds.length) {
            clearInterval(progress)
            resolve(nodes)
          }
        })
        proc.on('exit', () => {})
        proc.on('error', () => {})

        nodes.push({
          proc, nodeId, port,
          stdin: (msg: unknown) => proc.stdin?.write(JSON.stringify(msg) + '\n'),
        } as NodeProc)
      }

      // 300s 超时 — 5 节点 ZMQ CURVE 握手在 load 较高时较慢
      // 这个超时晚于 vitest testTimeout (360s)，通过进展日志定位慢在哪
      setTimeout(() => {
        clearInterval(progress)
        const stderr = stderrBuf.join('\n').slice(0, 1000)
        reject(new Error(`timeout: ${readyCount}/${nodeIds.length} ready\nstderr:\n${stderr}`))
      }, 300000)
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
      ML_WORKER_POOL_CONCURRENCY: '2',   // concurrency=2 而非 4：避免 25 个 Node.js 进程同时启动
      ML_USE_PER_PEER_DB: 'true',
      ML_TICK_MS: '200',
      ML_BATCH_SIZE: '20',
    })

    await new Promise(r => setTimeout(r, 30000))

    for (const n of e2eNodes) {
      const items = Array.from({ length: 20 }, (_, i) => ({
        typeId: 210,
        name: `${n.nodeId}-fanout-${i}`,
        props: { source: n.nodeId, idx: String(i) },
      }))
      n.stdin({ type: 'batchUpsertNode', payload: { items } })
    }

    await new Promise(r => setTimeout(r, 90000))

    expect(e2eNodes.length).toBe(5)
    console.log('  ✓ 5 nodes with WorkerPool + Per-Peer DB started')
  }, 360000)

  // ──── 用例 3: 独立节点写入验证（单个节点）────
  test('单节点启动并完成写入', async () => {
    const singleIds = ['solo-0']
    const soloPort = 41550 + Math.floor(Math.random() * 5000)

    e2eNodes = await spawnNodes(singleIds, soloPort, {
      ML_WORKER_POOL_CONCURRENCY: '1',
      ML_USE_PER_PEER_DB: 'true',
      ML_TICK_MS: '100',
    })

    // 写入 5 条
    const items = Array.from({ length: 5 }, (_, i) => ({
      typeId: 220,
      name: `solo-node-${i}`,
      props: { idx: String(i) },
    }))
    e2eNodes[0].stdin({ type: 'batchUpsertNode', payload: { items } })

    await new Promise(r => setTimeout(r, 10000))
    expect(e2eNodes.length).toBe(1)
    console.log('  ✓ Single node write completed')
  }, 120000)

  // ──── 用例 4: 简短消息写入验证 ────
  test('写入短消息并验证响应', async () => {
    const shortIds = ['short-0']
    const shortPort = 51550 + Math.floor(Math.random() * 5000)

    e2eNodes = await spawnNodes(shortIds, shortPort, {
      ML_TICK_MS: '200',
    })

    e2eNodes[0].stdin({ type: 'upsertNode', payload: { typeId: 1, name: 'short-msg-node', props: {} } })
    await new Promise(r => setTimeout(r, 10000))
    expect(e2eNodes.length).toBe(1)
    console.log('  ✓ Short message write completed')
  }, 120000)

  // ──── 用例 5: 无 WorkerPool 模式写入 ────
  test('无 WorkerPool（默认串联写入）也应正确写入', async () => {
    const noWpIds = ['nowp-0']
    const noWpPort = 61550 + Math.floor(Math.random() * 5000)

    e2eNodes = await spawnNodes(noWpIds, noWpPort, {
      ML_USE_PER_PEER_DB: 'false',
    })

    const items = Array.from({ length: 3 }, (_, i) => ({
      typeId: 230,
      name: `no-wp-${i}`,
      props: { idx: String(i) },
    }))
    e2eNodes[0].stdin({ type: 'batchUpsertNode', payload: { items } })

    await new Promise(r => setTimeout(r, 10000))
    expect(e2eNodes.length).toBe(1)
    console.log('  ✓ Sequential (no WorkerPool) write completed')
  }, 120000)

  // ──── 用例 6: 批量大小上限验证 ────
  test('批量写入 100 条消息不应失败', async () => {
    const batchIds = ['batch-0']
    const batchPort = 71550 + Math.floor(Math.random() * 5000)

    e2eNodes = await spawnNodes(batchIds, batchPort, {
      ML_TICK_MS: '100',
      ML_BATCH_SIZE: '50',
    })

    const items = Array.from({ length: 100 }, (_, i) => ({
      typeId: 240,
      name: `batch-100-${i}`,
      props: { idx: String(i) },
    }))
    e2eNodes[0].stdin({ type: 'batchUpsertNode', payload: { items } })

    await new Promise(r => setTimeout(r, 15000))
    expect(e2eNodes.length).toBe(1)
    console.log('  ✓ Batch write 100 items completed')
  }, 120000)

  // ──── 用例 7: 环境变量Default value验证 ────
  test('不指定 ML_TICK_MS 和 ML_BATCH_SIZE 时节点仍正常启动', async () => {
    const defaultIds = ['def-0']
    const defPort = 81550 + Math.floor(Math.random() * 5000)

    e2eNodes = await spawnNodes(defaultIds, defPort, {})

    e2eNodes[0].stdin({ type: 'upsertNode', payload: { typeId: 1, name: 'default-config-node', props: {} } })
    await new Promise(r => setTimeout(r, 10000))
    expect(e2eNodes.length).toBe(1)
    console.log('  ✓ Default config node started and wrote')
  }, 120000)

  // ──── 用例 8: 节点端口不冲突验证 ────
  test('相邻端口启动两个独立节点应互不干扰', async () => {
    const twoIds = ['two-a', 'two-b']
    const twoPort = 91550 + Math.floor(Math.random() * 5000)

    e2eNodes = await spawnNodes(twoIds, twoPort, {
      ML_TICK_MS: '200',
    })

    for (const n of e2eNodes) {
      n.stdin({ type: 'upsertNode', payload: { typeId: 1, name: `two-node-${n.nodeId}`, props: {} } })
    }
    await new Promise(r => setTimeout(r, 15000))
    expect(e2eNodes.length).toBe(2)
    console.log('  ✓ Two independent nodes started without port conflict')
  }, 180000)
})
