import { TcpTransport } from './raft-transport'

describe('TcpTransport', () => {
  test('should create TcpTransport with default config', () => {
    const t = new TcpTransport('node-1', 0)
    expect(t).toBeDefined()
  })

  test('should create TcpTransport without arguments', () => {
    const t = new TcpTransport()
    expect(t).toBeDefined()
  })

  test('should start and stop without error', () => {
    const t = new TcpTransport('node-1', 0)
    expect(() => { t.start(); t.stop() }).not.toThrow()
  })

  test('should handle setNodeId', () => {
    const t = new TcpTransport()
    expect(() => t.setNodeId('node-x')).not.toThrow()
  })

  test('should handle setMessageHandler', () => {
    const t = new TcpTransport('node-1', 0)
    const handler = jest.fn()
    expect(() => t.setMessageHandler(handler)).not.toThrow()
  })

  test('should get port after start', () => {
    const t = new TcpTransport('node-1', 0)
    t.start()
    const port = t.getPort()
    expect(port).toBeGreaterThan(0)
    t.stop()
  })

  test('should get listen address after start', () => {
    const t = new TcpTransport('node-1', 0)
    t.start()
    const addr = t.getListenAddress()
    expect(addr).toMatch(/:\d+$/)
    t.stop()
  })

  test('should connectTo return false for invalid address', () => {
    const t = new TcpTransport('node-1', 0)
    expect(t.connectTo('')).toBe(false)
    expect(t.connectTo('bad')).toBe(false)
  })

  test('should return false sending to unknown peer', () => {
    const t = new TcpTransport('node-1', 0)
    const result = t.sendTo('nonexistent', Buffer.from('hello'))
    expect(result).toBe(false)
  })

  test('should broadcast without error when no peers', () => {
    const t = new TcpTransport('node-1', 0)
    t.start()
    // No peers — should not throw
    expect(() => { t.broadcast(Buffer.from('hello')); t.stop() }).not.toThrow()
  })

  test('should handle stop twice gracefully', () => {
    const t = new TcpTransport('node-1', 0)
    t.start()
    expect(() => { t.stop(); t.stop() }).not.toThrow()
  })

  test('static register and reset', () => {
    TcpTransport.register(9001)
    expect(() => TcpTransport.reset()).not.toThrow()
  })

  test('should send and receive messages between two transports', (done) => {
    const t1 = new TcpTransport('node-1', 0)
    const t2 = new TcpTransport('node-2', 0)

    let receivedFrom: string | null = null
    let receivedMsg: Uint8Array | null = null

    t2.setMessageHandler((from, msg) => {
      receivedFrom = from
      receivedMsg = msg
    })

    t1.start()
    t2.start()

    const t1Port = t1.getPort()
    const t2Port = t2.getPort()

    // t1 connects to t2, t2 connects to t1
    // Use t2's port so t1 can send directly
    t2.connectTo(`node-1:127.0.0.1:${t1Port}`)
    t1.connectTo(`node-2:127.0.0.1:${t2Port}`)

    // Give time for connections to establish
    setTimeout(() => {
      const msg = Buffer.from('ping')
      const sent = t1.sendTo('node-2', msg)
      if (!sent) {
        // Retry once more after another delay
        setTimeout(() => {
          t1.sendTo('node-2', msg)
        }, 500)
      }
    }, 200)

    // Wait for message delivery
    setTimeout(() => {
      expect(receivedFrom).toBe('node-1')
      if (receivedMsg) {
        expect(Buffer.from(receivedMsg).toString()).toBe('ping')
      }
      t1.stop()
      t2.stop()
      done()
    }, 1500)
  }, 5000)

  test('should handle sendTo after disconnect gracefully', (done) => {
    const t = new TcpTransport('node-1', 0)
    t.start()
    // Send to a peer that never connected
    const result = t.sendTo('ghost-peer', Buffer.from('data'))
    expect(result).toBe(false)
    t.stop()
    done()
  })
})
