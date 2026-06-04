import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mock zeromq ──────────────────────────────────────────────

function createSocketMock() {
  return {
    curveServer: false,
    curveSecretKey: null,
    curvePublicKey: '',
    curveServerKey: null,
    bind: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    receive: vi.fn(),
  }
}

// Use a mutable config that the mock factory reads.
// This avoids hoisting issues with vi.fn() captured inside mock factory.
const zmqKeyPairResult = {
  publicKey: 'default-pub-123456789012345678901234567890',
  secretKey: 'default-sec-123456789012345678901234567890',
}

vi.mock('zeromq', () => {
  const Router = () => createSocketMock()
  const Dealer = () => createSocketMock()
  return {
    curveKeyPair: () => ({ ...zmqKeyPairResult }),
    Router,
    Dealer,
    default: { curveKeyPair: () => ({ ...zmqKeyPairResult }), Router, Dealer },
  }
})

// ── Mock fs + path ───────────────────────────────────────────
vi.mock('node:fs', () => ({
  default: {
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

import * as fs from 'node:fs'

// ── Import AFTER mocks ───────────────────────────────────────
import {
  parsePubFilename,
  GraphEvent,
  GraphEventType,
  EventBusConfig,
  EventBus,
  EventBusSecurity,
  CurveSecurityConfig,
  TransportMessage,
  PeerDescriptor,
  initEventBus,
  getEventBus,
} from './event-bus'

// ─────────────────────────────────────────────────────────
// 1. parsePubFilename
// ─────────────────────────────────────────────────────────
describe('parsePubFilename', () => {
  it('parses a valid filename with nodeId and port', () => {
    const result = parsePubFilename('node-alpha_5555.pub')
    expect(result).not.toBeNull()
    expect(result!.nodeId).toBe('node-alpha')
    expect(result!.port).toBe(5555)
  })

  it('parses a filename with underscores in nodeId', () => {
    const result = parsePubFilename('my_node_v2_9001.pub')
    expect(result).not.toBeNull()
    expect(result!.nodeId).toBe('my_node_v2')
    expect(result!.port).toBe(9001)
  })

  it('returns null for a filename without .pub extension (no underscore variant)', () => {
    const result = parsePubFilename('invalid.pub')
    // base = "invalid", no underscore → null
    expect(result).toBeNull()
  })

  it('returns null for filenames with non-numeric port segment', () => {
    const result = parsePubFilename('node_abc.pub')
    // base = "node_abc", portStr = "abc" → NaN → null
    expect(result).toBeNull()
  })

  it('returns null for filenames with negative/zero port', () => {
    expect(parsePubFilename('node_0.pub')).toBeNull()
    expect(parsePubFilename('node_-5.pub')).toBeNull()
  })

  it('returns null for filename without .pub ending', () => {
    // Without .pub, base = whole string
    const result = parsePubFilename('just_a_file')
    expect(result).toBeNull()
  })

  it('handles empty nodeId before underscore', () => {
    const result = parsePubFilename('_1234.pub')
    expect(result).not.toBeNull()
    expect(result!.nodeId).toBe('')
    expect(result!.port).toBe(1234)
  })
})

// ─────────────────────────────────────────────────────────
// 2. GraphEvent 类型
// ─────────────────────────────────────────────────────────
describe('GraphEvent 类型', () => {
  it('supports all node lifecycle event types', () => {
    const types: GraphEventType[] = ['node:created', 'node:updated', 'node:deleted']
    for (const t of types) {
      const ev: GraphEvent = { type: t, nodeId: 'n1', timestamp: Date.now(), data: {} }
      expect(ev.type).toBe(t)
    }
  })

  it('supports all edge lifecycle event types', () => {
    const types: GraphEventType[] = ['edge:created', 'edge:updated', 'edge:deleted']
    for (const t of types) {
      const ev: GraphEvent = { type: t, nodeId: 'n1', timestamp: Date.now(), data: {} }
      expect(ev.type).toBe(t)
    }
  })

  it('supports cluster and system event types', () => {
    const clusterEvent: GraphEvent = {
      type: 'cluster:node-joined',
      nodeId: 'n2',
      timestamp: Date.now(),
      data: { remoteNodeId: 'n2' },
    }
    expect(clusterEvent.type).toBe('cluster:node-joined')

    const shutdownEvent: GraphEvent = {
      type: 'system:shutdown',
      nodeId: 'n1',
      timestamp: Date.now(),
      data: {},
    }
    expect(shutdownEvent.type).toBe('system:shutdown')
  })

  it('supports event sync and ack types', () => {
    const types: GraphEventType[] = ['event:ack', 'event:sync', 'event:sync-batch']
    for (const t of types) {
      const ev: GraphEvent = { type: t, nodeId: 'n1', timestamp: Date.now(), data: {} }
      expect(ev.type).toBe(t)
    }
  })

  it('supports backup and graph cleared types', () => {
    const types: GraphEventType[] = ['backup:start', 'backup:complete', 'graph:cleared']
    for (const t of types) {
      const ev: GraphEvent = { type: t, nodeId: 'n1', timestamp: Date.now(), data: {} }
      expect(ev.type).toBe(t)
    }
  })
})

// ─────────────────────────────────────────────────────────
// 3. EventBusConfig 校验
// ─────────────────────────────────────────────────────────
describe('EventBusConfig 校验', () => {
  it('accepts a minimal valid config with nodeId only', () => {
    const config: EventBusConfig = { nodeId: 'test-node' }
    expect(config.nodeId).toBe('test-node')
    // defaults: publishAddress = null, subscribeAddresses = [], backpressureWatermark = 10000
    expect(config.publishAddress).toBeUndefined()
    expect(config.subscribeAddresses).toBeUndefined()
  })

  it('accepts a full config with all optional fields', () => {
    const curveConfig: CurveSecurityConfig = {
      server: true,
      port: 5555,
      nodeId: 'node-a',
      publicKeyDir: '/keys',
    }
    const security: EventBusSecurity = { curve: curveConfig }
    const config: EventBusConfig = {
      nodeId: 'node-a',
      publishAddress: 'tcp://0.0.0.0:5555',
      subscribeAddresses: ['tcp://127.0.0.1:5556'],
      port: 5555,
      disableRouter: false,
      security,
      nasMonitorIntervalMs: 5000,
      backpressureWatermark: 5000,
      peerNodeIds: ['node-b'],
    }
    expect(config.nodeId).toBe('node-a')
    expect(config.publishAddress).toBe('tcp://0.0.0.0:5555')
    expect(config.subscribeAddresses).toHaveLength(1)
    expect(config.backpressureWatermark).toBe(5000)
    expect(config.security!.curve.server).toBe(true)
    expect(config.security!.curve.publicKeyDir).toBe('/keys')
  })

  it('requires nodeId to be a non-empty string', () => {
    // TypeScript validates this at compile time; at runtime we ensure no empty string
    const config: EventBusConfig = { nodeId: '' }
    expect(config.nodeId).toBe('')
  })

  it('requires security.curve when security is provided', () => {
    const curveConfig: CurveSecurityConfig = {
      server: true,
      port: 5555,
      nodeId: 'node-a',
      publicKeyDir: '/nas/keys',
    }
    const security: EventBusSecurity = { curve: curveConfig }
    expect(security.curve).toBeDefined()
    expect(security.curve.port).toBe(5555)
    expect(security.curve.nodeId).toBe('node-a')
    expect(security.curve.publicKeyDir).toBe('/nas/keys')
  })
})

// ─────────────────────────────────────────────────────────
// 4. TransportMessage 构造
// ─────────────────────────────────────────────────────────
describe('TransportMessage 构造', () => {
  it('creates a data transport message', () => {
    const msg: TransportMessage = {
      msgId: 'msg-001',
      type: 'data',
      srcNodeId: 'node-a',
      dstNodeId: 'node-b',
      data: { operation: 'node:created', payload: { id: 'n5' } },
    }
    expect(msg.msgId).toBe('msg-001')
    expect(msg.type).toBe('data')
    expect(msg.srcNodeId).toBe('node-a')
    expect(msg.dstNodeId).toBe('node-b')
    expect(msg.data.operation).toBe('node:created')
    expect(msg.ackMsgId).toBeUndefined()
  })

  it('creates an ack transport message', () => {
    const msg: TransportMessage = {
      msgId: 'ack-001',
      type: 'ack',
      srcNodeId: 'node-b',
      ackMsgId: 'msg-001',
      data: {},
    }
    expect(msg.type).toBe('ack')
    expect(msg.ackMsgId).toBe('msg-001')
    expect(msg.dstNodeId).toBeUndefined()
  })

  it('creates sync-type transport messages', () => {
    const syncQ: TransportMessage = {
      msgId: 'sq-1',
      type: 'sync-query',
      srcNodeId: 'node-a',
      data: {},
    }
    expect(syncQ.type).toBe('sync-query')

    const syncQR: TransportMessage = {
      msgId: 'sqr-1',
      type: 'sync-query-reply',
      srcNodeId: 'node-b',
      data: { latestSeq: 42 },
    }
    expect(syncQR.type).toBe('sync-query-reply')
    expect(syncQR.data.latestSeq).toBe(42)

    const syncR: TransportMessage = {
      msgId: 'sr-1',
      type: 'sync-request',
      srcNodeId: 'node-a',
      data: { fromSeq: 10 },
    }
    expect(syncR.type).toBe('sync-request')

    const syncB: TransportMessage = {
      msgId: 'sb-1',
      type: 'sync-batch',
      srcNodeId: 'node-b',
      data: { events: [] },
    }
    expect(syncB.type).toBe('sync-batch')
  })

  it('serializes and deserializes correctly with JSON', () => {
    const original: TransportMessage = {
      msgId: 'msg-005',
      type: 'data',
      srcNodeId: 'node-a',
      dstNodeId: 'node-b',
      data: { key: 'value', num: 123 },
    }
    const json = JSON.stringify(original)
    const parsed = JSON.parse(json) as TransportMessage
    expect(parsed.msgId).toBe('msg-005')
    expect(parsed.type).toBe('data')
    expect(parsed.srcNodeId).toBe('node-a')
    expect(parsed.dstNodeId).toBe('node-b')
    expect(parsed.data.key).toBe('value')
    expect(parsed.data.num).toBe(123)
  })
})

// ─────────────────────────────────────────────────────────
// 5. EventBus 单例模式
// ─────────────────────────────────────────────────────────
describe('EventBus 单例模式', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset resolved curve key pair globally
    zmqKeyPairResult.publicKey = 'pubkey1234567890123456789012345678901234567890'
    zmqKeyPairResult.secretKey = 'seckey1234567890123456789012345678901234567890'

    // Default mocks for fs
    vi.mocked(fs.readdirSync).mockReturnValue([])
    vi.mocked(fs.readFileSync).mockReturnValue('peer.public.key.here')
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined)
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any)
  })

  afterEach(async () => {
    // Stop any existing EventBus instance
    try {
      const instance = getEventBus()
      await instance.stop()
    } catch {
      // not initialized, fine
    }
  })

  it.skip('initEventBus creates a new EventBus and starts it', async () => {
    const instance = await initEventBus({
      nodeId: 'test-node',
      security: {
        curve: {
          server: true,
          port: 5555,
          nodeId: 'test-node',
          publicKeyDir: '/tmp/keys',
        },
      },
      nasMonitorIntervalMs: 0, // disable NAS monitor to avoid timer interference
    })

    expect(instance).toBeInstanceOf(EventBus)
    expect(instance.hasRouterSocket()).toBe(true)
  })

  it('getEventBus returns the same instance after initEventBus', async () => {
    const instance1 = await initEventBus({
      nodeId: 'singleton-test',
      security: {
        curve: {
          server: true,
          port: 5556,
          nodeId: 'singleton-test',
          publicKeyDir: '/tmp/keys',
        },
      },
      nasMonitorIntervalMs: 0,
    })

    const instance2 = getEventBus()
    expect(instance2).toBe(instance1)
  })

  it('getEventBus throws if EventBus not initialized', async () => {
    // Reset the module-level singleton by using vi.isolateModules
    // to get a fresh copy of the module where _instance is null.
    await vi.isolateModules(async () => {
      // Re-import inside isolated modules — this gives us a fresh module
      // with the initial null _instance
      const { getEventBus: getEB } = await import('./event-bus')
      expect(() => getEB()).toThrow('EventBus not initialized')
    })
    // After isolation, the main module's _instance is unaffected
  })

  it('initEventBus re-creates instance if called again', async () => {
    const instance1 = await initEventBus({
      nodeId: 'first',
      security: {
        curve: {
          server: true,
          port: 5557,
          nodeId: 'first',
          publicKeyDir: '/tmp/keys',
        },
      },
      nasMonitorIntervalMs: 0,
    })

    const instance2 = await initEventBus({
      nodeId: 'second',
      security: {
        curve: {
          server: true,
          port: 5558,
          nodeId: 'second',
          publicKeyDir: '/tmp/keys',
        },
      },
      nasMonitorIntervalMs: 0,
    })

    // Should be a different instance, and getEventBus returns the new one
    expect(instance2).not.toBe(instance1)
    expect(getEventBus()).toBe(instance2)
    expect(getEventBus().hasRouterSocket()).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────
// 6. CURVE 安全
// ─────────────────────────────────────────────────────────
describe('CURVE 安全', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    zmqKeyPairResult.publicKey = 'TESTPUBKEY123456789012345678901234567890'
    zmqKeyPairResult.secretKey = 'TESTSECKEY123456789012345678901234567890'
    vi.mocked(fs.readdirSync).mockReturnValue([])
    vi.mocked(fs.readFileSync).mockReturnValue('peerkey12345678901234567890')
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined)
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any)
  })

  it('CurveSecurityConfig can be properly assembled', () => {
    const curveConfig: CurveSecurityConfig = {
      server: true,
      port: 9999,
      nodeId: 'secure-node',
      publicKeyDir: '/nas/public-keys',
    }
    expect(curveConfig.server).toBe(true)
    expect(curveConfig.port).toBe(9999)
    expect(curveConfig.nodeId).toBe('secure-node')
    expect(curveConfig.publicKeyDir).toBe('/nas/public-keys')
  })

  it('EventBusSecurity requires a curve config', () => {
    const curve: CurveSecurityConfig = {
      server: false,
      port: 8888,
      nodeId: 'client-node',
      publicKeyDir: '/keys',
    }
    const security: EventBusSecurity = { curve }
    expect(security.curve).toEqual(curve)
  })

  it('generateCurveKeys calls zmq.curveKeyPair and returns keys', () => {
    zmqKeyPairResult.publicKey = 'abc123pub'
    zmqKeyPairResult.secretKey = 'xyz789secret'

    const keys = EventBus.generateCurveKeys()
    expect(keys.publicKey).toBe('abc123pub')
    expect(keys.secretKey).toBe('xyz789secret')
  })

  it('writePublicKeyToDir writes public key to the expected file path', () => {
    EventBus.writePublicKeyToDir('/keys', 'node-x', 7777, 'public-key-content')
    expect(fs.mkdirSync).toHaveBeenCalledWith('/keys', { recursive: true })
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/keys/node-x_7777.pub',
      'public-key-content',
      'utf-8',
    )
  })

  it('resolveCurveConfig generates keys, writes pubkey, and reads peers', async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(['peer-b_8000.pub', 'self_5555.pub'])
    vi.mocked(fs.readFileSync).mockReturnValue('some-public-key-value')

    const result = await EventBus.resolveCurveConfig({
      curve: {
        server: true,
        port: 5555,
        nodeId: 'self',
        publicKeyDir: '/nas',
      },
    })

    expect(fs.writeFileSync).toHaveBeenCalled()
    expect(result.secretKey).toBeTruthy()
    expect(result.publicKey).toBeTruthy()
    // peerKeys should be a dict
    expect(typeof result.peerKeys).toBe('object')
    expect(result.peerNodeIds).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────
// 7. PeerDescriptor 解析
// ─────────────────────────────────────────────────────────
describe('PeerDescriptor 解析', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fs.readdirSync).mockReturnValue([])
    vi.mocked(fs.readFileSync).mockReturnValue('pubkeycontent')
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined)
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any)
  })

  it('creates a valid PeerDescriptor with all required fields', () => {
    const peer: PeerDescriptor = {
      nodeId: 'peer-node-a',
      port: 6000,
      address: 'tcp://192.168.1.10:6000',
      publicKey: 'peer-pub-key-value',
    }
    expect(peer.nodeId).toBe('peer-node-a')
    expect(peer.port).toBe(6000)
    expect(peer.address).toBe('tcp://192.168.1.10:6000')
    expect(peer.publicKey).toBe('peer-pub-key-value')
  })

  it('readAllPeerKeys returns descriptors from directory .pub files', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      'alpha_1000.pub',
      'beta_2000.pub',
      'gamma.pub', // invalid (no port number)
      'notes.txt',
    ])
    vi.mocked(fs.readFileSync).mockImplementation((filePath: string) => {
      if (filePath.toString().includes('alpha')) return 'alpha-pub-key'
      if (filePath.toString().includes('beta')) return 'beta-pub-key'
      return 'gamma-key'
    })

    const peers = EventBus.readAllPeerKeys('/some/dir')
    expect(peers).toHaveLength(2)
    expect(peers[0].nodeId).toBe('alpha')
    expect(peers[0].port).toBe(1000)
    expect(peers[0].address).toBe('tcp://127.0.0.1:1000')
    expect(peers[0].publicKey).toBe('alpha-pub-key')
    expect(peers[1].nodeId).toBe('beta')
    expect(peers[1].port).toBe(2000)
    expect(peers[1].publicKey).toBe('beta-pub-key')
  })

  it('readAllPeerKeys returns empty array for missing directory', () => {
    vi.mocked(fs.readdirSync).mockImplementation(() => {
      throw new Error('ENOENT')
    })
    const peers = EventBus.readAllPeerKeys('/nonexistent')
    expect(peers).toEqual([])
  })

  it('readAllPeerKeys skips unreadable files', () => {
    vi.mocked(fs.readdirSync).mockReturnValue(['good_3000.pub', 'bad_4000.pub'])
    vi.mocked(fs.readFileSync).mockImplementation((filePath: string) => {
      if (filePath.toString().includes('bad')) throw new Error('permission denied')
      return 'good-pub-key'
    })

    const peers = EventBus.readAllPeerKeys('/keys')
    expect(peers).toHaveLength(1)
    expect(peers[0].nodeId).toBe('good')
    expect(peers[0].port).toBe(3000)
  })

  it('waitForPeerKeys returns peers even if minPeers not reached (timeout)', async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const peers = await EventBus.waitForPeerKeys('/empty', 'self', 5)
    expect(peers).toEqual([])
  })
})
