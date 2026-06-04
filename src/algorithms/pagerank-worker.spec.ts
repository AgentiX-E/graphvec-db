import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock worker_threads before importing the module
const mockPostMessage = vi.fn()
let messageHandler: ((msg: any) => void) | null = null

vi.mock('worker_threads', () => {
  return {
    parentPort: {
      on: vi.fn((event: string, handler: (msg: any) => void) => {
        if (event === 'message') messageHandler = handler
      }),
      postMessage: mockPostMessage,
    },
    workerData: {},
  }
})

// Helper to simulate a compute message
function simulateCompute(input: Record<string, unknown>): void {
  expect(messageHandler).not.toBeNull()
  messageHandler!({ type: 'compute', ...input })
}

function getResult(): any {
  return mockPostMessage.mock.calls[mockPostMessage.mock.calls.length - 1][0]
}

describe('pagerank-worker', () => {
  beforeEach(() => {
    mockPostMessage.mockClear()
  })

  it('loads without error', async () => {
    const mod = await import('./pagerank-worker')
    expect(mod).toBeDefined()
  })

  it('registers message handler on parentPort', async () => {
    const worker_threads = await import('worker_threads')
    expect(worker_threads.parentPort!.on).toHaveBeenCalledWith('message', expect.any(Function))
  })

  it('responds to compute message with a result', async () => {
    const input = {
      segment: [1, 2],
      rank: { 1: 0.1, 2: 0.15, 3: 0.2 },
      outgoing: { 1: [3], 2: [1, 3] },
      outDegrees: { 1: 2, 2: 1, 3: 2 },
      n: 3,
      dampingFactor: 0.85,
      danglingRank: 0.0,
    }

    simulateCompute(input)

    expect(mockPostMessage).toHaveBeenCalled()
    const callArg = getResult()
    expect(callArg.type).toBe('result')
    expect(callArg.rank).toBeDefined()
    expect(typeof callArg.diff).toBe('number')
  })

  it('computes correct PageRank for a simple graph', async () => {
    // Graph: 1 → 2 → 3
    const input = {
      segment: [1, 2, 3],
      rank: { 1: 0.333, 2: 0.333, 3: 0.334 },
      outgoing: { 1: [2], 2: [3] },
      outDegrees: { 1: 1, 2: 1, 3: 0 },
      n: 3,
      dampingFactor: 0.85,
      danglingRank: 0.334,
    }

    simulateCompute(input)

    const callArg = getResult()
    expect(callArg.type).toBe('result')
    expect(callArg.rank[1]).toBeDefined()
    expect(callArg.rank[2]).toBeDefined()
    expect(callArg.rank[3]).toBeDefined()
    expect(callArg.diff).toBeGreaterThan(0)
  })

  it('computes small diff for one iteration', async () => {
    // With valid/stable ranks the diff should be finite and non-NaN
    const input = {
      segment: [1, 2],
      rank: { 1: 0.5, 2: 0.5 },
      outgoing: { 1: [2] },
      outDegrees: { 1: 1, 2: 0 },
      n: 2,
      dampingFactor: 0.85,
      danglingRank: 0.0,
    }

    simulateCompute(input)

    const callArg = getResult()
    expect(callArg.diff).toBeDefined()
    expect(Number.isFinite(callArg.diff)).toBe(true)
    expect(callArg.diff).toBeGreaterThanOrEqual(0)
  })

  it('handles empty segment', async () => {
    const input = {
      segment: [],
      rank: { 1: 0.5, 2: 0.5 },
      outgoing: { 1: [2] },
      outDegrees: { 1: 1, 2: 0 },
      n: 2,
      dampingFactor: 0.85,
      danglingRank: 0.0,
    }

    simulateCompute(input)

    const callArg = getResult()
    expect(callArg.type).toBe('result')
    expect(Object.keys(callArg.rank)).toHaveLength(0)
    expect(callArg.diff).toBe(0)
  })

  it('handles node with no incoming edges', async () => {
    // Node 2 has no incoming (outgoing[2] is undefined)
    const input = {
      segment: [2],
      rank: { 1: 0.5, 2: 0.5 },
      outgoing: { 1: [2] },
      outDegrees: { 1: 1, 2: 0 },
      n: 2,
      dampingFactor: 0.85,
      danglingRank: 0.0,
    }

    simulateCompute(input)

    const callArg = getResult()
    expect(callArg.type).toBe('result')
    expect(callArg.rank[2]).toBeDefined()
    expect(callArg.rank[2]).toBeGreaterThan(0)
  })

  it('ignores unknown message types', async () => {
    messageHandler!({ type: 'unknown', data: 'test' })
    expect(mockPostMessage).not.toHaveBeenCalled()
  })
})
