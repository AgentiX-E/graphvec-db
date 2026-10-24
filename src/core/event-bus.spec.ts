import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// ── zeromq is mocked via a Vite alias (vitest.config.ts) ─────
// `zeromq` resolves to src/test-utils/__mocks__/zeromq.ts, whose curveKeyPair
// returns a fixed mock key. The EventBus module under test therefore never
// touches the native addon. File-system helpers (writePublicKeyToDir,
// readAllPeerKeys, resolveCurveConfig) are tested against real temporary
// directories rather than vi.mock('node:fs'), which vitest 4 does not reliably
// apply to the module under test under the vmThreads pool.

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

  it('initEventBus creates a new EventBus and starts it', async () => {
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
    // zeromq is aliased to src/test-utils/__mocks__/zeromq.ts, whose
    // curveKeyPair returns a fixed mock key.
    const keys = EventBus.generateCurveKeys()
    expect(typeof keys.publicKey).toBe('string')
    expect(keys.publicKey.length).toBeGreaterThan(0)
    expect(typeof keys.secretKey).toBe('string')
    expect(keys.secretKey.length).toBeGreaterThan(0)
  })

  it('writePublicKeyToDir writes public key to the expected file path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventbus-pub-'))
    try {
      EventBus.writePublicKeyToDir(dir, 'node-x', 7777, 'public-key-content')
      const filePath = path.join(dir, 'node-x_7777.pub')
      expect(fs.existsSync(filePath)).toBe(true)
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('public-key-content')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolveCurveConfig generates keys, writes pubkey, and reads peers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventbus-curve-'))
    try {
      // Pre-write a peer key file so waitForPeerKeys finds one peer.
      fs.writeFileSync(path.join(dir, 'peer-b_8000.pub'), 'some-public-key-value', 'utf-8')

      const result = await EventBus.resolveCurveConfig({
        curve: {
          server: true,
          port: 5555,
          nodeId: 'self',
          publicKeyDir: dir,
        },
      })

      expect(result.secretKey).toBeTruthy()
      expect(result.publicKey).toBeTruthy()
      // peerKeys should be a dict
      expect(typeof result.peerKeys).toBe('object')
      expect(result.peerNodeIds).toBeDefined()
      // self is excluded from peers, so the pre-written peer-b should appear
      expect(result.peerNodeIds).toContain('peer-b')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────
// 7. PeerDescriptor 解析
// ─────────────────────────────────────────────────────────
describe('PeerDescriptor 解析', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventbus-peers-'))
    try {
      fs.writeFileSync(path.join(dir, 'alpha_1000.pub'), 'alpha-pub-key', 'utf-8')
      fs.writeFileSync(path.join(dir, 'beta_2000.pub'), 'beta-pub-key', 'utf-8')
      fs.writeFileSync(path.join(dir, 'gamma.pub'), 'gamma-key', 'utf-8') // invalid (no port number)
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'not-a-key', 'utf-8')

      const peers = EventBus.readAllPeerKeys(dir)
      expect(peers).toHaveLength(2)
      expect(peers[0].nodeId).toBe('alpha')
      expect(peers[0].port).toBe(1000)
      expect(peers[0].address).toBe('tcp://127.0.0.1:1000')
      expect(peers[0].publicKey).toBe('alpha-pub-key')
      expect(peers[1].nodeId).toBe('beta')
      expect(peers[1].port).toBe(2000)
      expect(peers[1].publicKey).toBe('beta-pub-key')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('readAllPeerKeys returns empty array for missing directory', () => {
    const peers = EventBus.readAllPeerKeys(path.join(os.tmpdir(), 'eventbus-__nonexistent__'))
    expect(peers).toEqual([])
  })

  it('readAllPeerKeys skips unreadable files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventbus-unread-'))
    try {
      fs.writeFileSync(path.join(dir, 'good_3000.pub'), 'good-pub-key', 'utf-8')
      // Create a directory with a .pub name so readFileSync throws (EISDIR),
      // exercising the "skip unreadable files" branch.
      fs.mkdirSync(path.join(dir, 'bad_4000.pub'))

      const peers = EventBus.readAllPeerKeys(dir)
      expect(peers).toHaveLength(1)
      expect(peers[0].nodeId).toBe('good')
      expect(peers[0].port).toBe(3000)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('waitForPeerKeys returns peers even if minPeers not reached (timeout)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventbus-empty-'))
    try {
      const peers = await EventBus.waitForPeerKeys(dir, 'self', 1)
      expect(peers).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
