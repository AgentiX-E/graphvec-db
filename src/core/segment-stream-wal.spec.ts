/**
 * SegmentStreamWal 单元测试
 *
 * 覆盖：
 * - 基本 append/read/replay API
 * - Segment 滚动
 * - prune 只删不重写
 * - 旧文件迁移
 * - 进程崩溃后恢复（模拟）
 */

import { SegmentStreamWal, SegmentStreamWalAppendStream, SegmentStreamWalOptions, StreamMessage, FLAG_PENDING, FLAG_ACKED, FLAG_CONSUMED } from './segment-stream-wal'
import * as path from 'node:path'
import * as fs from 'node:fs'

const TEST_DIR = path.join('/tmp', `segment-stream-wal-test-${Date.now()}`)

function makeMsg(seq: number, overrides?: Partial<StreamMessage>): StreamMessage {
  return {
    msgId: `node-a-${seq}`,
    seq,
    nodeId: 'node-a',
    timestamp: Date.now(),
    type: 'node:created',
    data: { id: seq },
    ...overrides,
  }
}

function walDir(name: string): string {
  return path.join(TEST_DIR, name)
}

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true })
})

afterAll(() => {
  try { fs.rmSync(TEST_DIR, { recursive: true }) } catch { /* ignore */ }
})

// 帮助函数：读取目录中所有 log 文件的内容作为原始缓冲区列表
function readSegmentFiles(dir: string): Buffer[] {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.log')).sort()
  return files.map(f => fs.readFileSync(path.join(dir, f)))
}

describe('SegmentStreamWal — 基本 API', () => {
  let wal: SegmentStreamWal

  beforeEach(() => {
    wal = new SegmentStreamWal(walDir('basic'))
    wal.open()
  })

  afterEach(() => {
    wal.drop()
  })

  it('append 后 size 增加', () => {
    expect(wal.size).toBe(0)
    wal.append(makeMsg(1))
    expect(wal.size).toBe(1)
    wal.append(makeMsg(2))
    expect(wal.size).toBe(2)
  })

  it('readPending 返回超时的 PENDING 消息', () => {
    const past = Date.now() - 10000
    wal.append(makeMsg(1, { timestamp: past }))
    wal.append(makeMsg(2, { timestamp: Date.now() + 10000 }))

    const pending = wal.readPending(Date.now())
    expect(pending.length).toBe(1)
    expect(pending[0].seq).toBe(1)
  })

  it('acknowledge 后 readPending 不再返回', () => {
    const past = Date.now() - 10000
    wal.append(makeMsg(1, { timestamp: past }))
    wal.acknowledge(['node-a-1'])
    const pending = wal.readPending(Date.now())
    expect(pending.length).toBe(0)
  })

  it('批量 acknowledge 多个 ID', () => {
    wal.append(makeMsg(1))
    wal.append(makeMsg(2))
    wal.append(makeMsg(3))
    wal.acknowledge(new Set(['node-a-1', 'node-a-3']))

    const past = Date.now() + 60000
    const pending = wal.readPending(past)
    expect(pending.length).toBe(1)
    expect(pending[0].seq).toBe(2)
  })

  it('空 Set acknowledge 不产生副作用', () => {
    wal.append(makeMsg(1))
    wal.acknowledge([])
    expect(wal.size).toBe(1)
  })

  it('markConsumed 后 replay 不再包含', () => {
    wal.append(makeMsg(1))
    wal.append(makeMsg(2))
    wal.markConsumed(['node-a-1'])

    const replayed = wal.replay(0)
    expect(replayed.length).toBe(1)
    expect(replayed[0].seq).toBe(2)
  })

  it('replay 从指定 seq 回放', () => {
    for (let i = 1; i <= 5; i++) wal.append(makeMsg(i))

    const replayed = wal.replay(3)
    expect(replayed.length).toBe(3)
    expect(replayed.map(m => m.seq)).toEqual([3, 4, 5])
  })

  it('ACKED 消息也应回放', () => {
    wal.append(makeMsg(1))
    wal.append(makeMsg(2))
    wal.acknowledge(['node-a-1'])

    const replayed = wal.replay(0)
    expect(replayed.length).toBe(2)
  })
})

describe('SegmentStreamWal — Segment 滚动', () => {
  it('写入超过 segment 大小应自动滚动', () => {
    // 用很小的 segment 大小（1KB）
    const wal = new SegmentStreamWal(walDir('roll_test'), 1024)
    wal.open()

    // 写入约 200 字节的消息，5 个就到 1KB
    for (let i = 1; i <= 10; i++) {
      const msg = makeMsg(i, { data: { id: i, padding: 'x'.repeat(150) } })
      wal.append(msg)
    }

    // 应产生至少 2 个 segment 文件
    const dir = walDir('roll_test')
    const logFiles = fs.readdirSync(dir).filter(f => f.endsWith('.log'))
    expect(logFiles.length).toBeGreaterThanOrEqual(2)

    wal.drop()
  })

  it('滚动后数据仍然完整可读', () => {
    const wal = new SegmentStreamWal(walDir('roll_data'), 512)
    wal.open()

    const msgs: StreamMessage[] = []
    for (let i = 1; i <= 20; i++) {
      const msg = makeMsg(i, { data: { id: i, padding: 'x'.repeat(60) } })
      msgs.push(msg)
      wal.append(msg)
    }

    const replayed = wal.replay(0)
    expect(replayed.length).toBe(20)
    expect(replayed.map(m => m.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))

    wal.drop()
  })
})

describe('SegmentStreamWal — prune（核心特性：只删不重写）', () => {
  it('prune 后所有 PENDING 消息仍然可读', () => {
    const wal = new SegmentStreamWal(walDir('prune_pending'))
    wal.open()

    wal.append(makeMsg(1))
    wal.append(makeMsg(2))
    wal.acknowledge(['node-a-1'])

    const remaining = wal.prune()
    expect(remaining).toBe(1)

    // 验证 PENDING 消息仍然在
    const pending = wal.readPending(Date.now() + 60000)
    expect(pending.length).toBe(1)
    expect(pending[0].seq).toBe(2)

    wal.drop()
  })

  it('prune 只删除不包含 PENDING 的 segment', () => {
    // 用小的 segment 大小确保消息分布到多个 segment
    const wal = new SegmentStreamWal(walDir('prune_multiseg'), 512)
    wal.open()

    // 写入 10 条消息（分布在多个 segment）
    for (let i = 1; i <= 10; i++) {
      wal.append(makeMsg(i, { data: { id: i, padding: 'y'.repeat(80) } }))
    }

    // 确认所有消息，触发滚动
    const allIds = Array.from({ length: 5 }, (_, i) => `node-a-${i + 1}`)
    wal.acknowledge(allIds)

    const dir = walDir('prune_multiseg')

    // 获取 pruning 前的 segment 数量
    const beforePruneFiles = fs.readdirSync(dir).filter(f => f.endsWith('.log'))
    const beforeCount = beforePruneFiles.length
    expect(beforeCount).toBeGreaterThanOrEqual(2)

    wal.prune()

    const afterPruneFiles = fs.readdirSync(dir).filter(f => f.endsWith('.log'))
    expect(afterPruneFiles.length).toBeLessThan(beforeCount)

    wal.drop()
  })

  it('prune 后重新打开仍然正确', () => {
    const wal = new SegmentStreamWal(walDir('prune_reopen'))
    wal.open()

    wal.append(makeMsg(1))
    wal.append(makeMsg(2))
    wal.append(makeMsg(3))
    wal.acknowledge(['node-a-1', 'node-a-2'])

    const remainingPending = wal.prune()
    expect(remainingPending).toBe(1) // 只有 seq 3 是 PENDING
    wal.close()

    // 重新打开
    const wal2 = new SegmentStreamWal(walDir('prune_reopen'))
    wal2.open()

    const pending = wal2.readPending(Date.now() + 60000)
    expect(pending.length).toBe(1)
    expect(pending[0].seq).toBe(3)

    wal2.drop()
  })
})

describe('SegmentStreamWal — 崩溃恢复', () => {
  it('close 后重新打开应保留消息', () => {
    const wal = new SegmentStreamWal(walDir('persist'))
    wal.open()
    wal.append(makeMsg(1))
    wal.append(makeMsg(2))
    wal.close()

    const wal2 = new SegmentStreamWal(walDir('persist'))
    wal2.open()
    expect(wal2.size).toBe(2)

    const pending = wal2.readPending(Date.now() + 60000)
    expect(pending.length).toBe(2)
    wal2.drop()
  })

  it('不调用 close 直接重新打开应与文件系统同步', () => {
    // 模拟崩溃：不 close 就直接创建新实例
    const wal = new SegmentStreamWal(walDir('crash'))
    wal.open()
    wal.append(makeMsg(1))
    wal.append(makeMsg(2))
    wal.sync() // 模拟崩溃前内核刷盘
    // 模拟崩溃：不调用 close

    const wal2 = new SegmentStreamWal(walDir('crash'))
    wal2.open()
    // 数据在磁盘上，_countAllEntries 应能扫描到
    expect(wal2.size).toBe(2)
    wal2.drop()
  })
})

describe('SegmentStreamWal — 旧文件迁移', () => {
  it('从旧单文件 WAL 迁移后数据完整', () => {
    // 创建一个旧格式单文件，路径名选一个不会与 walDir() 冲突的名称
    const legacyName = `legacy_migrate_${Date.now()}.wal`
    const legacyPath = path.join(TEST_DIR, legacyName)

    const oldFd = fs.openSync(legacyPath, 'w')
    const msg = makeMsg(1, { data: { test: true } })
    const encoded = encodeMsg(msg, FLAG_PENDING)
    fs.writeSync(oldFd, encoded)
    fs.fsyncSync(oldFd)
    fs.closeSync(oldFd)

    // 构造时传入旧文件路径
    const migratedWal = new SegmentStreamWal(legacyPath)
    migratedWal.open()
    expect(migratedWal.size).toBe(1)

    const replayed = migratedWal.replay(0)
    expect(replayed.length).toBe(1)
    expect(replayed[0].seq).toBe(1)

    // 旧文件应被迁移到新的 segment 目录
    const migrateDir = legacyPath + '_segments'
    expect(fs.existsSync(migrateDir)).toBe(true)
    expect(fs.existsSync(path.join(migrateDir, '00000001.log'))).toBe(true)

    migratedWal.drop()
  })
})

describe('SegmentStreamWal — fsyncOnWrite 选项', () => {
  it('fsyncOnWrite=true 时 append 后 fsync 已调用', () => {
    const wal = new SegmentStreamWal(walDir('fsync_true'), { fsyncOnWrite: true, segmentMaxBytes: 65536 })
    wal.open()
    wal.append(makeMsg(1))
    wal.append(makeMsg(2))
    // close 会触发 _flushAndCloseActiveFd（含 fsync），
    // 不抛出异常即验证 fsync 调用是安全的
    expect(() => wal.close()).not.toThrow()
    // 重新打开后数据应完整
    const wal2 = new SegmentStreamWal(walDir('fsync_true'), { fsyncOnWrite: true })
    wal2.open()
    expect(wal2.size).toBe(2)
    const pending = wal2.readPending(Date.now() + 60000)
    expect(pending.length).toBe(2)
    wal2.drop()
  })

  it('fsyncOnWrite=false 时 append 更快（性能测量）', () => {
    // 使用 tiny segment 避免滚动影响对比
    const count = 5000
    const msg = makeMsg(0)
    const msgBuf = encodeMsg(msg, FLAG_PENDING)
    const recordLen = msgBuf.length

    // 测量 fsyncOnWrite=false 的时间
    const walNoSync = new SegmentStreamWal(walDir('perf_nosync'), { fsyncOnWrite: false, segmentMaxBytes: 10 * 1024 * 1024 })
    walNoSync.open()
    const startNoSync = Date.now()
    for (let i = 0; i < count; i++) {
      walNoSync.append(makeMsg(i))
    }
    const elapsedNoSync = Date.now() - startNoSync
    walNoSync.close()

    // 测量 fsyncOnWrite=true 的时间
    const walSync = new SegmentStreamWal(walDir('perf_sync'), { fsyncOnWrite: true, segmentMaxBytes: 10 * 1024 * 1024 })
    walSync.open()
    const startSync = Date.now()
    for (let i = 0; i < count; i++) {
      walSync.append(makeMsg(i))
    }
    const elapsedSync = Date.now() - startSync
    walSync.close()

    // fsyncOnWrite=false 应更快（或至少不显著慢）
    // 在 CI/磁盘差异环境下，放宽条件
    console.log(`fsyncOnWrite=false: ${elapsedNoSync}ms, fsyncOnWrite=true: ${elapsedSync}ms`)

    // 验证：无 fsync 模式不应显著慢于有 fsync 模式
    // 如果磁盘是 SSD/内存盘，差异可能很小，但至少无 fsync 不应比有 fsync 慢 50% 以上
    expect(elapsedNoSync).toBeLessThanOrEqual(elapsedSync * 1.5)

    // 两种模式的数据都完整
    const walNoSync2 = new SegmentStreamWal(walDir('perf_nosync'), { fsyncOnWrite: false })
    walNoSync2.open()
    expect(walNoSync2.size).toBe(count)
    walNoSync2.drop()

    const walSync2 = new SegmentStreamWal(walDir('perf_sync'), { fsyncOnWrite: true })
    walSync2.open()
    expect(walSync2.size).toBe(count)
    walSync2.drop()
  })

  it('fsyncOnWrite=false 的 WAL 仍可通过 close 和 sync 确保持久化', () => {
    const wal = new SegmentStreamWal(walDir('fsync_false_persist'), { fsyncOnWrite: false })
    wal.open()
    wal.append(makeMsg(1))
    wal.append(makeMsg(2))
    wal.sync() // sync() 内部会 fsync
    wal.close()

    const wal2 = new SegmentStreamWal(walDir('fsync_false_persist'), { fsyncOnWrite: false })
    wal2.open()
    expect(wal2.size).toBe(2)
    wal2.drop()
  })

  it('SegmentStreamWalOptions 接口导出 fsyncOnWrite 属性', () => {
    const opt: SegmentStreamWalOptions = { fsyncOnWrite: false, segmentMaxBytes: 4096 }
    expect(opt.fsyncOnWrite).toBe(false)
    expect(opt.segmentMaxBytes).toBe(4096)
  })

  it('构造时传数字（旧 API）默认 fsyncOnWrite=true', () => {
    const wal = new SegmentStreamWal(walDir('legacy_api'), 65536)
    expect((wal as any)._fsyncOnWrite).toBe(true)
    expect((wal as any)._segmentMaxBytes).toBe(65536)
    wal.drop()
  })

  it('构造时不传第二个参数默认 fsyncOnWrite=true', () => {
    const wal = new SegmentStreamWal(walDir('default_fsync'))
    expect((wal as any)._fsyncOnWrite).toBe(true)
    expect((wal as any)._segmentMaxBytes).toBe(64 * 1024 * 1024)
    wal.drop()
  })
})

describe('SegmentStreamWalAppendStream — fsync 策略与公开方法', () => {
  let tmpPath: string

  beforeEach(() => {
    tmpPath = path.join(TEST_DIR, `append-stream-${Date.now()}-${Math.random()}.log`)
  })

  afterEach(() => {
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  })

  it('无选项构造时默认 fsync 策略为 every-n', () => {
    const fd = fs.openSync(tmpPath, 'w')
    const stream = new SegmentStreamWalAppendStream(fd)
    expect((stream as any)._fsyncStrategy).toBe('every-n')
    expect((stream as any)._fsyncEveryN).toBe(10)
    fs.closeSync(fd)
  })

  it('显式指定 lazy 策略仍可覆盖默认值', () => {
    const fd = fs.openSync(tmpPath, 'w')
    const stream = new SegmentStreamWalAppendStream(fd, { fsyncStrategy: 'lazy' })
    expect((stream as any)._fsyncStrategy).toBe('lazy')
    fs.closeSync(fd)
  })

  it('fsync() 公开方法可独立调用，不抛出异常', () => {
    const fd = fs.openSync(tmpPath, 'w')
    const stream = new SegmentStreamWalAppendStream(fd)

    // 先写入一些数据
    stream.append(Buffer.from('hello'))

    // fsync() 应能安全调用
    expect(() => stream.fsync()).not.toThrow()
    fs.closeSync(fd)
  })

  it('fsync() 方法存在且是函数', () => {
    const fd = fs.openSync(tmpPath, 'w')
    const stream = new SegmentStreamWalAppendStream(fd)
    expect(typeof stream.fsync).toBe('function')
    fs.closeSync(fd)
  })

  it('every-n 策略每 N 次 append 触发 fsync', () => {
    const fd = fs.openSync(tmpPath, 'w')
    const stream = new SegmentStreamWalAppendStream(fd, { fsyncEveryN: 3 })

    // 模拟 append 3 次（计数器达到 N 应触发 fsync）
    stream.append(Buffer.from('a'))
    expect((stream as any)._fsyncCounter).toBe(1)
    stream.append(Buffer.from('b'))
    expect((stream as any)._fsyncCounter).toBe(2)
    stream.append(Buffer.from('c'))
    // 第三次后计数器重置为 0
    expect((stream as any)._fsyncCounter).toBe(0)

    fs.closeSync(fd)
  })
})

// 帮助函数 — 编码消息（与 SegmentStreamWal 内部相同）
function encodeMsg(msg: StreamMessage, flags: number): Buffer {
  const data = JSON.stringify({
    type: msg.type,
    nodeId: msg.nodeId,
    timestamp: msg.timestamp,
    data: msg.data,
    msgId: msg.msgId,
    seq: msg.seq,
  })
  const msgIdBuf = Buffer.from(msg.msgId, 'utf-8')
  const dataBuf = Buffer.from(data, 'utf-8')

  const buf = Buffer.alloc(1 + 4 + msgIdBuf.length + 4 + dataBuf.length)
  let offset = 0
  buf[offset++] = flags
  buf.writeUInt32BE(msgIdBuf.length, offset); offset += 4
  msgIdBuf.copy(buf, offset); offset += msgIdBuf.length
  buf.writeUInt32BE(dataBuf.length, offset); offset += 4
  dataBuf.copy(buf, offset)

  return buf
}
