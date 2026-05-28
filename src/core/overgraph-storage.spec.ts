// ============================================================
// OverGraphStorage — 流式分块快照测试
// ============================================================

import { OverGraphStorage } from './overgraph-storage'
import { cleanTestData } from '../../test/fixtures/test-graph'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'

const TEST_DIR = './test-data/og-snapshot-test'
const SNAP_FILE = path.join(TEST_DIR, 'snapshot-test.snap')

describe('OverGraphStorage — 分块快照', () => {
  let storage: OverGraphStorage

  beforeAll(() => {
    cleanTestData(TEST_DIR)
  })

  afterAll(() => {
    cleanTestData(TEST_DIR)
  })

  beforeEach(() => {
    cleanTestData(TEST_DIR + '/graph1')
    cleanTestData(TEST_DIR + '/graph2')
    try { fs.unlinkSync(SNAP_FILE) } catch { /* ok */ }
    try { fs.unlinkSync(SNAP_FILE.replace('.snap', '.tmp')) } catch { /* ok */ }

    storage = new OverGraphStorage()
    storage.open({ path: TEST_DIR + '/graph1' })
  })

  afterEach(() => {
    storage.close()
  })

  // ── 基本分块导出与导入 ──────────────────────

  test('P0-4.1: exportSnapshotChunked produces valid chunks with headers', async () => {
    // 插入少量节点
    storage.upsertNode(1, 'alice', { props: { name: 'Alice' } })
    storage.upsertNode(2, 'bob', { props: { name: 'Bob' } })
    storage.upsertNode(3, 'charlie', { props: { name: 'Charlie' } })
    storage.upsertEdge(1, 2, 10, { props: { type: 'knows' } })

    const chunks: Buffer[] = []
    for await (const chunk of storage.exportSnapshotChunked(1024)) {
      chunks.push(chunk)
    }

    // 至少有一个数据块和一个最终校验块
    expect(chunks.length).toBeGreaterThanOrEqual(2)

    // 验证所有块有正确魔法标记
    const magic = Buffer.from([0x47, 0x53, 0x4E, 0x50]) // "GSNP"
    for (const c of chunks) {
      expect(c.subarray(0, 4)).toEqual(magic)
    }

    // 最后一块应该是最终校验块
    const last = chunks[chunks.length - 1]
    const isFinal = (last[4] & 0x01) === 0
    expect(isFinal).toBe(true)
    // 最终校验块的 totalChunks 应为 0xFFFFFFFF
    expect(last.readUInt32LE(9)).toBe(0xFFFFFFFF)
  })

  test('P0-4.2: chunked export → import → graph matches original', async () => {
    // 插入数据
    storage.upsertNode(1, 'node-a', { props: { val: 100 } })
    storage.upsertNode(2, 'node-b', { props: { val: 200 } })
    storage.upsertEdge(1, 2, 5, { props: { rel: 'linked' }, weight: 1.0 })

    // 导出到文件
    await storage.exportSnapshotAtomic(SNAP_FILE)
    expect(fs.existsSync(SNAP_FILE)).toBe(true)
    expect(fs.existsSync(SNAP_FILE.replace('.snap', '.tmp'))).toBe(false)

    // 读取快照属性
    const nodeA = storage.getNode(1, true)
    expect(nodeA).not.toBeNull()

    // 新建 storage 导入
    const storage2 = new OverGraphStorage()
    storage2.open({ path: TEST_DIR + '/graph2' })

    // 写入一些垃圾数据确认导入覆盖
    storage2.upsertNode(99, 'junk')

    await storage2.importSnapshotFile(SNAP_FILE)

    // 验证数据一致
    const nA = storage2.getNode(1, true)
    expect(nA).not.toBeNull()
    if (nA) {
      expect(nA.key).toBe('node-a')
      if (nA.props) expect(nA.props.val).toBe(100)
    }

    const nB = storage2.getNode(2, true)
    expect(nB).not.toBeNull()
    if (nB) {
      expect(nB.key).toBe('node-b')
      if (nB.props) expect(nB.props.val).toBe(200)
    }

    // 验证边
    const edge = storage2.getEdge(1, 2, 5)
    expect(edge).not.toBeNull()
    if (edge && edge.props) {
      expect(edge.props.rel).toBe('linked')
    }

    // junk 节点应被覆盖
    const junk = storage2.getNode(99, false)
    expect(junk).toBeNull()

    storage2.close()
  })

  test('P0-4.3: 100K+ node graph → chunked export works without OOM', async () => {
    // 大批量写入
    const N = 100_000
    const batchSize = 1000
    for (let batch = 0; batch < N / batchSize; batch++) {
      const inputs: Array<{
        typeId: number
        name: string
        key: string
        props?: Record<string, unknown>
      }> = []
      for (let i = 0; i < batchSize; i++) {
        const idx = batch * batchSize + i
        inputs.push({
          typeId: 1,
          name: `big-node-${idx}`,
          key: `big-node-${idx}`,
          props: { index: idx, data: `value-${idx % 1000}` },
        })
      }
      storage.batchUpsertNodes(inputs)
    }

    // 添加边
    for (let i = 0; i < N - 1; i++) {
      storage.upsertEdge(i + 1, i + 2, 10, { weight: 0.5 })
    }

    // 导出，使用小 chunk size 测试
    let chunkCount = 0
    let totalBytes = 0
    for await (const chunk of storage.exportSnapshotChunked(64 * 1024)) {
      // 每个 chunk 应 ≤ CHUNK_HEADER_SIZE + 64KB
      expect(chunk.length).toBeLessThanOrEqual(49 + 64 * 1024)
      chunkCount++
      totalBytes += chunk.length
    }

    // 应该有多个块
    expect(chunkCount).toBeGreaterThanOrEqual(2)
    expect(totalBytes).toBeGreaterThan(0)

    // 验证文件原子写入
    await storage.exportSnapshotAtomic(SNAP_FILE)
    expect(fs.existsSync(SNAP_FILE)).toBe(true)
    const fileSize = fs.statSync(SNAP_FILE).size
    expect(fileSize).toBe(totalBytes)
  }, 120_000)

  test('P0-4.4: corrupted chunk → import throws with clear error', async () => {
    const chunks: Buffer[] = []
    for await (const chunk of storage.exportSnapshotChunked(1024)) {
      chunks.push(chunk)
    }

    // 篡改第一个数据块的 payload
    const corrupted = Buffer.from(chunks[1] || chunks[0])
    if (corrupted[49] !== undefined) {
      corrupted[49] = ~corrupted[49] & 0xFF // 翻转一个字节
    }

    // 替换第一块（第一个如果是数据块）
    const tampered = [chunks[0], corrupted, ...chunks.slice(2)]

    await expect(
      storage.importSnapshotStream(tampered[Symbol.asyncIterator]())
    ).rejects.toThrow(/checksum mismatch/)
  })

  test('P0-4.5: missing final checksum chunk → import fails', async () => {
    const chunks: Buffer[] = []
    for await (const chunk of storage.exportSnapshotChunked(1024)) {
      chunks.push(chunk)
    }

    // 去掉最后一块（最终校验块）
    const withoutFinal = chunks.slice(0, -1)

    await expect(
      storage.importSnapshotStream(withoutFinal[Symbol.asyncIterator]())
    ).rejects.toThrow(/missing final checksum/)
  })

  test('P0-4.6: corrupted final checksum → full-data verification fails', async () => {
    const chunks: Buffer[] = []
    for await (const chunk of storage.exportSnapshotChunked(1024)) {
      chunks.push(chunk)
    }

    // 篡改最终校验块的 SHA-256 值
    const last = chunks[chunks.length - 1]
    const tamperedLast = Buffer.from(last)
    // 修改 SHA-256 的一部分（偏移 17~48）
    tamperedLast[17] = ~tamperedLast[17] & 0xFF
    chunks[chunks.length - 1] = tamperedLast

    await expect(
      storage.importSnapshotStream(chunks[Symbol.asyncIterator]())
    ).rejects.toThrow(/checksum mismatch/)
  })

  test('P0-4.7: invalid magic marker → parse throws', async () => {
    const badBuf = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    await expect(
      storage.importSnapshotStream(async function*() { yield badBuf }())
    ).rejects.toThrow(/Invalid snapshot chunk magic/)
  })

  test('P0-4.8: chunk count mismatch → import fails', async () => {
    const chunks: Buffer[] = []
    for await (const chunk of storage.exportSnapshotChunked(1024)) {
      chunks.push(chunk)
    }

    // 丢掉中间一个数据块（破坏 count）
    const dataChunks = chunks.filter(c => (c[4] & 0x01) !== 0)
    if (dataChunks.length >= 3) {
      const reordered = [
        chunks[0],   // keep first data
        // skip one chunk
        ...chunks.filter((_, i) => i > 1 && i < chunks.length - 1), // remaining data + final
      ]
      await expect(
        storage.importSnapshotStream(reordered[Symbol.asyncIterator]())
      ).rejects.toThrow(/count mismatch/)
    }
  })

  test('P0-4.9: temp file on mid-export crash → no .snap file left', async () => {
    const snapPath = path.join(TEST_DIR, 'snapshot-crash.snap')
    const tmpPath = snapPath.replace('.snap', '.tmp')

    // 模拟写入 tmp 文件后未 rename
    await fsp.writeFile(tmpPath, 'garbage data')

    // .snap 不应存在
    expect(fs.existsSync(snapPath)).toBe(false)

    // 但 .tmp 存在
    expect(fs.existsSync(tmpPath)).toBe(true)

    // 正常 export 会覆盖
    await storage.exportSnapshotAtomic(snapPath)
    expect(fs.existsSync(snapPath)).toBe(true)
    expect(fs.existsSync(tmpPath)).toBe(false)
  })

  test('P0-4.10: import into empty storage, data matches', async () => {
    // 先在 graph1 建数据
    const ids: number[] = []
    for (let i = 0; i < 50; i++) {
      ids.push(storage.upsertNode(1, `import-test-${i}`, { props: { idx: i } }))
    }
    // 建边
    for (let i = 0; i < 49; i++) {
      storage.upsertEdge(ids[i], ids[i + 1], 10)
    }

    await storage.exportSnapshotAtomic(SNAP_FILE)

    // 新建空存储导入
    const storage3 = new OverGraphStorage()
    storage3.open({ path: TEST_DIR + '/graph2' })

    await storage3.importSnapshotFile(SNAP_FILE)

    // 验证
    for (let i = 0; i < 50; i++) {
      const node = storage3.getNode(ids[i], true)
      expect(node).not.toBeNull()
      if (node) {
        expect(node.key).toBe(`import-test-${i}`)
      }
    }

    storage3.close()
  })
})
