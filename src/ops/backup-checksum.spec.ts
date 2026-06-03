/**
 * backup-checksum.spec.ts
 *
 * 测试 backup-checksum 提供的校验和工具函数。
 * 对每个 export 的函数进行真实单元测试（不使用 mock）。
 * 临时文件使用 tmpdir + randomDir 模式，beforeEach/afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import {
  computeChecksum,
  writeChecksumFiles,
  verifyChecksumsSync,
  CHECKSUM_FILE_EXT,
} from './backup-checksum'

function randomDir(): string {
  return path.join(
    os.tmpdir(),
    `backup-checksum-test-${crypto.randomBytes(4).readUInt32LE(0).toString(16)}`,
  )
}

describe('computeChecksum', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = randomDir()
    fs.mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should compute SHA-256 checksum for a file', () => {
    const content = 'Hello, World!'
    const filePath = path.join(tmpDir, 'hello.txt')
    fs.writeFileSync(filePath, content, 'utf-8')

    const hash = computeChecksum(filePath)

    const expected = crypto.createHash('sha256').update(content).digest('hex')
    expect(hash).toBe(expected)
    expect(hash.length).toBe(64) // SHA-256 hex = 64 chars
  })

  it('should compute correct checksum for binary data', () => {
    const binaryData = Buffer.from([0x00, 0x01, 0xFF, 0xFE, 0xAB, 0xCD])
    const filePath = path.join(tmpDir, 'binary.dat')
    fs.writeFileSync(filePath, binaryData)

    const hash = computeChecksum(filePath)
    const expected = crypto.createHash('sha256').update(binaryData).digest('hex')
    expect(hash).toBe(expected)
  })

  it('should compute different checksums for different files', () => {
    const fileA = path.join(tmpDir, 'a.txt')
    const fileB = path.join(tmpDir, 'b.txt')
    fs.writeFileSync(fileA, 'content-a')
    fs.writeFileSync(fileB, 'content-b')

    const hashA = computeChecksum(fileA)
    const hashB = computeChecksum(fileB)

    expect(hashA).not.toBe(hashB)
  })

  it('should compute same checksum for identical content', () => {
    const fileA = path.join(tmpDir, 'a.txt')
    const fileB = path.join(tmpDir, 'b.txt')
    fs.writeFileSync(fileA, 'same content')
    fs.writeFileSync(fileB, 'same content')

    const hashA = computeChecksum(fileA)
    const hashB = computeChecksum(fileB)

    expect(hashA).toBe(hashB)
  })

  it('should handle empty files', () => {
    const filePath = path.join(tmpDir, 'empty.txt')
    fs.writeFileSync(filePath, '')
    const hash = computeChecksum(filePath)
    const expected = crypto.createHash('sha256').update('').digest('hex')
    expect(hash).toBe(expected)
  })

  it('should throw for non-existent file', () => {
    expect(() => computeChecksum(path.join(tmpDir, 'nonexistent.txt'))).toThrow()
  })
})

describe('writeChecksumFiles', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = randomDir()
    fs.mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should write .sha256 files for data files', () => {
    const filePath = path.join(tmpDir, 'data.bin')
    fs.writeFileSync(filePath, 'some data')

    writeChecksumFiles(tmpDir)

    const shaFile = filePath + CHECKSUM_FILE_EXT
    expect(fs.existsSync(shaFile)).toBe(true)
    const hashContent = fs.readFileSync(shaFile, 'utf-8').trim()
    expect(hashContent.split('\n')).toHaveLength(1)
    expect(hashContent).toMatch(/^[a-f0-9]{64}$/)
  })

  it('should skip .sha256 files themselves', () => {
    // write a data file and its .sha256 first
    const dataFile = path.join(tmpDir, 'data.bin')
    fs.writeFileSync(dataFile, 'data')
    writeChecksumFiles(tmpDir)

    const shaFile = dataFile + CHECKSUM_FILE_EXT
    const shaContentBefore = fs.readFileSync(shaFile, 'utf-8')

    // run again — should not re-process the .sha256 file
    writeChecksumFiles(tmpDir)

    const shaContentAfter = fs.readFileSync(shaFile, 'utf-8')
    expect(shaContentAfter).toBe(shaContentBefore)
  })

  it('should skip .consistency-marker file', () => {
    fs.writeFileSync(path.join(tmpDir, '.consistency-marker'), 'marker')
    writeChecksumFiles(tmpDir)
    const markerSha = path.join(tmpDir, '.consistency-marker.sha256')
    expect(fs.existsSync(markerSha)).toBe(false)
  })

  it('should handle nested subdirectories', () => {
    const subDir = path.join(tmpDir, 'sub', 'nested')
    fs.mkdirSync(subDir, { recursive: true })
    const filePath = path.join(subDir, 'data.txt')
    fs.writeFileSync(filePath, 'nested data')

    writeChecksumFiles(tmpDir)

    const shaFile = filePath + CHECKSUM_FILE_EXT
    expect(fs.existsSync(shaFile)).toBe(true)
    const hash = fs.readFileSync(shaFile, 'utf-8').trim()
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('should handle directories that cannot be read gracefully', () => {
    // no-op: writeChecksumFiles catches readdir errors internally
    expect(() => writeChecksumFiles('/nonexistent/path')).not.toThrow()
  })
})

describe('verifyChecksumsSync', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = randomDir()
    fs.mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should return true when all checksums match', () => {
    const filePath = path.join(tmpDir, 'data.bin')
    fs.writeFileSync(filePath, 'valid data')

    writeChecksumFiles(tmpDir)
    const result = verifyChecksumsSync(tmpDir)

    expect(result).toBe(true)
  })

  it('should return true for empty directory (no sha files)', () => {
    const result = verifyChecksumsSync(tmpDir)
    expect(result).toBe(true)
  })

  it('should return false when data is modified after checksum creation', () => {
    const filePath = path.join(tmpDir, 'data.bin')
    fs.writeFileSync(filePath, 'original content')
    writeChecksumFiles(tmpDir)

    // Modify the data file after checksum was written
    fs.writeFileSync(filePath, 'modified content!')

    const result = verifyChecksumsSync(tmpDir)
    expect(result).toBe(false)
  })

  it('should return false when .sha256 file exists but original missing', () => {
    const filePath = path.join(tmpDir, 'data.bin')
    fs.writeFileSync(filePath, 'data')
    writeChecksumFiles(tmpDir)

    // Delete the original file
    fs.unlinkSync(filePath)

    const result = verifyChecksumsSync(tmpDir)
    expect(result).toBe(false)
  })

  it('should verify nested directory checksums', () => {
    const subDir = path.join(tmpDir, 'nested', 'deep')
    fs.mkdirSync(subDir, { recursive: true })
    const fileA = path.join(tmpDir, 'root.txt')
    const fileB = path.join(subDir, 'leaf.bin')
    fs.writeFileSync(fileA, 'root data')
    fs.writeFileSync(fileB, 'leaf data')

    writeChecksumFiles(tmpDir)
    const result = verifyChecksumsSync(tmpDir)

    expect(result).toBe(true)
  })

  it('should detect tampered file in nested directory', () => {
    const subDir = path.join(tmpDir, 'sub')
    fs.mkdirSync(subDir, { recursive: true })
    const filePath = path.join(subDir, 'secret.txt')
    fs.writeFileSync(filePath, 'secret content')
    writeChecksumFiles(tmpDir)

    // Tamper
    fs.writeFileSync(filePath, 'tampered!')

    const result = verifyChecksumsSync(tmpDir)
    expect(result).toBe(false)
  })
})
