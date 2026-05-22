import { RaftLogicConsensus } from './raft-logic-consensus'

/** 创建 mock raft-logic 模块用于测试降级恢复路径 */
function createMockRaftModule() {
  return {
    ready: Promise.resolve(),
    RaftNode: class MockRaftNode {
      config: any
      constructor(config: any) {
        this.config = config
      }
      start = jest.fn()
      stop = jest.fn()
      status = jest.fn().mockReturnValue({ role: 'leader', leaderId: 'test-node', term: 1 })
      clientRequest = jest.fn().mockResolvedValue({ ok: true })
      readIndex = jest.fn().mockResolvedValue(undefined)
      waitForLeaderStable = jest.fn().mockResolvedValue(undefined)
    },
    SqliteStorage: jest.fn().mockImplementation(() => ({
      open: jest.fn(),
    })),
    InMemoryTransport: jest.fn(),
  }
}

/**
 * RaftLogicConsensus graceful degradation tests
 * Coverage: module not loaded → propose fallback, init failure, retry init
 */
describe('RaftLogicConsensus — graceful degradation', () => {
  const config = {
    nodeId: 'test-node',
    peers: ['test-node'],
    mode: 'raft-logic' as const,
  }

  test('propose should return { ok: false } when module not loaded and propose called', async () => {
    const consensus = new RaftLogicConsensus(config)
    // 不调用 init/start — 模拟模块失败
    const result = await consensus.propose(new Uint8Array([1, 2, 3]))
    expect(result).toEqual({ ok: false })
  })

  test('propose should return { ok: false } when init failed and module unavailable', async () => {
    const consensus = new RaftLogicConsensus(config)
    // init() 会尝试加载模块但失败，保存错误但不抛出
    await consensus.init()
    expect(consensus._isLoaded()).toBe(false)
    expect(consensus._getLoadError()).toBeInstanceOf(Error)

    const result = await consensus.propose(new Uint8Array([1, 2, 3]))
    expect(result).toEqual({ ok: false })
  })

  test('should allow retry init after failure with injected mock module', async () => {
    const consensus = new RaftLogicConsensus(config)

    // 第一次 init 失败（raft-logic 模块不存在）
    await consensus.init()
    expect(consensus._isLoaded()).toBe(false)
    expect(consensus._getLoadError()).toBeInstanceOf(Error)

    // 注入 mock module 并重新调用 init()
    ;(consensus as any)._moduleRef = createMockRaftModule()
    await consensus.init()
    expect(consensus._isLoaded()).toBe(true)
    expect(consensus._getLoadError()).toBeNull()
  })

  test('propose should succeed after retry init with mock module', async () => {
    const consensus = new RaftLogicConsensus(config)

    // init 失败
    await consensus.init()
    expect(consensus._isLoaded()).toBe(false)

    // 注入 mock module 并重新 init
    ;(consensus as any)._moduleRef = createMockRaftModule()
    await consensus.init()
    expect(consensus._isLoaded()).toBe(true)

    // 现在 start + propose 应该成功
    await consensus.start()
    const result = await consensus.propose(new Uint8Array([1, 2, 3]))
    expect(result.ok).toBe(true)
  })
})

describe('RaftLogicConsensus', () => {
  const mockConfig = {
    nodeId: 'test',
    mode: 'raft-logic' as const,
    peers: ['peer1'],
  }

  test('should construct without error', () => {
    const rl = new RaftLogicConsensus(mockConfig)
    expect(rl).toBeDefined()
  })

  test('init should handle unavailable module gracefully', async () => {
    const rl = new RaftLogicConsensus(mockConfig)
    // init() should not throw even if raft-logic is missing
    await expect(rl.init()).resolves.toBeUndefined()
    expect(rl._isLoaded()).toBe(false)
    expect(rl._getLoadError()).toBeInstanceOf(Error)
  })

  test('start should throw with clear message when module missing', async () => {
    const rl = new RaftLogicConsensus(mockConfig)
    await expect(rl.start()).rejects.toThrow(
      /RaftLogicConsensus failed to load 'raft-logic' module/i
    )
  })

  test('start should throw with installation instructions when module missing', async () => {
    const rl = new RaftLogicConsensus(mockConfig)
    await expect(rl.start()).rejects.toThrow(
      /npm install raft-logic/i
    )
  })

  test('isAvailable returns false when node not started', () => {
    const rl = new RaftLogicConsensus(mockConfig)
    const role = rl.getRole()
    expect(role).toBe('follower')
    expect(rl.getLeaderId()).toBeNull()
    expect(rl.getTerm()).toBe(0)
  })

  test('setApply should accept a callback', () => {
    const rl = new RaftLogicConsensus(mockConfig)
    const fn = async (_data: Uint8Array) => {
      /* no-op */
    }
    expect(() => rl.setApply(fn)).not.toThrow()
  })

  describe('mock module injection', () => {
    test('should accept mock module via constructor and initialize successfully', async () => {
      const mockModule = {
        ready: Promise.resolve(),
        RaftNode: jest.fn().mockImplementation(() => ({
          start: jest.fn(),
          stop: jest.fn(),
          status: jest.fn().mockReturnValue({
            role: 'follower',
            leaderId: null,
            term: 0,
          }),
          clientRequest: jest.fn(),
          readIndex: jest.fn(),
          waitForLeaderStable: jest.fn(),
        })),
        SqliteStorage: jest.fn().mockImplementation(() => ({
          open: jest.fn(),
        })),
        InMemoryTransport: jest.fn(),
      }

      const rl = new RaftLogicConsensus(mockConfig, mockModule)
      expect(rl._isLoaded()).toBe(false)

      await rl.init()
      expect(rl._isLoaded()).toBe(true)
      expect(rl._getLoadError()).toBeNull()
    })

    test('should use injected mock module in start', async () => {
      const mockRaftNode = {
        start: jest.fn(),
        stop: jest.fn(),
        status: jest.fn().mockReturnValue({
          role: 'leader',
          leaderId: 'test',
          term: 1,
        }),
        clientRequest: jest.fn().mockResolvedValue({ ok: true }),
        readIndex: jest.fn().mockResolvedValue(undefined),
        waitForLeaderStable: jest.fn().mockResolvedValue(undefined),
      }

      const mockModule = {
        ready: Promise.resolve(),
        RaftNode: jest.fn().mockImplementation(() => mockRaftNode),
        SqliteStorage: jest.fn().mockImplementation(() => ({
          open: jest.fn(),
        })),
        InMemoryTransport: jest.fn(),
      }

      const rl = new RaftLogicConsensus(mockConfig, mockModule)
      await rl.start()

      expect(rl.getRole()).toBe('leader')
      expect(rl.getLeaderId()).toBe('test')
      expect(rl.getTerm()).toBe(1)
    })

    test('should handle propose with mock module', async () => {
      const mockRaftNode = {
        start: jest.fn(),
        stop: jest.fn(),
        status: jest.fn().mockReturnValue({
          role: 'leader',
          leaderId: 'test',
          term: 1,
        }),
        clientRequest: jest.fn().mockResolvedValue({ ok: true }),
        readIndex: jest.fn().mockResolvedValue(undefined),
        waitForLeaderStable: jest.fn().mockResolvedValue(undefined),
      }

      const mockModule = {
        ready: Promise.resolve(),
        RaftNode: jest.fn().mockImplementation(() => mockRaftNode),
        SqliteStorage: jest.fn().mockImplementation(() => ({
          open: jest.fn(),
        })),
        InMemoryTransport: jest.fn(),
      }

      const rl = new RaftLogicConsensus(mockConfig, mockModule)
      await rl.start()

      const result = await rl.propose(new Uint8Array([1, 2, 3]))
      expect(result).toEqual({ ok: true })
      expect(mockRaftNode.clientRequest).toHaveBeenCalled()
    })

    test('should stop gracefully with mock module', async () => {
      const mockRaftNode = {
        start: jest.fn(),
        stop: jest.fn(),
        status: jest.fn().mockReturnValue({
          role: 'follower',
          leaderId: null,
          term: 0,
        }),
        clientRequest: jest.fn(),
        readIndex: jest.fn(),
        waitForLeaderStable: jest.fn(),
      }

      const mockModule = {
        ready: Promise.resolve(),
        RaftNode: jest.fn().mockImplementation(() => mockRaftNode),
        SqliteStorage: jest.fn().mockImplementation(() => ({
          open: jest.fn(),
        })),
        InMemoryTransport: jest.fn(),
      }

      const rl = new RaftLogicConsensus(mockConfig, mockModule)
      await rl.start()
      expect(rl._isLoaded()).toBe(true)

      await rl.stop()
      expect(mockRaftNode.stop).toHaveBeenCalled()
      expect(rl.getRole()).toBe('follower')
    })

    test('propose should return ok:false when node not started', async () => {
      const rl = new RaftLogicConsensus(mockConfig, {})
      const result = await rl.propose(new Uint8Array([1, 2, 3]))
      expect(result).toEqual({ ok: false })
    })
  })
})
