// ============================================================
// EncryptionAtRest — Integration tests with OverGraphStorage
// and GraphEngine
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

import { OverGraphStorage } from './overgraph-storage'
import { EncryptionAtRest } from './cipher'
import { GraphEngine } from './graph-engine'

const TEST_DIR = path.join(os.tmpdir(), 'agentiX-encryption-integration-test-' + Date.now())

describe('EncryptionAtRest — OverGraphStorage integration', () => {
  let cipher: EncryptionAtRest

  beforeAll(async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true })
    cipher = new EncryptionAtRest({ algorithm: 'xchacha20-poly1305' })
    await cipher.ready()
  })

  afterAll(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('should export and import encrypted snapshot', () => {
    const storage = new OverGraphStorage(cipher)
    storage.open({ path: path.join(TEST_DIR, 'encrypted-storage') })

    // Add some data
    const node1 = storage.upsertNode(1, 'Alice', { props: { age: 30 } })
    const node2 = storage.upsertNode(2, 'Bob', { props: { age: 25 } })
    storage.upsertEdge(node1, node2, 5, { props: { weight: 1.0 } })

    // Export (should be encrypted)
    const snapshot = storage.exportSnapshot()

    // Verify encrypted flag prefix
    expect(snapshot.length).toBeGreaterThan(0)
    expect(snapshot[0]).toBe(0x01)

    // Verify it's encrypted (can't be decoded as msgpack directly)
    // Encrypted data starts with 24-byte nonce prefix, so first byte is not
    // from msgpack encoding
    expect(snapshot[1]).not.toBe(0x90) // msgpack array marker
    expect(snapshot[1]).not.toBe(0x80) // msgpack map marker

    // Re-import to a new storage
    const storage2 = new OverGraphStorage(cipher)
    storage2.open({ path: path.join(TEST_DIR, 'encrypted-storage2') })
    storage2.importSnapshot(snapshot)

    // Verify data roundtrip
    const node1copy = storage2.getNode(node1, true)
    expect(node1copy).not.toBeNull()
    expect(node1copy!.key).toBe('Alice')

    const node2copy = storage2.getNode(node2, true)
    expect(node2copy).not.toBeNull()
    expect(node2copy!.key).toBe('Bob')

    storage.close()
    storage2.close()
  })

  it('should fail to import encrypted snapshot without cipher configured', () => {
    const encryptedSnapshot = Buffer.alloc(100)
    encryptedSnapshot[0] = 0x01 // encrypted flag

    const storage = new OverGraphStorage() // no cipher!
    storage.open({ path: path.join(TEST_DIR, 'no-cipher-import') })

    expect(() => storage.importSnapshot(encryptedSnapshot)).toThrow(
      /encrypted.*not configured/i
    )
    storage.close()
  })

  it('should export unencrypted snapshot when cipher is not configured', () => {
    const storage = new OverGraphStorage() // no cipher
    storage.open({ path: path.join(TEST_DIR, 'unencrypted-storage') })

    const n1 = storage.upsertNode(1, 'NoEncrypt')
    const snapshot = storage.exportSnapshot()

    // No encryption flag — first byte should NOT be 0x01
    expect(snapshot[0]).not.toBe(0x01)
    // It should be decodable as msgpack (encrypted data would fail)
    const { decode } = require('msgpackr')
    expect(() => decode(Buffer.from(snapshot))).not.toThrow()

    storage.close()
  })
})

describe('EncryptionAtRest — GraphEngine integration', () => {
  it('should initialize GraphEngine with encryption config', async () => {
    const engine = new GraphEngine(
      {
        path: path.join(TEST_DIR, 'engine-encrypted'),
        overgraph: { compactAfterNFlushes: 0 },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { algorithm: 'xchacha20-poly1305' }
    )

    // Initialize the cipher
    const cipher = (engine['storage'] as any)._cipher as EncryptionAtRest
    expect(cipher).not.toBeNull()
    await cipher.ready()

    engine.open()
    engine.close()
  })

  it('should store and retrieve encrypted data via GraphEngine', async () => {
    const cipherConfig = { algorithm: 'xchacha20-poly1305' }
    const engine = new GraphEngine(
      {
        path: path.join(TEST_DIR, 'engine-encrypted-ops'),
        overgraph: { compactAfterNFlushes: 0 },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      cipherConfig
    )

    // Init cipher
    const cipher = (engine['storage'] as any)._cipher as EncryptionAtRest
    await cipher.ready()
    engine.open()

    // Create some data
    engine.upsertNode(1, 'EncryptedNode', { props: { secret: 'sensitive-data-123' } })

    // Verify data roundtrip via storage layer
    const storage = engine['storage'] as OverGraphStorage
    // Get the node ID from the engine's in-memory set
    const nodeIds = engine['_nodeIds'] as Set<number>
    expect(nodeIds.size).toBeGreaterThanOrEqual(1)

    const id = nodeIds.values().next().value as number
    const retrieved = storage.getNode(id, true)
    expect(retrieved).not.toBeNull()
    expect(retrieved!.key).toBe('EncryptedNode')
    if (retrieved && retrieved.props) {
      expect(retrieved.props.secret).toBe('sensitive-data-123')
    }

    engine.close()

    // Re-open and verify data persists
    const engine2 = new GraphEngine(
      {
        path: path.join(TEST_DIR, 'engine-encrypted-ops'),
        overgraph: { compactAfterNFlushes: 0 },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      cipherConfig
    )
    const cipher2 = (engine2['storage'] as any)._cipher as EncryptionAtRest
    await cipher2.ready()
    engine2.open()

    // Verify at the storage level that data persists
    const storage2 = engine2['storage'] as OverGraphStorage
    const nodeFromStorage = storage2.getNode(id, true)
    expect(nodeFromStorage).not.toBeNull()
    expect(nodeFromStorage!.key).toBe('EncryptedNode')
    if (nodeFromStorage && nodeFromStorage.props) {
      expect(nodeFromStorage.props.secret).toBe('sensitive-data-123')
    }

    engine2.close()
  })
})
