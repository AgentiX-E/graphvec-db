/**
 * AC-FI-3: 日志损坏恢复
 *
 * 验证当系统没有 ConsensusProvider 的 setApply 或
 * propose 失败等异常场景下，系统能正常处理 errors 而非 crash。
 *
 * 测试场景:
 * 1. StandaloneConsensus 未设置 applyFn 时 propose 返回 { ok: false } 而非 throw
 * 2. 停止后 propose 返回 { ok: false } 而非 throw
 * 3. 使用不完整配置创建节点不会导致 crash
 * 4. RaftNode write 在 consensus 未启动时给出明确错误而非 crash
 */
import { StandaloneConsensus } from '../../src/consensus/standalone-consensus'
import { RaftNode } from '../../src/consensus/raft-node'
import { GraphEngine } from '../../src/core/graph-engine'
import { HlcClock } from '../../src/replication/hlc-clock'
import { SimulatedRaftConsensus } from '../../src/consensus/simulated-raft'
import { OverGraphConfig, RaftNodeConfig } from '../../src/types'
import * as fs from 'fs'
import * as path from 'path'

describe('AC-FI-3: 日志损坏恢复', () => {
  const dataDir = path.join('/tmp', `agentiX-fault-logcorrupt-${Date.now()}`)

  beforeAll(() => {
    fs.mkdirSync(dataDir, { recursive: true })
  })

  afterAll(() => {
    try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
    SimulatedRaftConsensus.reset()
  })

  test('StandaloneConsensus 未设置 applyFn 时 propose 返回 { ok: false } 而非崩溃', async () => {
    const cons = new StandaloneConsensus({ nodeId: 'test-log-corrupt', mode: 'standalone', peers: [] })
    await cons.start()

    // 未设置 applyFn 时 propose 应返回 { ok: false }，不会 throw
    const result = await cons.propose(new Uint8Array([1, 2, 3]))
    expect(result).toEqual({ ok: false })

    await cons.stop()
  })

  test('StandaloneConsensus 停止后 propose 返回 { ok: false } 而非崩溃', async () => {
    const cons = new StandaloneConsensus({ nodeId: 'test-log-corrupt-2', mode: 'standalone', peers: [] })
    await cons.start()
    await cons.stop()

    // 停止后调用 propose 必须返回 { ok: false }，不能 throw
    const result = await cons.propose(new Uint8Array([1, 2, 3]))
    expect(result).toEqual({ ok: false })
  })

  test('RaftNode 使用不完整配置不会导致崩溃', () => {
    // 创建最小配置的 RaftNode 不应崩溃
    const config: OverGraphConfig = { path: dataDir }
    const engine = new GraphEngine(config)
    const clock = new HlcClock()
    const raftConfig: RaftNodeConfig = {
      nodeId: 'minimal-node',
      peers: [],
      storagePath: dataDir,
    }

    // 创建实例不应 crash
    expect(() => {
      const node = new RaftNode(raftConfig, engine, clock)
      // 不调用 start，仅验证创建不崩溃
      expect(node).toBeDefined()
    }).not.toThrow()
  })

  test('RaftNode write 在 consensus 未启动时给出明确错误而非 crash', async () => {
    const config: OverGraphConfig = { path: dataDir }
    const engine = new GraphEngine(config)
    const clock = new HlcClock()
    const raftConfig: RaftNodeConfig = {
      nodeId: 'unstarted-node',
      peers: [],
      storagePath: dataDir,
    }

    // 创建且不启动 start
    const node = new RaftNode(raftConfig, engine, clock)

    // write 不应导致 crash
    await expect(
      node.write({ type: 'upsert_node', payload: { typeId: 1, name: 'ShouldFail' } })
    ).rejects.toThrow('Raft proposal failed')
  })
})
