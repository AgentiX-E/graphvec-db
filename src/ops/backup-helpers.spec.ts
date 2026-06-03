/**
 * backup-helpers.spec.ts — backup-helpers 纯函数单元测试
 *
 * 测试 collectFileInfo / verifyFileConsistencyLoose / verifyFileConsistency /
 * fsyncDirectory / calculateDirectorySize / copyNewOrChangedFiles /
 * writeMarkerFile / copyDataDirectory
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import { promises as fsp } from 'fs'
import { tmpdir } from 'os'
import { Logger } from './logger'
import {
  collectFileInfo,
  verifyFileConsistencyLoose,
  verifyFileConsistency,
  calculateDirectorySize,
  writeMarkerFile,
  copyNewOrChangedFiles,
  copyDataDirectory,
} from './backup-helpers'

// 一个静默 logger 用于验证函数
const silentLogger: Logger = {
  info: () => {},
  warn: (msg: string) => { lastWarn = msg },
  error: () => {},
  debug: () => {},
}

let lastWarn = ''
let testDir = ''
let srcDir = ''
let dstDir = ''

function resetDir(root: string): string {
  const d = path.join(root, `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

describe('collectFileInfo', () => {
  let tmp: string
  beforeAll(() => {
    tmp = resetDir(tmpdir())
    fs.writeFileSync(path.join(tmp, 'a.bin'), Buffer.alloc(10))
    fs.writeFileSync(path.join(tmp, 'b.txt'), 'hello')
    fs.mkdirSync(path.join(tmp, 'sub'))
    fs.writeFileSync(path.join(tmp, 'sub', 'c.dat'), Buffer.alloc(20))
  })

  it('collects all files with relative paths', () => {
    const files = collectFileInfo(tmp)
    // 按相对路径排序以便断言
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    expect(files).toHaveLength(3)
    expect(files[0].relativePath).toBe('a.bin')
    expect(files[1].relativePath).toBe('b.txt')
    expect(files[2].relativePath).toBe('sub/c.dat')
  })

  it('records file sizes', () => {
    const files = collectFileInfo(tmp)
    const a = files.find(f => f.relativePath === 'a.bin')
    const c = files.find(f => f.relativePath === 'sub/c.dat')
    expect(a!.size).toBe(10)
    expect(c!.size).toBe(20)
  })

  it('records mtimeMs as a finite number', () => {
    const files = collectFileInfo(tmp)
    for (const f of files) {
      expect(Number.isFinite(f.mtimeMs)).toBe(true)
    }
  })

  it('returns empty array for non-existent directory', () => {
    expect(collectFileInfo('/nonexistent-path-xxx')).toEqual([])
  })

  it('returns empty array for empty directory', () => {
    const empty = resetDir(tmpdir())
    expect(collectFileInfo(empty)).toEqual([])
  })
})

describe('verifyFileConsistencyLoose', () => {
  it('passes when all dest files match source sizes', () => {
    const src = [
      { relativePath: 'a.bin', size: 10 },
      { relativePath: 'b.txt', size: 5 },
    ]
    const dst = [
      { relativePath: 'a.bin', size: 10 },
      { relativePath: 'b.txt', size: 5 },
    ]
    expect(verifyFileConsistencyLoose(src, dst, silentLogger)).toBe(true)
  })

  it('passes when dest has fewer files (loose mode)', () => {
    const src = [
      { relativePath: 'a.bin', size: 10 },
      { relativePath: 'b.txt', size: 5 },
    ]
    const dst = [
      { relativePath: 'a.bin', size: 10 },
    ]
    expect(verifyFileConsistencyLoose(src, dst, silentLogger)).toBe(true)
  })

  it('fails on size mismatch', () => {
    const src = [
      { relativePath: 'a.bin', size: 10 },
    ]
    const dst = [
      { relativePath: 'a.bin', size: 11 },
    ]
    expect(verifyFileConsistencyLoose(src, dst, silentLogger)).toBe(false)
  })

  it('fails on extra file in dest', () => {
    const src = [{ relativePath: 'a.bin', size: 10 }]
    const dst = [
      { relativePath: 'a.bin', size: 10 },
      { relativePath: 'extra.txt', size: 3 },
    ]
    expect(verifyFileConsistencyLoose(src, dst, silentLogger)).toBe(false)
  })

  it('filters out .consistency-marker and .sha256 files', () => {
    const src = [{ relativePath: 'data.bin', size: 10 }]
    const dst = [
      { relativePath: 'data.bin', size: 10 },
      { relativePath: '.consistency-marker', size: 20 },
      { relativePath: 'data.bin.sha256', size: 64 },
    ]
    expect(verifyFileConsistencyLoose(src, dst, silentLogger)).toBe(true)
  })
})

describe('verifyFileConsistency', () => {
  it('passes when all files match exactly', () => {
    const src = [
      { relativePath: 'a.bin', size: 10 },
      { relativePath: 'b.txt', size: 5 },
    ]
    const dst = [
      { relativePath: 'a.bin', size: 10 },
      { relativePath: 'b.txt', size: 5 },
    ]
    expect(verifyFileConsistency(src, dst, silentLogger)).toBe(true)
  })

  it('fails on file count mismatch', () => {
    const src = [
      { relativePath: 'a.bin', size: 10 },
      { relativePath: 'b.txt', size: 5 },
    ]
    const dst = [
      { relativePath: 'a.bin', size: 10 },
    ]
    expect(verifyFileConsistency(src, dst, silentLogger)).toBe(false)
  })

  it('fails on size mismatch', () => {
    const src = [{ relativePath: 'a.bin', size: 10 }]
    const dst = [{ relativePath: 'a.bin', size: 11 }]
    expect(verifyFileConsistency(src, dst, silentLogger)).toBe(false)
  })

  it('fails on extra file in dest', () => {
    const src = [{ relativePath: 'a.bin', size: 10 }]
    const dst = [
      { relativePath: 'a.bin', size: 10 },
      { relativePath: 'extra.txt', size: 3 },
    ]
    expect(verifyFileConsistency(src, dst, silentLogger)).toBe(false)
  })

  it('fails on missing file in dest', () => {
    const src = [
      { relativePath: 'a.bin', size: 10 },
      { relativePath: 'b.txt', size: 5 },
    ]
    const dst = [{ relativePath: 'a.bin', size: 10 }]
    expect(verifyFileConsistency(src, dst, silentLogger)).toBe(false)
  })

  it('handles empty file lists', () => {
    expect(verifyFileConsistency([], [], silentLogger)).toBe(true)
  })

  it('filters out .consistency-marker and .sha256', () => {
    const src = [{ relativePath: 'data.bin', size: 10 }]
    const dst = [
      { relativePath: 'data.bin', size: 10 },
      { relativePath: '.consistency-marker', size: 20 },
    ]
    expect(verifyFileConsistency(src, dst, silentLogger)).toBe(true)
  })
})

describe('calculateDirectorySize', () => {
  let tmp: string
  beforeAll(() => {
    tmp = resetDir(tmpdir())
    fs.writeFileSync(path.join(tmp, 'a.bin'), Buffer.alloc(100))
    fs.writeFileSync(path.join(tmp, 'b.txt'), 'hi')
    fs.mkdirSync(path.join(tmp, 'sub'))
    fs.writeFileSync(path.join(tmp, 'sub', 'c.dat'), Buffer.alloc(50))
  })

  it('calculates total bytes of all files', () => {
    const size = calculateDirectorySize(tmp)
    expect(size).toBeGreaterThanOrEqual(152) // 100 + 2 + 50
    expect(size).toBeLessThan(200)
  })

  it('returns 0 for empty directory', () => {
    const empty = resetDir(tmpdir())
    expect(calculateDirectorySize(empty)).toBe(0)
  })
})

describe('writeMarkerFile', () => {
  let tmp: string
  beforeAll(() => {
    tmp = resetDir(tmpdir())
  })

  it('writes .consistency-marker JSON file', () => {
    writeMarkerFile(tmp, { type: 'full', timestamp: 123456 })
    const markerPath = path.join(tmp, '.consistency-marker')
    expect(fs.existsSync(markerPath)).toBe(true)
    const content = JSON.parse(fs.readFileSync(markerPath, 'utf-8'))
    expect(content).toEqual({ type: 'full', timestamp: 123456 })
  })

  it('overwrites existing marker', () => {
    writeMarkerFile(tmp, { version: 1 })
    writeMarkerFile(tmp, { version: 2 })
    const content = JSON.parse(
      fs.readFileSync(path.join(tmp, '.consistency-marker'), 'utf-8'),
    )
    expect(content.version).toBe(2)
  })
})

describe('copyNewOrChangedFiles', () => {
  beforeAll(() => {
    testDir = resetDir(tmpdir())
    srcDir = path.join(testDir, 'src')
    dstDir = path.join(testDir, 'dst')
    const baseDir = path.join(testDir, 'base')
    fs.mkdirSync(srcDir, { recursive: true })
    fs.mkdirSync(dstDir, { recursive: true })
    fs.mkdirSync(baseDir, { recursive: true })

    // 在 base 和 src 中创建文件
    fs.writeFileSync(path.join(srcDir, 'unchanged.txt'), 'same')
    fs.writeFileSync(path.join(baseDir, 'unchanged.txt'), 'same')

    // base 中没有的新文件
    fs.writeFileSync(path.join(srcDir, 'new.txt'), 'new content')

    // base 中有但 src 中修改了的文件
    fs.writeFileSync(path.join(srcDir, 'changed.txt'), 'newer content')
    // 写 base 版本，然后等一会儿
    fs.writeFileSync(path.join(baseDir, 'changed.txt'), 'old content')
  })

  it('copies new and changed files, skipping unchanged', async () => {
    // 等 2ms 确保 mtime 差异
    await new Promise(r => setTimeout(r, 10))

    // 更新 src 中 changed.txt 的 mtime
    const srcChanged = path.join(srcDir, 'changed.txt')
    const now = Date.now() / 1000
    fs.utimesSync(srcChanged, now, now)

    const count = copyNewOrChangedFiles(srcDir, dstDir, path.join(testDir, 'base'))
    // 应该复制 new.txt（新增）和 changed.txt（mtime 更新）
    expect(count).toBe(2)

    expect(fs.existsSync(path.join(dstDir, 'new.txt'))).toBe(true)
    expect(fs.readFileSync(path.join(dstDir, 'new.txt'), 'utf-8')).toBe('new content')
    expect(fs.readFileSync(path.join(dstDir, 'changed.txt'), 'utf-8')).toBe('newer content')
  })
})

describe('copyDataDirectory', () => {
  let tmp: string
  beforeAll(async () => {
    tmp = resetDir(tmpdir())
    const dataDir = path.join(tmp, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'f1.bin'), Buffer.alloc(10))
    fs.mkdirSync(path.join(dataDir, 'sub'))
    fs.writeFileSync(path.join(dataDir, 'sub', 'f2.txt'), 'test')
    await copyDataDirectory(dataDir, path.join(tmp, 'backup'))
  })

  it('copies entire directory recursively', () => {
    expect(fs.existsSync(path.join(tmp, 'backup', 'f1.bin'))).toBe(true)
    expect(fs.existsSync(path.join(tmp, 'backup', 'sub', 'f2.txt'))).toBe(true)
    expect(fs.readFileSync(path.join(tmp, 'backup', 'sub', 'f2.txt'), 'utf-8')).toBe('test')
  })

  it('preserves file sizes', () => {
    const stat = fs.statSync(path.join(tmp, 'backup', 'f1.bin'))
    expect(stat.size).toBe(10)
  })
})
