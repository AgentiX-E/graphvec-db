// ============================================================
// document-store.spec.ts — DocumentStore / DocumentCollection 测试
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  DocumentStore,
  DocumentCollection,
  generateKey,
  type DocumentRecord,
  type DocumentMeta,
} from './document-store'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// ── Helpers ───────────────────────────────

/**
 * 创建临时测试目录
 */
function getTempDir(name: string): string {
  const dir = path.join(os.tmpdir(), `agentix-docstore-test-${name}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 清理测试目录
 */
function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors
  }
}

// ── Tests ─────────────────────────────────

describe('DocumentStore', () => {
  let testDir: string
  let store: DocumentStore

  beforeEach(() => {
    testDir = getTempDir('docstore')
    store = new DocumentStore({ path: testDir })
  })

  afterEach(async () => {
    await store.close()
    cleanupDir(testDir)
  })

  describe('constructor', () => {
    it('should create store with valid path', () => {
      expect(store.path).toBe(testDir)
    })

    it('should throw on invalid encryption key length', () => {
      expect(() => {
        new DocumentStore({
          path: getTempDir('badkey'),
          encryptionKey: 'not-32-bytes',
        })
      }).toThrow(/Encryption key must be 32 bytes/)
    })

    it('should accept valid 32-byte encryption key', () => {
      const key = 'a'.repeat(64) // 32 bytes in hex
      const secureStore = new DocumentStore({
        path: getTempDir('goodkey'),
        encryptionKey: key,
      })
      expect(secureStore.path).toBeTruthy()
      secureStore.close()
    })
  })

  describe('collection', () => {
    it('should create and return a collection', () => {
      const coll = store.collection('users')
      expect(coll).toBeInstanceOf(DocumentCollection)
      expect(coll.name).toBe('users')
    })

    it('should return the same collection for same name', () => {
      const coll1 = store.collection('test')
      const coll2 = store.collection('test')
      expect(coll1).toBe(coll2)
    })

    it('should throw on empty name', () => {
      expect(() => store.collection('')).toThrow(
        'Collection name must be a non-empty string',
      )
    })

    it('should support multiple collections', () => {
      const collA = store.collection('collA')
      const collB = store.collection('collB')
      expect(collA).not.toBe(collB)
      expect(store.listCollections()).toEqual(
        expect.arrayContaining(['collA', 'collB']),
      )
    })
  })

  describe('listCollections', () => {
    it('should return empty initially', () => {
      expect(store.listCollections()).toEqual([])
    })

    it('should list created collections', () => {
      store.collection('a')
      store.collection('b')
      store.collection('c')
      const list = store.listCollections()
      expect(list).toContain('a')
      expect(list).toContain('b')
      expect(list).toContain('c')
      expect(list.length).toBe(3)
    })
  })

  describe('dropCollection', () => {
    it('should drop an existing collection', async () => {
      store.collection('temp')
      expect(store.listCollections()).toContain('temp')
      const dropped = await store.dropCollection('temp')
      expect(dropped).toBe(true)
      expect(store.listCollections()).not.toContain('temp')
    })

    it('should return false for non-existent collection', async () => {
      const dropped = await store.dropCollection('nonexistent')
      expect(dropped).toBe(false)
    })
  })

  describe('close', () => {
    it('should close without error', async () => {
      store.collection('keep')
      await expect(store.close()).resolves.toBeUndefined()
    })
  })
})

describe('DocumentCollection', () => {
  let testDir: string
  let store: DocumentStore
  let coll: DocumentCollection

  beforeEach(() => {
    testDir = getTempDir('collection')
    store = new DocumentStore({ path: testDir })
    coll = store.collection('test-coll')
  })

  afterEach(async () => {
    await store.close()
    cleanupDir(testDir)
  })

  describe('save', () => {
    it('should save a document and return meta', async () => {
      const meta = await coll.save({ name: 'Alice', age: 30 })
      expect(meta).toHaveProperty('_key')
      expect(meta).toHaveProperty('_rev')
      expect(typeof meta._key).toBe('string')
      expect(typeof meta._rev).toBe('string')
      expect(meta._key.length).toBeGreaterThan(0)
      expect(meta._rev.length).toBeGreaterThan(0)
    })

    it('should use provided _key', async () => {
      const meta = await coll.save({ _key: 'custom-key', name: 'Bob' })
      expect(meta._key).toBe('custom-key')
    })

    it('should generate unique keys for each document', async () => {
      const m1 = await coll.save({ data: 1 })
      const m2 = await coll.save({ data: 2 })
      expect(m1._key).not.toBe(m2._key)
    })

    it('should compute _rev based on content', async () => {
      const m1 = await coll.save({ name: 'Charlie', age: 25 })
      const m2 = await coll.save({ name: 'Charlie', age: 30 })
      expect(m1._rev).not.toBe(m2._rev)
    })

    it('should throw on null body', async () => {
      await expect(coll.save(null as any)).rejects.toThrow(
        'Document body must be a non-null object',
      )
    })

    it('should throw on undefined body', async () => {
      await expect(coll.save(undefined as any)).rejects.toThrow(
        'Document body must be a non-null object',
      )
    })
  })

  describe('get', () => {
    it('should return saved document by key', async () => {
      const meta = await coll.save({ title: 'Doc 1', value: 42 })
      const doc = await coll.get(meta._key)
      expect(doc).not.toBeNull()
      expect(doc!._key).toBe(meta._key)
      expect(doc!._rev).toBe(meta._rev)
      expect(doc!.body).toEqual({ title: 'Doc 1', value: 42 })
    })

    it('should return null for non-existent key', async () => {
      const doc = await coll.get('nonexistent-key')
      expect(doc).toBeNull()
    })

    it('should throw on empty key', async () => {
      await expect(coll.get('')).rejects.toThrow('Document key is required')
    })
  })

  describe('delete', () => {
    it('should delete an existing document', async () => {
      const meta = await coll.save({ data: 'to-delete' })
      const deleted = await coll.delete(meta._key)
      expect(deleted).toBe(true)
      const doc = await coll.get(meta._key)
      expect(doc).toBeNull()
    })

    it('should return false for non-existent key', async () => {
      const deleted = await coll.delete('does-not-exist')
      expect(deleted).toBe(false)
    })

    it('should throw on empty key', async () => {
      await expect(coll.delete('')).rejects.toThrow('Document key is required')
    })
  })

  describe('query', () => {
    beforeEach(async () => {
      await coll.save({ name: 'Alice', age: 30, city: 'NYC' })
      await coll.save({ name: 'Bob', age: 25, city: 'SF' })
      await coll.save({ name: 'Charlie', age: 35, city: 'NYC' })
      await coll.save({ name: 'Diana', age: 28, city: 'LA' })
    })

    it('should return all documents with empty filter', async () => {
      const docs = await coll.query()
      expect(docs.length).toBe(4)
    })

    it('should filter by equality', async () => {
      const docs = await coll.query({ city: 'NYC' })
      expect(docs.length).toBe(2)
      expect(docs.every((d) => d.body.city === 'NYC')).toBe(true)
    })

    it('should filter with $gt operator', async () => {
      const docs = await coll.query({ age: { $gt: 28 } })
      expect(docs.length).toBe(2)
      expect(docs.map((d) => d.body.name)).toContain('Alice')
      expect(docs.map((d) => d.body.name)).toContain('Charlie')
    })

    it('should filter with $gte operator', async () => {
      const docs = await coll.query({ age: { $gte: 30 } })
      expect(docs.length).toBe(2)
    })

    it('should filter with $lt operator', async () => {
      const docs = await coll.query({ age: { $lt: 28 } })
      expect(docs.length).toBe(1)
      expect(docs[0].body.name).toBe('Bob')
    })

    it('should filter with $lte operator', async () => {
      const docs = await coll.query({ age: { $lte: 28 } })
      expect(docs.length).toBe(2)
    })

    it('should filter with $ne operator', async () => {
      const docs = await coll.query({ city: { $ne: 'NYC' } })
      expect(docs.length).toBe(2)
    })

    it('should filter with $in operator', async () => {
      const docs = await coll.query({ city: { $in: ['NYC', 'LA'] } })
      expect(docs.length).toBe(3)
    })

    it('should filter with $nin operator', async () => {
      const docs = await coll.query({ city: { $nin: ['NYC', 'SF'] } })
      expect(docs.length).toBe(1)
      expect(docs[0].body.name).toBe('Diana')
    })

    it('should filter with $exists operator', async () => {
      // 所有文档都有 age
      const docs = await coll.query({ age: { $exists: true } })
      expect(docs.length).toBe(4)

      // 没有文档有 nonExistentField
      const docsWithout = await coll.query({ nonExistentField: { $exists: false } })
      expect(docsWithout.length).toBe(4)
    })

    it('should sort results', async () => {
      const docs = await coll.query({}, { sort: { age: -1 } })
      expect(docs[0].body.name).toBe('Charlie') // 35
      expect(docs[3].body.name).toBe('Bob') // 25
    })

    it('should apply limit', async () => {
      const docs = await coll.query({}, { limit: 2 })
      expect(docs.length).toBe(2)
    })

    it('should apply offset', async () => {
      const allDocs = await coll.query({})
      const docs = await coll.query({}, { offset: 2 })
      expect(docs.length).toBe(2)
      expect(docs[0].body.name).toBe(allDocs[2].body.name)
    })

    it('should combine sort + limit + offset', async () => {
      const docs = await coll.query(
        {},
        { sort: { age: 1 }, offset: 1, limit: 2 },
      )
      expect(docs.length).toBe(2)
      // 排序后: Bob(25), Diana(28), Alice(30), Charlie(35)
      // offset 1, limit 2: Diana(28), Alice(30)
      expect(docs[0].body.name).toBe('Diana')
    })
  })

  describe('count', () => {
    it('should return 0 for empty collection', async () => {
      const coll2 = store.collection('empty')
      expect(await coll2.count()).toBe(0)
    })

    it('should return document count', async () => {
      await coll.save({ x: 1 })
      await coll.save({ x: 2 })
      expect(await coll.count()).toBe(2)
    })
  })

  describe('exists', () => {
    it('should return true for existing key', async () => {
      const meta = await coll.save({ test: true })
      expect(await coll.exists(meta._key)).toBe(true)
    })

    it('should return false for non-existing key', async () => {
      expect(await coll.exists('no-such-key')).toBe(false)
    })

    it('should return false for empty key', async () => {
      expect(await coll.exists('')).toBe(false)
    })
  })

  describe('clear', () => {
    it('should remove all documents', async () => {
      await coll.save({ a: 1 })
      await coll.save({ b: 2 })
      expect(await coll.count()).toBe(2)
      await coll.clear()
      expect(await coll.count()).toBe(0)
    })
  })

  describe('generateKey', () => {
    it('should generate UUID v4 strings', () => {
      const key = generateKey()
      expect(typeof key).toBe('string')
      expect(key.length).toBe(36) // UUID v4 format
      expect(key).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      )
    })
  })
})

describe('DocumentStore with encryption', () => {
  let testDir: string
  let store: DocumentStore

  beforeEach(() => {
    testDir = getTempDir('encrypted')
    const key = '0123456789abcdef0123456789abcdef' // 32 bytes
    store = new DocumentStore({ path: testDir, encryptionKey: key })
  })

  afterEach(async () => {
    await store.close()
    cleanupDir(testDir)
  })

  it('should save and retrieve documents with encrypted LMDB', async () => {
    const coll = store.collection('secrets')
    const meta = await coll.save({ secret: 'classified', level: 5 })
    const doc = await coll.get(meta._key)
    expect(doc).not.toBeNull()
    expect(doc!.body.secret).toBe('classified')
  })
})
