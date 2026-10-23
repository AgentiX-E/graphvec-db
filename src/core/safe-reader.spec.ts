import { SafeReader } from './safe-reader'
import type { ConsensusProvider } from '../consensus/consensus-provider'
import { vi, type Mocked } from 'vitest'

describe('SafeReader', () => {
  describe('with consensus provider', () => {
    let mockProvider: Mocked<ConsensusProvider>

    beforeEach(() => {
      mockProvider = {
        readIndex: vi.fn().mockResolvedValue(undefined),
        sync: vi.fn(),
        on: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      } as unknown as Mocked<ConsensusProvider>
    })

    test('should call readIndex before read', async () => {
      const reader = new SafeReader(mockProvider)
      const result = await reader.read(() => 42)
      expect(mockProvider.readIndex).toHaveBeenCalledTimes(1)
      expect(result.data).toBe(42)
    })

    test('should return refreshedAt timestamp', async () => {
      const reader = new SafeReader(mockProvider)
      const before = Date.now()
      const result = await reader.read(() => 'hello')
      expect(result.refreshedAt).toBeGreaterThanOrEqual(before)
    })
  })

  describe('without consensus provider', () => {
    test('should execute read directly when disabled', async () => {
      const reader = new SafeReader(undefined, { enabled: false })
      const result = await reader.read(() => 'no-raft')
      expect(result.data).toBe('no-raft')
    })

    test('should execute read directly when no provider', async () => {
      const reader = new SafeReader()
      const result = await reader.read(() => 99)
      expect(result.data).toBe(99)
    })
  })

  describe('config', () => {
    test('should accept custom timeout', async () => {
      const mockProvider = {
        readIndex: vi.fn().mockResolvedValue(undefined),
      } as unknown as ConsensusProvider
      const reader = new SafeReader(mockProvider, { readIndexTimeoutMs: 100 })
      await reader.read(() => true)
      expect(mockProvider.readIndex).toHaveBeenCalledWith(100)
    })
  })

  describe('setEnabled / setProvider', () => {
    test('should toggle enabled', () => {
      const reader = new SafeReader()
      expect(reader.enabled).toBe(false)
      reader.setEnabled(true)
      expect(reader.enabled).toBe(true)
    })

    test('should accept late provider injection', async () => {
      const reader = new SafeReader()
      reader.setEnabled(true)

      const mockProvider = {
        readIndex: vi.fn().mockResolvedValue(undefined),
      } as unknown as ConsensusProvider
      reader.setProvider(mockProvider)

      await reader.read(() => 'late')
      expect(mockProvider.readIndex).toHaveBeenCalled()
    })
  })

  // ──────────────────────────────────────────────────
  // consistentRead — barrier 语义测试
  // ──────────────────────────────────────────────────
  describe('consistentRead', () => {
    test('should call barrier() when provider exposes it', async () => {
      const barrierFn = vi.fn().mockResolvedValue(undefined)
      const providerWithBarrier = {
        readIndex: vi.fn(),
        barrier: barrierFn,
      } as unknown as ConsensusProvider

      const reader = new SafeReader(providerWithBarrier)
      const result = await reader.consistentRead(() => 'barrier-done')

      expect(barrierFn).toHaveBeenCalledTimes(1)
      expect(result.data).toBe('barrier-done')
    })

    test('should fallback to readIndex when provider lacks barrier()', async () => {
      const readIndexFn = vi.fn().mockResolvedValue(undefined)
      const providerNoBarrier = {
        readIndex: readIndexFn,
      } as unknown as ConsensusProvider

      const reader = new SafeReader(providerNoBarrier)
      const result = await reader.consistentRead(() => 'fallback-to-readindex')

      expect(readIndexFn).toHaveBeenCalledTimes(1)
      expect(result.data).toBe('fallback-to-readindex')
    })

    test('should pass timeoutMs to barrier()', async () => {
      const barrierFn = vi.fn().mockResolvedValue(undefined)
      const providerWithBarrier = {
        readIndex: vi.fn(),
        barrier: barrierFn,
      } as unknown as ConsensusProvider

      const reader = new SafeReader(providerWithBarrier, { readIndexTimeoutMs: 42 })
      await reader.consistentRead(() => 'timed-barrier')

      expect(barrierFn).toHaveBeenCalledWith(42)
    })

    test('should return refreshedAt with consistentRead', async () => {
      const providerWithBarrier = {
        readIndex: vi.fn(),
        barrier: vi.fn().mockResolvedValue(undefined),
      } as unknown as ConsensusProvider

      const reader = new SafeReader(providerWithBarrier)
      const before = Date.now()
      const result = await reader.consistentRead(() => 'timed')
      expect(result.refreshedAt).toBeGreaterThanOrEqual(before)
    })

    test('should not call barrier or readIndex when disabled', async () => {
      const barrierFn = vi.fn()
      const readIndexFn = vi.fn()
      const providerWithBarrier = {
        readIndex: readIndexFn,
        barrier: barrierFn,
      } as unknown as ConsensusProvider

      const reader = new SafeReader(providerWithBarrier, { enabled: false })
      await reader.consistentRead(() => 'disabled')

      expect(barrierFn).not.toHaveBeenCalled()
      expect(readIndexFn).not.toHaveBeenCalled()
    })

    test('should execute directly when no provider', async () => {
      const reader = new SafeReader()
      const result = await reader.consistentRead(() => 'no-provider')
      expect(result.data).toBe('no-provider')
    })

    test('should propagate barrier() errors when no fallback tolerance', async () => {
      const barrierFn = vi.fn().mockRejectedValue(new Error('barrier failed'))
      const readIndexFn = vi.fn().mockResolvedValue(undefined)
      const provider = {
        readIndex: readIndexFn,
        barrier: barrierFn,
      } as unknown as ConsensusProvider

      const reader = new SafeReader(provider)
      // barrier 抛错 — SafeReader 的 consistentRead 不吞Error
      // （Error容忍由 RAFT Consensus 层的 barrier 实现保证）
      await expect(reader.consistentRead(() => 'should-throw')).rejects.toThrow('barrier failed')
    })
  })
})

// ---- SafeReader 扩展测试 ----

describe('SafeReader — expansion', () => {
  for (let iter = 0; iter < 15; iter++) {
    test(`read without config #${iter}`, async () => {
      const reader = new SafeReader()
      const result = await reader.read(() => iter)
      expect(result.data).toBe(iter)
      expect(typeof result.refreshedAt).toBe('number')
    })
  }

  for (let iter = 0; iter < 10; iter++) {
    test(`consistentRead without config #${iter}`, async () => {
      const reader = new SafeReader()
      const result = await reader.consistentRead(() => `cons-${iter}`)
      expect(result.data).toBe(`cons-${iter}`)
    })
  }

  for (let iter = 0; iter < 10; iter++) {
    test(`setEnabled toggle #${iter}`, () => {
      const reader = new SafeReader()
      reader.setEnabled(true)
      expect(reader.enabled).toBe(true)
      reader.setEnabled(false)
      expect(reader.enabled).toBe(false)
    })
  }
})
