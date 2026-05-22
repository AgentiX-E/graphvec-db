/**
 * wal.spec.ts — WAL 持久化测试
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { WAL } from './wal'

describe('WAL', () => {
  const testDir = path.join(os.tmpdir(), 'wal-test')
  let wal: WAL

  beforeEach(async () => {
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterEach(async () => {
    if (wal) {
      try { await wal.destroy() } catch { /* ignore */ }
    }
  })

  afterAll(() => {
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('should create and open a new WAL file', async () => {
    const walPath = path.join(testDir, 'test-0.wal')
    wal = new WAL(walPath)
    expect(wal.isOpen).toBe(false)

    await wal.open()
    expect(wal.isOpen).toBe(true)
    expect(wal.readAll()).toEqual([])
    expect(wal.getLastIndex()).toBe(0)
    expect(wal.getLastTerm()).toBe(0)
  })

  it('should append entries and read them back', async () => {
    const walPath = path.join(testDir, 'test-1.wal')
    wal = new WAL(walPath)
    await wal.open()

    const data1 = Buffer.from('entry-1')
    const entry1 = await wal.append(1, data1)
    expect(entry1.index).toBe(1)
    expect(entry1.term).toBe(1)
    expect(Buffer.from(entry1.data).toString()).toBe('entry-1')

    const data2 = Buffer.from('entry-2')
    const entry2 = await wal.append(2, data2)
    expect(entry2.index).toBe(2)
    expect(entry2.term).toBe(2)

    const all = wal.readAll()
    expect(all).toHaveLength(2)
    expect(all[0].index).toBe(1)
    expect(all[0].term).toBe(1)
    expect(Buffer.from(all[0].data).toString()).toBe('entry-1')
    expect(all[1].index).toBe(2)
    expect(all[1].term).toBe(2)
    expect(Buffer.from(all[1].data).toString()).toBe('entry-2')
  })

  it('should persist entries across open/close cycles', async () => {
    const walPath = path.join(testDir, 'test-2.wal')

    // First session
    const wal1 = new WAL(walPath)
    await wal1.open()
    await wal1.append(1, Buffer.from('persist-me'))
    await wal1.close()

    // Second session (simulate crash recovery)
    const wal2 = new WAL(walPath)
    await wal2.open()
    expect(wal2.readAll()).toHaveLength(1)
    expect(wal2.getLastIndex()).toBe(1)
    expect(wal2.getLastTerm()).toBe(1)
    expect(Buffer.from(wal2.readAll()[0].data).toString()).toBe('persist-me')
    await wal2.close()
  })

  it('should truncate entries after a given index', async () => {
    const walPath = path.join(testDir, 'test-3.wal')
    wal = new WAL(walPath)
    await wal.open()

    await wal.append(1, Buffer.from('a'))
    await wal.append(1, Buffer.from('b'))
    await wal.append(1, Buffer.from('c'))
    expect(wal.readAll()).toHaveLength(3)

    await wal.truncate(1) // slice(1+1=2) → keep entries[2] only
    expect(wal.readAll()).toHaveLength(1)
    // entries[2] has index 3
    expect(wal.readAll()[0].index).toBe(3)
    expect(wal.readAll()).toHaveLength(1)
  })

  it('should not truncate when lastIndex >= entry count', async () => {
    const walPath = path.join(testDir, 'test-4.wal')
    wal = new WAL(walPath)
    await wal.open()

    await wal.append(1, Buffer.from('a'))
    await wal.append(1, Buffer.from('b'))

    await wal.truncate(10) // lastIndex > entries.length → no-op
    expect(wal.readAll()).toHaveLength(2)
  })

  it('should recover entries after simulated crash', async () => {
    const walPath = path.join(testDir, 'test-crash.wal')

    // Write some entries
    const wal1 = new WAL(walPath)
    await wal1.open()
    await wal1.append(1, Buffer.from('tx1'))
    await wal1.append(2, Buffer.from('tx2'))
    await wal1.sync()
    await wal1.close()

    // Read back after "crash"
    const wal2 = new WAL(walPath)
    await wal2.open()
    const entries = wal2.readAll()
    expect(entries).toHaveLength(2)
    expect(Buffer.from(entries[0].data).toString()).toBe('tx1')
    expect(Buffer.from(entries[1].data).toString()).toBe('tx2')
    expect(wal2.getLastIndex()).toBe(2)
    expect(wal2.getLastTerm()).toBe(2)

    // Append more
    await wal2.append(3, Buffer.from('tx3'))
    await wal2.sync()
    await wal2.close()

    // Validate 3 entries
    const wal3 = new WAL(walPath)
    await wal3.open()
    expect(wal3.readAll()).toHaveLength(3)
    expect(wal3.getLastIndex()).toBe(3)
    await wal3.close()
  })

  it('should handle binary data', async () => {
    const walPath = path.join(testDir, 'test-binary.wal')
    wal = new WAL(walPath)
    await wal.open()

    const binaryData = Buffer.from([0x00, 0x01, 0xFF, 0xFE, 0x7F])
    await wal.append(1, binaryData)

    const entry = wal.readAll()[0]
    expect(Buffer.from(entry.data)).toEqual(binaryData)
  })

  it('should get entries from a starting index', async () => {
    const walPath = path.join(testDir, 'test-range.wal')
    wal = new WAL(walPath)
    await wal.open()

    await wal.append(1, Buffer.from('a'))
    await wal.append(2, Buffer.from('b'))
    await wal.append(3, Buffer.from('c'))

    const fromIndex2 = wal.getEntriesFrom(2)
    expect(fromIndex2).toHaveLength(2)
    expect(fromIndex2[0].index).toBe(2)
    expect(fromIndex2[1].index).toBe(3)
  })

  it('should return undefined for non-existent entry', async () => {
    const walPath = path.join(testDir, 'test-missing.wal')
    wal = new WAL(walPath)
    await wal.open()

    expect(wal.getEntry(99)).toBeUndefined()
  })
})
