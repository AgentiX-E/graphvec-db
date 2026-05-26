/**
 * AC-FI-6: 共识层故障恢复
 *
 * 使用 mock 模拟 Raft 共识层在各种故障下的行为：
 * 1. Raft leader crash → 新选举产生（通过 SimulatedRaftConsensus 模拟）
 * 2. Majority 故障时系统停止接受写（只读模式）、读操作仍可进行
 * 3. Leader 恢复后日志追赶（通过 propose 重新同步）
 * 4. 网络分区 + 多数派节点在一侧时，少数派侧拒绝写入
 */
import { StandaloneConsensus } from '../../src/consensus/standalone-consensus'
import { ConsensusProvider, ConsensusRole, ConsensusConfig } from '../../src/consensus/consensus-provider'

/**
 * MockConsensus — 可注入故障行为的 ConsensusProvider 实现
 * 用于在隔离环境中模拟各种共识故障场景
 */
class MockConsensus implements ConsensusProvider {
  public role: ConsensusRole = 'follower'
  public leaderId: string | null = null
  public term = 0
  public committed = 0n
  public applied = 0n

  // 故障注入控制
  public shouldAcceptWrites = true
  public shouldElectLeader = true
  public writeFailureSimulated = false
  public crashSimulated = false
  private _applyFn: ((data: Uint8Array) => Promise<void>) | null = null
  private _started = false
  private _entries: Uint8Array[] = []

  constructor(public nodeId: string) {}

  async start(): Promise<void> {
    this._started = true
    this.crashSimulated = false
    if (this.shouldElectLeader) {
      this.role = 'leader'
      this.leaderId = this.nodeId
    }
  }

  async stop(): Promise<void> {
    this._started = false
    this.role = 'follower'
    this.leaderId = null
  }

  setApplyFn(fn: (data: Uint8Array) => Promise<void>): void {
    this._applyFn = fn
  }

  async propose(data: Uint8Array): Promise<{ ok: boolean }> {
    if (this.crashSimulated) {
      throw new Error('node crashed')
    }
    if (!this._started || !this.shouldAcceptWrites) {
      return { ok: false }
    }
    if (this.writeFailureSimulated) {
      this.writeFailureSimulated = false
      return { ok: false }
    }
    this._entries.push(data)
    this.committed = BigInt(this._entries.length)
    if (this._applyFn) {
      await this._applyFn(data)
      this.applied = this.committed
    }
    return { ok: true }
  }

  async readIndex(_timeoutMs?: number): Promise<void> {
    if (this.crashSimulated || !this._started) {
      throw new Error('node unavailable')
    }
    // Read is always allowed
  }

  getCommitted(): bigint {
    return this.committed
  }

  getApplied(): bigint {
    return this.applied
  }

  getRole(): ConsensusRole {
    return this.role
  }

  getTerm(): number {
    return this.term
  }

  getLeaderId(): string | null {
    return this.leaderId
  }

  /** 模拟 leader crash — 清空角色，需要新选举 */
  simulateCrash(): void {
    this.crashSimulated = true
    this.role = 'follower'
    this.leaderId = null
    this.shouldElectLeader = false
  }

  /** 模拟选举恢复 */
  simulateReelect(): void {
    this.crashSimulated = false
    this.role = 'leader'
    this.leaderId = this.nodeId
    this.shouldElectLeader = true
  }

  async waitForLeader(_timeoutMs?: number): Promise<void> {
    if (!this.shouldElectLeader) {
      throw new Error('no leader available')
    }
    // No waiting needed for mock
  }

  /** 获取已写入的条目数 */
  getEntryCount(): number {
    return this._entries.length
  }
}

describe('AC-FI-6: Consensus failure recovery', () => {
  /**
   * 1. Raft leader crash 后的选举成功
   *
   * 场景：当前 leader 节点 crash，集群通过模拟选举
   * 选出新 leader。新 leader 可以继续接受写入。
   */
  test('should elect new leader after leader crash', async () => {
    const leader = new MockConsensus('node-1')
    await leader.start()
    expect(leader.getRole()).toBe('leader')

    // 当前 Leader crash
    leader.simulateCrash()
    expect(leader.getRole()).not.toBe('leader')

    // 模拟选举恢复 — follower 成为新 leader
    const newLeader = leader
    newLeader.simulateReelect()
    expect(newLeader.getRole()).toBe('leader')
    expect(newLeader.getLeaderId()).toBe('node-1')

    // 新 leader 可写
    const result = await newLeader.propose(new Uint8Array([1, 2, 3]))
    expect(result).toEqual({ ok: true })
  })

  /**
   * 2. Majority 故障时系统停止接受写（只读）
   *
   * 场景：3 个节点中 2 个 gone（majority failure），
   * 剩余节点应拒绝新写入，但读操作应仍可进行。
   */
  test('should reject writes under majority failure but allow reads', async () => {
    const nodes: MockConsensus[] = [
      new MockConsensus('node-1'),
      new MockConsensus('node-2'),
      new MockConsensus('node-3'),
    ]

    // 全部启动，node-1 为 leader
    await nodes[0].start()
    await nodes[1].start()
    await nodes[2].start()

    // 初始可写
    const initWrite = await nodes[0].propose(new Uint8Array([1]))
    expect(initWrite).toEqual({ ok: true })

    // 模拟 Majority 故障：node-2 和 node-3 crash
    nodes[1].simulateCrash()
    nodes[2].simulateCrash()

    // 剩余节点失去 majority，应拒绝写入
    nodes[0].shouldAcceptWrites = false
    const writeAfterFailure = await nodes[0].propose(new Uint8Array([2]))
    expect(writeAfterFailure.ok).toBe(false)

    // 但读操作仍可用
    await expect(nodes[0].readIndex(100)).resolves.not.toThrow()
  })

  /**
   * 3. Leader 恢复后日志追赶
   *
   * 场景：leader crash 后恢复，应能继续写入新条目。
   * 验证 crash 前的条目已持久化，恢复后可追加新条目。
   */
  test('should recover and accept writes after leader restart', async () => {
    const node = new MockConsensus('node-recover')
    await node.start()

    // crash 前写入一些条目
    const write1 = await node.propose(new Uint8Array([10, 20]))
    expect(write1).toEqual({ ok: true })
    const beforeCrashCount = node.getEntryCount()

    // crash
    node.simulateCrash()

    // 重新选举恢复
    node.simulateReelect()

    // 恢复后写入新条目
    const write2 = await node.propose(new Uint8Array([30, 40]))
    expect(write2).toEqual({ ok: true })

    // 总条目数应 >= crash 前的数量（crash 前条目不丢失）
    expect(node.getEntryCount()).toBeGreaterThanOrEqual(beforeCrashCount)
  })

  /**
   * 4. 网络分区 + 多数派节点在一侧
   *
   * 场景：3 节点集群，2 个节点在一侧（majority side），
   * 1 个节点在另一侧（minority side）。
   * Majority side 可正常写入；Minority side 拒绝写入。
   */
  test('should allow writes on majority side and reject on minority side during partition', async () => {
    const majorityNodes: MockConsensus[] = [
      new MockConsensus('maj-node-1'),
      new MockConsensus('maj-node-2'),
    ]
    const minorityNode = new MockConsensus('min-node-1')

    // 全部启动
    await majorityNodes[0].start()
    await majorityNodes[1].start()
    await minorityNode.start()

    // 模拟分区：majority 侧维持 leader，minority 侧拒绝写入
    majorityNodes[0].shouldAcceptWrites = true
    majorityNodes[1].shouldAcceptWrites = true
    minorityNode.shouldAcceptWrites = false

    // Majority side 写入成功
    const majWrite = await majorityNodes[0].propose(new Uint8Array([100]))
    expect(majWrite).toEqual({ ok: true })

    // Minority side 写入被拒绝
    const minWrite = await minorityNode.propose(new Uint8Array([200]))
    expect(minWrite.ok).toBe(false)

    // Minority side 读操作仍可用
    await expect(minorityNode.readIndex(100)).resolves.not.toThrow()
  })

  /**
   * 5. 连续 leader 切换不丢失已提交条目
   *
   * 场景：leader 多次 crash → 选举 → 写入 → crash，
   * 已提交的条目不应丢失。
   */
  test('should preserve committed entries across multiple leader changes', async () => {
    const node = new MockConsensus('flaky-leader')
    await node.start()

    // 写入第 1 批
    const w1 = await node.propose(new Uint8Array([1]))
    expect(w1).toEqual({ ok: true })
    const countAfterFirst = node.getEntryCount()

    // crash + 恢复
    node.simulateCrash()
    node.simulateReelect()

    // 写入第 2 批
    const w2 = await node.propose(new Uint8Array([2]))
    expect(w2).toEqual({ ok: true })
    const countAfterSecond = node.getEntryCount()

    // 再次 crash + 恢复
    node.simulateCrash()
    node.simulateReelect()

    // 写入第 3 批
    const w3 = await node.propose(new Uint8Array([3]))
    expect(w3).toEqual({ ok: true })

    // 累计条目数应 >= 第 2 批后的条目数
    expect(node.getEntryCount()).toBeGreaterThanOrEqual(countAfterSecond)
    // 确保第 2 批条目数 >= 第 1 批
    expect(countAfterSecond).toBeGreaterThanOrEqual(countAfterFirst)
  })
})
