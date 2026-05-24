/**
 * AC-FI-6: 共识层故障恢复
 *
 * 测试 StandaloneConsensus 在异常场景下的行为：
 * 1. propose 前不启动（start），返回 { ok: false }
 * 2. stop/start 循环恢复
 * 3. 多次 stop/start 不报错
 */
import { StandaloneConsensus } from '../../src/consensus/standalone-consensus'
import { SimulatedRaftConsensus, SimulatedRaftInstanceManager } from '../../src/consensus/simulated-raft'

describe('AC-FI-6: Consensus failure recovery', () => {
  afterEach(() => {
    SimulatedRaftInstanceManager.reset()
  })

  test('should handle propose failure gracefully without start', async () => {
    const cons = new StandaloneConsensus({ nodeId: 'test', mode: 'standalone', peers: [] })

    // propose before start — should handle gracefully, returning { ok: false }
    const result = await cons.propose(new Uint8Array([1, 2, 3]))
    expect(result).toEqual({ ok: false })

    await cons.stop()
  })

  test('should handle propose failure without setApply', async () => {
    const cons = new StandaloneConsensus({ nodeId: 'test', mode: 'standalone', peers: [] })
    await cons.start()

    // propose without setApply — should return { ok: false }
    const result = await cons.propose(new Uint8Array([1, 2, 3]))
    expect(result).toEqual({ ok: false })

    await cons.stop()
  })

  test('should recover after stop/start cycle', async () => {
    const cons = new StandaloneConsensus({ nodeId: 'test', mode: 'standalone', peers: [] })

    await cons.start()
    await cons.stop()
    await cons.start()
    await cons.stop()
  })

  test('should handle multiple start/stop without errors', async () => {
    const cons = new StandaloneConsensus({ nodeId: 'test-multi', mode: 'standalone', peers: [] })

    await cons.start()
    await cons.stop()
    await cons.start()
    await cons.stop()
    await cons.start()
    await cons.stop()
  })
})
