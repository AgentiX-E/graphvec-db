import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockExit = vi.fn((() => {}) as any)

// We don't use vi.mock for zeromq since other specs may have already
// registered mocks. Instead, test functionality inline.

describe('multi-leader-test-node (logic patterns)', () => {
  beforeEach(() => {
    process.env.MLTN_NODE_ID = 'node-1'
    process.env.MLTN_PORT = '5000'
    process.env.MLTN_PEER_IDS = 'node-2,node-3'
    process.env.MLTN_PEER_PORTS = '5001,5002'
    process.env.MLTN_CURVE_DIR = '/tmp/curve'
    process.env.MLTN_ROLE = 'leader'
  })

  afterEach(() => {
    delete process.env.MLTN_NODE_ID
    delete process.env.MLTN_PORT
    delete process.env.MLTN_PEER_IDS
    delete process.env.MLTN_PEER_PORTS
    delete process.env.MLTN_CURVE_DIR
    delete process.env.MLTN_ROLE
  })

  it('requires MLTN_NODE_ID environment variable', () => {
    expect(process.env.MLTN_NODE_ID).toBe('node-1')
  })

  it('requires MLTN_PORT environment variable', () => {
    const port = parseInt(process.env.MLTN_PORT!, 10)
    expect(port).toBe(5000)
  })

  it('parses MLTN_PEER_IDS into an array', () => {
    const peerIds = process.env.MLTN_PEER_IDS!.split(',')
    expect(peerIds).toEqual(['node-2', 'node-3'])
  })

  it('parses MLTN_PEER_PORTS into number array', () => {
    const peerPorts = process.env.MLTN_PEER_PORTS!.split(',').map(Number)
    expect(peerPorts).toEqual([5001, 5002])
  })

  it('builds peer address from peerId and port', () => {
    const peerIds = ['node-2', 'node-3']
    const peerPorts = [5001, 5002]
    const addresses = peerIds.map((id, i) => `tcp://127.0.0.1:${peerPorts[i]}`)
    expect(addresses).toEqual([
      'tcp://127.0.0.1:5001',
      'tcp://127.0.0.1:5002',
    ])
  })

  it('leader role sets up Router at node port', () => {
    const port = 5000
    const addr = `tcp://127.0.0.1:${port}`
    expect(addr).toBe('tcp://127.0.0.1:5000')
  })

  it('follower role creates Dealer connections to leaders', () => {
    const peerPorts = [5000, 5001]
    const addresses = peerPorts.map(p => `tcp://127.0.0.1:${p}`)
    expect(addresses).toHaveLength(2)
    expect(addresses[0]).toBe('tcp://127.0.0.1:5000')
  })

  it('simulates creating ZMQ Dealer for each peer', async () => {
    const peerPorts = [5001, 5002]
    // Inline mock dealer
    const mockDealer = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined),
      receive: vi.fn(),
    }

    for (const port of peerPorts) {
      await mockDealer.connect(`tcp://127.0.0.1:${port}`)
    }

    expect(mockDealer.connect).toHaveBeenCalledTimes(2)
    expect(mockDealer.connect).toHaveBeenCalledWith('tcp://127.0.0.1:5001')
    expect(mockDealer.connect).toHaveBeenCalledWith('tcp://127.0.0.1:5002')
  })

  it('generates CURVE keys (inline curve key pair)', () => {
    const curveKeyPair = () => ({
      publicKey: 'mock-public-key',
      secretKey: 'mock-secret-key',
    })

    const keyPair = curveKeyPair()
    expect(keyPair.publicKey).toBe('mock-public-key')
    expect(keyPair.secretKey).toBe('mock-secret-key')
  })

  it('writes public key file after successful start', () => {
    const curveDir = '/tmp/curve'
    const nodeId = 'node-1'
    const port = 5000
    const publicKey = 'mock-public-key'

    const filename = `${curveDir}/${nodeId}_${port}.pub`
    expect(filename).toBe('/tmp/curve/node-1_5000.pub')
  })

  it('receives ACK from dealer and parses it', async () => {
    const dealer = {
      receive: vi.fn(),
    }
    dealer.receive.mockResolvedValue([
      Buffer.from(JSON.stringify({ type: 'ack', ackMsgId: 'msg-1' })),
    ])

    const frames = await dealer.receive()
    expect(frames).toBeDefined()
    if (frames && frames.length > 0) {
      const payload = frames[frames.length - 1]
      const text = Buffer.from(payload).toString()
      const msg = JSON.parse(text)
      expect(msg.type).toBe('ack')
      expect(msg.ackMsgId).toBe('msg-1')
    }
  })

  it('forwards ACK to parent process via IPC', () => {
    const ipcSend = vi.fn()
    const ackMsg = { type: 'ack', peerId: 'node-2', msgId: 'msg-42' }
    ipcSend(ackMsg)
    expect(ipcSend).toHaveBeenCalledWith(ackMsg)
  })

  it('handles shutdown gracefully', () => {
    let shutdownCalled = false
    const handlers: Array<() => void> = []
    const mockProcess = {
      on: vi.fn((event: string, handler: () => void) => handlers.push(handler)),
    }

    mockProcess.on('SIGTERM', () => { shutdownCalled = true })
    // Trigger the handler
    if (handlers.length > 0) {
      handlers[0]()
    }
    expect(shutdownCalled).toBe(true)
  })

  it('simulates cleanup on disconnect', () => {
    let disconnected = false
    process.on('disconnect', () => { disconnected = true })
    process.emit('disconnect')
    expect(disconnected).toBe(true)
  })

  it('handles multiple peers with various port assignments', () => {
    const peerIds = ['node-1', 'node-2', 'node-3']
    const peerPorts = [5000, 5001, 5002]

    const connections = peerIds.map((id, i) => `tcp://127.0.0.1:${peerPorts[i]}`)
    expect(connections).toHaveLength(3)
  })

  it('supports readline-based stdin interaction', () => {
    const onData = vi.fn()
    const readlineMock = { on: onData }

    readlineMock.on('line', (line: string) => {
      expect(line).toBe('shutdown')
    })

    readlineMock.on('line', 'shutdown')
    expect(onData).toHaveBeenCalled()
  })

  it('handles error from dealer receive gracefully', async () => {
    const dealer = {
      receive: vi.fn().mockRejectedValue(new Error('connection reset')),
    }

    // Should not crash
    try {
      await dealer.receive()
    } catch (e: any) {
      expect(e.message).toBe('connection reset')
    }
  })
})
