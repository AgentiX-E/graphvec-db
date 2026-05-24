import { TcpTransport } from './transport'
import { v4 as uuid } from 'uuid'

/** 每个 describe 使用独立 namespace 避免并行冲突 */
function ns(): string {
  return uuid().slice(0, 8)
}

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

  test('should send and receive messages between two transports', async () => {
    const testNs = ns()
    const t1 = new TcpTransport('node-1', 0)
    const t2 = new TcpTransport('node-2', 0)
    t1.setNamespace(testNs)
    t2.setNamespace(testNs)

    const received: { from: string; msg: Uint8Array }[] = []

    t2.setMessageHandler((from, msg) => {
      received.push({ from, msg: new Uint8Array(msg) })
    })

    t1.start()
    t2.start()

    const t1Addr = t1.getListenAddress() // e.g. "127.0.0.1:xxxxx"
    const t2Addr = t2.getListenAddress()

    // t1 connects to t2, t2 connects to t1
    t1.connectTo(`node-2:${t2Addr}`)
    t2.connectTo(`node-1:${t1Addr}`)

    // Wait for connections to establish
    await new Promise(r => setTimeout(r, 500))

    t1.sendTo('node-2', Buffer.from('ping'))

    await new Promise(r => setTimeout(r, 1000))

    expect(received.length).toBe(1)
    expect(received[0].from).toBe('node-1')
    expect(Buffer.from(received[0].msg).toString()).toBe('ping')

    t1.stop()
    t2.stop()
  }, 5000)

  test('should handle sendTo after disconnect gracefully', (done) => {
    const t = new TcpTransport('node-1', 0)
    t.start()
    const result = t.sendTo('ghost-peer', Buffer.from('data'))
    expect(result).toBe(false)
    t.stop()
    done()
  })
})
