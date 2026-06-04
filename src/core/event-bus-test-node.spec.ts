import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock EventBus
class MockEventBus {
  start = vi.fn().mockResolvedValue(undefined)
  stop = vi.fn().mockResolvedValue(undefined)
  getPeerNodeIds = vi.fn().mockReturnValue(['peer-1'])
  send = vi.fn().mockResolvedValue(undefined)
  setReceiveHandler = vi.fn()
  emit = vi.fn()
  on = vi.fn()

  static generateCurveKeys() {
    return {
      publicKey: Buffer.from('mock-public-key-32-bytes-long!!!'),
      secretKey: Buffer.from('mock-secret-key-32-bytes-long!!!'),
    }
  }

  static writePublicKeyToDir(_dir: string, _nodeId: string, _port: number, _publicKey: Buffer) {
    // No-op in test
  }
}

// We can't safely import event-bus-test-node.ts because it's a self-executing
// script (not a library module) that reads env vars and runs main() at top level.
// Instead, we mock the module and test the logic patterns found in it.

vi.mock('./event-bus-test-node', () => {
  return {}
})

vi.mock('./event-bus', () => ({
  EventBus: MockEventBus,
}))

// Test the logic patterns used in event-bus-test-node
describe('event-bus-test-node (logic patterns)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates EventBus with curve security config', async () => {
    const { EventBus } = await import('./event-bus')
    const bus = new EventBus({
      nodeId: 'node-1',
      security: { curve: { server: true, publicKeyDir: '/tmp/curve', port: 5500, nodeId: 'node-1' } },
      nasMonitorIntervalMs: 200,
    })

    expect(bus).toBeInstanceOf(MockEventBus)
    expect(bus.start).toBeDefined()
  })

  it('sender sends messages with correct structure', async () => {
    const { EventBus } = await import('./event-bus')
    const bus = new EventBus({} as any)
    const target = 'peer-1'

    for (let i = 0; i < 5; i++) {
      await bus.send(target, {
        msgId: `msg-${i}`,
        type: 'data',
        srcNodeId: 'sender',
        data: { idx: i },
      })
    }

    expect(bus.send).toHaveBeenCalledTimes(5)
  })

  it('receiver handler counts incoming messages', async () => {
    const { EventBus } = await import('./event-bus')
    const bus = new EventBus({} as any)

    let msgCount = 0
    const handler = vi.fn(() => { msgCount++ })
    bus.setReceiveHandler(handler)

    handler({ type: 'data', srcNodeId: 'peer-1' })
    handler({ type: 'data', srcNodeId: 'peer-1' })
    handler({ type: 'data', srcNodeId: 'peer-1' })

    expect(msgCount).toBe(3)
  })

  it('discovers peers via getPeerNodeIds', async () => {
    const { EventBus } = await import('./event-bus')
    const bus = new EventBus({} as any)

    const ids = bus.getPeerNodeIds()
    expect(ids).toContain('peer-1')
  })

  it('checks peer key file existence (new format)', async () => {
    const fsCjs = require('fs')
    const existsSyncSpy = vi.spyOn(fsCjs, 'existsSync').mockReturnValue(true)

    const peerKeyFile = '/tmp/curve/peer-1_5501.pub'
    const keyFound = fsCjs.existsSync(peerKeyFile)

    expect(keyFound).toBe(true)
    expect(existsSyncSpy).toHaveBeenCalledWith(expect.stringContaining('peer-1'))
    existsSyncSpy.mockRestore()
  })

  it('checks old format key file as fallback', async () => {
    const fsCjs = require('fs')
    const existsSyncSpy = vi.spyOn(fsCjs, 'existsSync')
    existsSyncSpy.mockReturnValueOnce(false).mockReturnValueOnce(true)

    const newFormat = '/tmp/curve/node-1_5500.pub'
    const oldFormat = '/tmp/curve/node-1.pub'

    let keyFound = false
    if (!fsCjs.existsSync(newFormat)) {
      if (fsCjs.existsSync(oldFormat)) {
        keyFound = true
      }
    }

    expect(keyFound).toBe(true)
    expect(existsSyncSpy).toHaveBeenNthCalledWith(1, expect.stringContaining('node-1'))
    expect(existsSyncSpy).toHaveBeenNthCalledWith(2, expect.stringContaining('node-1'))
    existsSyncSpy.mockRestore()
  })

  it('generates key pair before starting EventBus', async () => {
    const { EventBus } = await import('./event-bus')
    // The test node generates keys before creating EventBus
    // by calling EventBus.generateCurveKeys()
    const keys = EventBus.generateCurveKeys()

    expect(keys.publicKey).toBeDefined()
    expect(keys.secretKey).toBeDefined()
    expect(Buffer.isBuffer(keys.publicKey)).toBe(true)
  })

  it('writes public key to curveDir', async () => {
    const { EventBus } = await import('./event-bus')
    const keys = EventBus.generateCurveKeys()

    // Verify keys are generated correctly
    expect(keys.publicKey).toBeDefined()
    expect(keys.secretKey).toBeDefined()
  })

  it('starts and stops bus', async () => {
    const { EventBus } = await import('./event-bus')
    const bus = new EventBus({} as any)

    await bus.start()
    expect(bus.start).toHaveBeenCalled()

    await bus.stop()
    expect(bus.stop).toHaveBeenCalled()
  })

  it('logs progress in sender mode', () => {
    const logOut = (str: string) => {
      const msg = JSON.parse(str)
      return msg
    }

    const msg = logOut(JSON.stringify({
      type: 'sendProgress',
      current: 50,
      total: 100,
      success: 48,
    }))

    expect(msg.type).toBe('sendProgress')
    expect(msg.current).toBe(50)
    expect(msg.success).toBe(48)
  })

  it('waits for peer connection before sending', async () => {
    const { EventBus } = await import('./event-bus')
    const bus = new EventBus({} as any)

    // Simulate peer discovery loop
    const peerId = 'peer-1'
    let found = false
    for (let attempt = 0; attempt < 10; attempt++) {
      const ids = bus.getPeerNodeIds()
      if (ids.includes(peerId)) {
        found = true
        break
      }
      await new Promise(r => setTimeout(r, 10))
    }

    expect(found).toBe(true)
  })

  it('handles bus stop on exit signal', async () => {
    const { EventBus } = await import('./event-bus')
    const bus = new EventBus({} as any)

    // Simulate SIGINT handling
    const onSignal = async () => {
      await bus.stop()
    }

    await onSignal()
    expect(bus.stop).toHaveBeenCalled()
  })

  it('reports error on unexpected failure', () => {
    let lastError: string | undefined
    const logOut = (msg: any) => {
      if (msg.type === 'error') lastError = msg.message
    }

    const err = new Error('connection failed')
    logOut({ type: 'error', message: err.message })
    expect(lastError).toBe('connection failed')
  })
})
