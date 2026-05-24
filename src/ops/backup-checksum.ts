/**
 * backup-checksum.ts — SHA-256 校验和工具
 *
 * 与 backup.ts 分离以控制单文件大小不超过 25KB。
 */

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { Logger } from './logger'

/** 校验和文件扩展名 */
export const CHECKSUM_FILE_EXT = '.sha256'

/**
 * 计算文件的 SHA-256 校验和（十六进制字符串）。
 */
export function computeChecksum(filePath: string): string {
  const content = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(content).digest('hex')
}

/**
 * 为备份目录中的每个数据文件生成 .sha256 校验和文件并写入。
 */
export function writeChecksumFiles(backupPath: string): void {
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isFile()) {
        // 跳过后生成的元数据文件
        if (entry.name === '.consistency-marker' ||
            entry.name.endsWith(CHECKSUM_FILE_EXT)) {
          continue
        }
        const hash = computeChecksum(fullPath)
        const shaFile = fullPath + CHECKSUM_FILE_EXT
        fs.writeFileSync(shaFile, hash + '\n')
        try {
          const fd = fs.openSync(shaFile, 'r+')
          fs.fsyncSync(fd)
          fs.closeSync(fd)
        } catch {
          // fsync 失败不阻止整体流程
        }
      } else if (entry.isDirectory()) {
        walk(fullPath)
      }
    }
  }
  walk(backupPath)
}

/**
 * 验证备份目录的 SHA-256 校验和。
 * @param backupPath 备份路径
 * @returns true 如果所有文件校验和都匹配
 */
export function verifyChecksumsSync(backupPath: string, logger?: Logger): boolean {
  let allValid = true
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      allValid = false
      return
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isFile() && entry.name.endsWith(CHECKSUM_FILE_EXT)) {
        // 找到 .sha256 文件，验证原始文件
        const originalFile = fullPath.slice(0, -CHECKSUM_FILE_EXT.length)
        if (!fs.existsSync(originalFile)) {
          logger?.warn(`Checksum file exists but original missing: ${originalFile}`)
          allValid = false
          continue
        }
        try {
          const expectedHash = fs.readFileSync(fullPath, 'utf-8').trim().split('\n')[0]
          const actualHash = computeChecksum(originalFile)
          if (expectedHash !== actualHash) {
            logger?.warn(
              `Checksum mismatch for ${originalFile}: expected=${expectedHash}, actual=${actualHash}`
            )
            allValid = false
          }
        } catch {
          logger?.warn(`Failed to verify checksum for: ${originalFile}`)
          allValid = false
        }
      } else if (entry.isDirectory()) {
        walk(fullPath)
      }
    }
  }
  walk(backupPath)
  return allValid
}
