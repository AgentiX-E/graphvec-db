import { StandaloneConsensus } from './standalone-consensus'

describe('StandaloneConsensus — graceful degradation', () => {
  const config = {
    mode: 'standalone' as const,
    nodeId: 'test-node',
    peers: [] as string[],
  }

  test('should handle propose before start — return { ok: false }', async () => {
    const consensus = new StandaloneConsensus(config)
    const result = await consensus.propose(new Uint8Array([1, 2, 3]))
    expect(result).toEqual({ ok: false })
  })

  test('should propose successfully after start with applyFn', async () => {
    const consensus = new StandaloneConsensus(config)

    let applied: Uint8Array | null = null
    consensus.setApply(async (data: Uint8Array) => {
      applied = data
    })

    await consensus.start()
    const result = await consensus.propose(new Uint8Array([1, 2, 3]))
    expect(result).toEqual({ ok: true })
    expect(applied).toEqual(new Uint8Array([1, 2, 3]))
  })

  test('should return { ok: false } after start when no applyFn set', async () => {
    const consensus = new StandaloneConsensus(config)
    await consensus.start()

    const result = await consensus.propose(new Uint8Array([1, 2, 3]))
    expect(result).toEqual({ ok: false })
  })

  test('should degrade gracefully on applyFn error', async () => {
    const consensus = new StandaloneConsensus(config)

    consensus.setApply(async (_data: Uint8Array) => {
      throw new Error('apply error')
    })

    await consensus.start()
    const result = await consensus.propose(new Uint8Array([1, 2, 3]))
    expect(result).toEqual({ ok: false })
  })

  test('should return fallback role and leader before/after start', async () => {
    const consensus = new StandaloneConsensus(config)

    expect(consensus.getRole()).toBe('standalone')
    expect(consensus.getLeaderId()).toBeNull()
    expect(consensus.getTerm()).toBe(1)

    await consensus.start()
    expect(consensus.getRole()).toBe('standalone')
    expect(consensus.getLeaderId()).toBe('test-node')

    await consensus.stop()
    expect(consensus.getLeaderId()).toBeNull()
  })

  test('should handle consecutive propose calls gracefully', async () => {
    const consensus = new StandaloneConsensus(config)

    let appliedCount = 0
    consensus.setApply(async (_data: Uint8Array) => {
      appliedCount++
    })

    await consensus.start()

    const results = await Promise.all([
      consensus.propose(new Uint8Array([1])),
      consensus.propose(new Uint8Array([2])),
      consensus.propose(new Uint8Array([3])),
    ])

    results.forEach((r) => expect(r).toEqual({ ok: true }))
    expect(appliedCount).toBe(3)
  })

  test('should return { ok: false } when propose called after stop', async () => {
    const consensus = new StandaloneConsensus(config)

    consensus.setApply(async (_data: Uint8Array) => {
      /* no-op */
    })

    await consensus.start()
    await consensus.stop()

    const result = await consensus.propose(new Uint8Array([1, 2, 3]))
    expect(result).toEqual({ ok: false })
  })

  test('readIndex should resolve immediately even before start', async () => {
    const consensus = new StandaloneConsensus(config)

    // standalone 模式 readIndex 应始终无等待返回
    await expect(consensus.readIndex()).resolves.toBeUndefined()
  })

  test('waitForLeader should resolve immediately even before start', async () => {
    const consensus = new StandaloneConsensus(config)

    // standalone 模式 waitForLeader 应始终无等待返回
    await expect(consensus.waitForLeader()).resolves.toBeUndefined()
  })
})
