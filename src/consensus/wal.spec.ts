/**
 * wal.spec.ts — WAL 日志持久化测试
 *
 * 覆盖 CRC32 校验、append / truncate / open / close / destroy 等操作
 */
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { WAL } from './wal'

function tempWalPath(): string {
  const dir = path.join(os.tmpdir(), 'wal-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'test.wal')
}

describe('WAL', () => {
  let walPath: string

  beforeEach(() => {
    walPath = tempWalPath()
  })

  afterEach(async () => {
    try {
      const wal = new WAL(walPath)
      await wal.destroy()
    } catch {
      // ignore cleanup errors
    }
  })

  describe('open and close', () => {
    test('should open a new WAL file', async () => {
      const wal = new WAL(walPath)
      expect(wal.isOpen).toBe(false)
      await wal.open()
      expect(wal.isOpen).toBe(true)
      expect(fs.existsSync(walPath)).toBe(true)
    })

    test('should close WAL file', async () => {
      const wal = new WAL(walPath)
      await wal.open()
      await wal.close()
      expect(wal.isOpen).toBe(false)
    })

    test('should open existing WAL file with entries', async () => {
      const wal1 = new WAL(walPath)
      await wal1.open()
      await wal1.append(1, new Uint8Array([1, 2, 3]))
      await wal1.append(1, new Uint8Array([4, 5]))
      await wal1.close()

      const wal2 = new WAL(walPath)
      await wal2.open()
      expect(wal2.entriesCount()).toBe(2)
      const entries = wal2.readAll()
      expect(entries[0].index).toBe(1)
      expect(entries[1].index).toBe(2)
    })
  })

  describe('append and read', () => {
    test('should append entries with sequential indices', async () => {
      const wal = new WAL(walPath)
      await wal.open()

      const entry1 = await wal.append(1, new Uint8Array([10]))
      expect(entry1.index).toBe(1)
      expect(entry1.term).toBe(1)

      const entry2 = await wal.append(2, new Uint8Array([20, 30]))
      expect(entry2.index).toBe(2)

      const all = wal.readAll()
      expect(all).toHaveLength(2)
    })

    test('should persist entries to disk', async () => {
      const wal1 = new WAL(walPath)
      await wal1.open()
      await wal1.append(1, new Uint8Array([1, 2, 3]))
      await wal1.close()

      const wal2 = new WAL(walPath)
      await wal2.open()
      const entries = wal2.readAll()
      expect(entries).toHaveLength(1)
      expect(entries[0].data).toEqual(new Uint8Array([1, 2, 3]))
    })

    test('should throw if appending to closed WAL', async () => {
      const wal = new WAL(walPath)
      await wal.open()
      await wal.close()
      await expect(wal.append(1, new Uint8Array([1]))).rejects.toThrow()
    })
  })

  describe('truncation', () => {
    test('should truncate all entries after given index', async () => {
      const wal = new WAL(walPath)
      await wal.open()
      await wal.append(1, new Uint8Array([1]))
      await wal.append(2, new Uint8Array([2]))
      await wal.append(3, new Uint8Array([3]))

      await wal.truncate(1)
      expect(wal.entriesCount()).toBe(1) // keep entries from index 2
    })

    test('truncate should be no-op when index >= entries count', async () => {
      const wal = new WAL(walPath)
      await wal.open()
      await wal.append(1, new Uint8Array([1]))
      await wal.truncate(5)
      expect(wal.entriesCount()).toBe(1)
    })

    test('truncate should persist on disk', async () => {
      const wal1 = new WAL(walPath)
      await wal1.open()
      await wal1.append(1, new Uint8Array([1]))
      await wal1.append(2, new Uint8Array([2]))
      await wal1.append(3, new Uint8Array([3]))
      await wal1.truncate(1)  // 保留从数组索引2开始: entries[index=3]
      await wal1.close()

      const wal2 = new WAL(walPath)
      await wal2.open()
      expect(wal2.entriesCount()).toBe(1)
      expect(wal2.getLastIndex()).toBe(3)
    })
  })

  describe('truncateBefore', () => {
    test('should truncate entries before given index', async () => {
      const wal = new WAL(walPath)
      await wal.open()
      await wal.append(1, new Uint8Array([1]))
      await wal.append(2, new Uint8Array([2]))
      await wal.append(3, new Uint8Array([3]))

      await wal.truncateBefore(2)
      expect(wal.entriesCount()).toBe(2) // entries with index 2, 3
    })

    test('truncateBefore should persist on disk', async () => {
      const wal1 = new WAL(walPath)
      await wal1.open()
      await wal1.append(1, new Uint8Array([1]))
      await wal1.append(2, new Uint8Array([2]))
      await wal1.truncateBefore(2)
      await wal1.close()

      const wal2 = new WAL(walPath)
      await wal2.open()
      expect(wal2.entriesCount()).toBe(1)
      expect(wal2.getLastIndex()).toBe(2)
    })
  })

  describe('getEntry and getEntriesFrom', () => {
    test('should retrieve entry by index', async () => {
      const wal = new WAL(walPath)
      await wal.open()
      await wal.append(1, new Uint8Array([10]))
      await wal.append(2, new Uint8Array([20]))

      const e1 = wal.getEntry(1)
      expect(e1).toBeDefined()
      expect(e1!.term).toBe(1)
      expect(e1!.data).toEqual(new Uint8Array([10]))

      expect(wal.getEntry(99)).toBeUndefined()
    })

    test('should retrieve entries starting from given index', async () => {
      const wal = new WAL(walPath)
      await wal.open()
      await wal.append(1, new Uint8Array([1]))
      await wal.append(2, new Uint8Array([2]))
      await wal.append(3, new Uint8Array([3]))

      const from2 = wal.getEntriesFrom(2)
      expect(from2).toHaveLength(2)
      expect(from2[0].index).toBe(2)
      expect(from2[1].index).toBe(3)
    })
  })

  describe('meta persistence', () => {
    test('should persist and load meta key-value', async () => {
      const wal = new WAL(walPath)
      await wal.open()
      wal.persistMeta('currentTerm', '5')
      wal.persistMeta('votedFor', 'node-42')

      expect(wal.loadMeta('currentTerm')).toBe('5')
      expect(wal.loadMeta('votedFor')).toBe('node-42')
    })

    test('should return undefined for non-existent meta key', async () => {
      const wal = new WAL(walPath)
      await wal.open()
      expect(wal.loadMeta('nonexistent')).toBeUndefined()
    })

    test('should update existing meta key', async () => {
      const wal = new WAL(walPath)
      await wal.open()
      wal.persistMeta('currentTerm', '3')
      wal.persistMeta('currentTerm', '7')
      expect(wal.loadMeta('currentTerm')).toBe('7')
    })

    test('should persist meta across wal close/open', async () => {
      const wal1 = new WAL(walPath)
      await wal1.open()
      wal1.persistMeta('key1', 'val1')
      await wal1.close()

      const wal2 = new WAL(walPath)
      await wal2.open()
      expect(wal2.loadMeta('key1')).toBe('val1')
    })
  })

  describe('CRC32 checksum (P2-W-04)', () => {
    test('should verify CRC on readback after append', async () => {
      const wal1 = new WAL(walPath)
      await wal1.open()
      await wal1.append(1, new Uint8Array([1, 2, 3]))
      await wal1.close()

      const wal2 = new WAL(walPath)
      await wal2.open()
      expect(wal2.entriesCount()).toBe(1)
      expect(wal2.crcErrors).toBe(0)
    })

    test('should detect corrupted data via CRC', async () => {
      const wal = new WAL(walPath)
      await wal.open()
      await wal.append(1, new Uint8Array([1, 2, 3]))
      await wal.close()

      // 手动破坏文件内容（翻转 data 段的一个字节）
      const buf = fs.readFileSync(walPath)
      // data 在 header 12 bytes 之后
      const corruptedIdx = 14 // 在 data 段内
      buf[corruptedIdx] = ~buf[corruptedIdx] & 0xFF
      fs.writeFileSync(walPath, buf)

      const wal2 = new WAL(walPath)
      await wal2.open()
      // CRC 校验失败，条目被跳过
      expect(wal2.crcErrors).toBeGreaterThan(0)
      expect(wal2.entriesCount()).toBe(0)
    })

    test('should detect corrupted header via CRC', async () => {
      const wal = new WAL(walPath)
      await wal.open()
      await wal.append(1, new Uint8Array([10, 20]))
      await wal.close()

      // 破坏 header 中的 term 字段
      const buf = fs.readFileSync(walPath)
      buf[5] = buf[5] ^ 0xFF // 翻转 term 的第 5 字节
      fs.writeFileSync(walPath, buf)

      const wal2 = new WAL(walPath)
      await wal2.open()
      expect(wal2.crcErrors).toBeGreaterThan(0)
    })

    test('should maintain CRC integrity across multiple entries', async () => {
      const wal1 = new WAL(walPath)
      await wal1.open()
      await wal1.append(1, new Uint8Array([1, 2, 3]))
      await wal1.append(2, new Uint8Array([4, 5, 6, 7]))
      await wal1.append(3, new Uint8Array([8]))
      await wal1.close()

      const wal2 = new WAL(walPath)
      await wal2.open()
      expect(wal2.entriesCount()).toBe(3)
      expect(wal2.crcErrors).toBe(0)
      expect(wal2.getLastIndex()).toBe(3)
    })

    test('should skip only corrupted entry and continue reading', async () => {
      const wal1 = new WAL(walPath)
      await wal1.open()
      await wal1.append(1, new Uint8Array([1])) // good
      await wal1.append(2, new Uint8Array([2])) // will be corrupted
      await wal1.append(3, new Uint8Array([3])) // good
      await wal1.close()

      // 破坏第二个条目的 data
      const buf = fs.readFileSync(walPath)
      // 第二个条目从第一个条目末尾开始
      // 每个条目: header(12) + data(n) + crc(4)
      const entry1Size = 12 + 1 + 4 // 17
      buf[entry1Size + 13] = buf[entry1Size + 13] ^ 0xFF // 破坏 data 字节
      fs.writeFileSync(walPath, buf)

      const wal2 = new WAL(walPath)
      await wal2.open()
      expect(wal2.crcErrors).toBe(1) // 1 CRC error
      // 应该保留 2 个好条目（1 和 3）
      expect(wal2.entriesCount()).toBe(2)
      const entries = wal2.readAll()
      expect(entries.some(e => e.index === 1)).toBe(true)
      expect(entries.some(e => e.index === 3)).toBe(true)
    })
  })

  describe('sync', () => {
    test('sync should not throw', async () => {
      const wal = new WAL(walPath)
      await wal.open()
      await wal.append(1, new Uint8Array([1]))
      await expect(wal.sync()).resolves.not.toThrow()
    })
  })

  describe('destroy', () => {
    test('should delete WAL and meta files', async () => {
      const wal = new WAL(walPath)
      await wal.open()
      await wal.append(1, new Uint8Array([1]))
      wal.persistMeta('test', 'val')
      await wal.destroy()

      expect(fs.existsSync(walPath)).toBe(false)
      expect(wal.entriesCount()).toBe(0)
    })
  })
})
