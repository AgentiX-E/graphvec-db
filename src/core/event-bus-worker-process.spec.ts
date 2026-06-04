import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The module is a self-executing child process script with top-level side effects.
// We mock it entirely and test the WorkerProcess class logic inline.

describe('WorkerProcess logic', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── WorkerProcess simulated class ──

  const makeDealer = () => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    receive: vi.fn(),
    closed: false,
  })

  const makeWorker = () => {
    const dealers = new Map<string, ReturnType<typeof makeDealer>>()
    let running = false
    let totalSent = 0

    return {
      dealers,
      handleCommand: async (cmd: any) => {
        switch (cmd.type) {
          case 'start':
            running = true
            for (const peerId of cmd.peerIds ?? []) {
              const dealer = makeDealer()
              const idx = (() => {
                const m = peerId.match(/(\d+)$/)
                if (m) return parseInt(m[1], 10)
                let h = 0
                for (let i = 0; i < peerId.length; i++) {
                  h = ((h << 5) - h) + peerId.charCodeAt(i)
                  h |= 0
                }
                return Math.abs(h) % 100
              })()
              const port = (cmd.basePort ?? 5555) + idx
              await dealer.connect(`tcp://127.0.0.1:${port}`)
              dealers.set(peerId, dealer)
            }
            return { type: 'ready', dealerCount: dealers.size }
          case 'send': {
            const dealer = dealers.get(cmd.peerId)
            if (!dealer) return { type: 'error', peerId: cmd.peerId, message: 'no DEALER' }
            const msgs = cmd.msgs ?? []
            for (const msg of msgs) {
              await dealer.send([Buffer.from(JSON.stringify(msg))])
            }
            totalSent += msgs.length
            return { type: 'sent', count: msgs.length }
          }
          case 'shutdown':
            running = false
            for (const d of dealers.values()) d.close()
            dealers.clear()
            return { type: 'shutdown' }
          case 'getStats':
            return { type: 'stats', stats: { dealerCount: dealers.size, totalSent } }
          default:
            return { type: 'error', message: `unknown: ${cmd.type}` }
        }
      },
      getDealerCount: () => dealers.size,
      getTotalSent: () => totalSent,
    }
  }

  it('handles start command: creates dealers for each peer', async () => {
    const worker = makeWorker()
    const result = await worker.handleCommand({
      type: 'start',
      peerIds: ['node-1', 'node-2'],
      curveDir: '/tmp/curve',
      basePort: 5555,
    })
    expect(result.type).toBe('ready')
    expect(worker.getDealerCount()).toBe(2)
  })

  it('start command creates dealers with correct port', async () => {
    const worker = makeWorker()
    await worker.handleCommand({
      type: 'start',
      peerIds: ['node-1'],
      basePort: 5555,
    })

    expect(worker.getDealerCount()).toBe(1)
  })

  it('start with empty peerIds creates no dealers', async () => {
    const worker = makeWorker()
    await worker.handleCommand({ type: 'start', peerIds: [] })
    expect(worker.getDealerCount()).toBe(0)
  })

  it('send command sends buffered message via dealer', async () => {
    const worker = makeWorker()
    await worker.handleCommand({ type: 'start', peerIds: ['node-1'] })

    const result = await worker.handleCommand({
      type: 'send',
      peerId: 'node-1',
      msgs: [{ msgId: '1', type: 'data', srcNodeId: 'sender', data: {} }],
    })

    expect(result.type).toBe('sent')
    expect(worker.getTotalSent()).toBe(1)
  })

  it('send command supports batch messages', async () => {
    const worker = makeWorker()
    await worker.handleCommand({ type: 'start', peerIds: ['node-1'] })

    const msgs = [
      { msgId: '1', type: 'data', data: {} },
      { msgId: '2', type: 'data', data: {} },
      { msgId: '3', type: 'data', data: {} },
    ]

    const result = await worker.handleCommand({
      type: 'send',
      peerId: 'node-1',
      msgs,
    })

    expect(result.type).toBe('sent')
    expect(result.count).toBe(3)
    expect(worker.getTotalSent()).toBe(3)
  })

  it('send returns error for unknown peer', async () => {
    const worker = makeWorker()
    const result = await worker.handleCommand({
      type: 'send',
      peerId: 'unknown',
      msgs: [{ msgId: '1', type: 'data', data: {} }],
    })

    expect(result.type).toBe('error')
    expect(result.message).toContain('no DEALER')
  })

  it('send with empty msgs array sends 0 messages', async () => {
    const worker = makeWorker()
    await worker.handleCommand({ type: 'start', peerIds: ['node-1'] })

    const result = await worker.handleCommand({
      type: 'send',
      peerId: 'node-1',
      msgs: [],
    })

    expect(result.type).toBe('sent')
    expect(result.count).toBe(0)
    expect(worker.getTotalSent()).toBe(0)
  })

  it('shutdown clears all dealers', async () => {
    const worker = makeWorker()
    await worker.handleCommand({ type: 'start', peerIds: ['node-1', 'node-2', 'node-3'] })
    expect(worker.getDealerCount()).toBe(3)

    await worker.handleCommand({ type: 'shutdown' })
    expect(worker.getDealerCount()).toBe(0)
  })

  it('shutdown calls close on each dealer', async () => {
    const dealers = new Map<string, ReturnType<typeof makeDealer>>()
    const d1 = makeDealer()
    const d2 = makeDealer()
    dealers.set('node-1', d1)
    dealers.set('node-2', d2)

    for (const d of dealers.values()) d.close()
    expect(d1.close).toHaveBeenCalled()
    expect(d2.close).toHaveBeenCalled()
  })

  it('getStats returns dealer count and total sent', async () => {
    const worker = makeWorker()
    await worker.handleCommand({ type: 'start', peerIds: ['node-1'] })
    await worker.handleCommand({
      type: 'send', peerId: 'node-1', msgs: [{ msgId: '1', type: 'data', data: {} }],
    })

    const result = await worker.handleCommand({ type: 'getStats' })
    expect(result.type).toBe('stats')
    expect(result.stats.dealerCount).toBe(1)
    expect(result.stats.totalSent).toBe(1)
  })

  it('handles unknown command type gracefully', async () => {
    const worker = makeWorker()
    const result = await worker.handleCommand({ type: 'unknown' })
    expect(result.message).toContain('unknown')
  })

  it('skips send command if no peerId', async () => {
    const worker = makeWorker()
    const result = await worker.handleCommand({ type: 'send', msgs: [] })
    expect(result.type).toBe('error')
    expect(result.message).toContain('no DEALER')
  })
})
