/**
 * backup-helpers.ts — 备份辅助工具函数
 *
 * 包含文件收集、验证、目录同步等工具方法，
 * 与 backup.ts 分离以控制单文件大小不超过 25KB。
 */

import * as fs from 'fs'
import { promises as fsp } from 'fs'
import * as path from 'path'
import { Logger } from './logger'

/** WAL 文件名匹配模式 */
const WAL_GLOB_PATTERN = /^wal-.+\.bin$/

/**
 * 收集目录下所有文件Info（相对路径 + 大小 + mtime）
 * 用于备份后的校验对比
 */
export function collectFileInfo(dir: string): Array<{ relativePath: string; size: number; mtimeMs: number }> {
  const files: Array<{ relativePath: string; size: number; mtimeMs: number }> = []
  const walk = (currentDir: string, relativePrefix: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      const relativePath = relativePrefix ? path.join(relativePrefix, entry.name) : entry.name
      if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath)
          files.push({ relativePath, size: stat.size, mtimeMs: stat.mtimeMs })
        } catch {
          // 跳过无法访问的文件
        }
      } else if (entry.isDirectory()) {
        walk(fullPath, relativePath)
      }
    }
  }
  walk(dir, '')
  return files
}

/**
 * 验证源与目标文件的一致性（宽松模式 — 用于增量备份）。
 * 只检查目标中存在的文件是否与源文件大小一致。
 * @returns true 如果所有目标文件在源中都有匹配的大小
 */
export function verifyFileConsistencyLoose(
  sourceFiles: Array<{ relativePath: string; size: number }>,
  destFiles: Array<{ relativePath: string; size: number }>,
  logger: Logger
): boolean {
  const sourceDataFiles = sourceFiles.filter(
    f => f.relativePath !== '.consistency-marker' && !f.relativePath.endsWith('.sha256')
  )
  const destDataFiles = destFiles.filter(
    f => f.relativePath !== '.consistency-marker' && !f.relativePath.endsWith('.sha256')
  )

  const sourceMap = new Map<string, number>()
  for (const f of sourceDataFiles) {
    sourceMap.set(f.relativePath, f.size)
  }

  for (const f of destDataFiles) {
    const sourceSize = sourceMap.get(f.relativePath)
    if (sourceSize === undefined) {
      logger.warn(`Backup verification: extra file in backup — ${f.relativePath}`)
      return false
    }
    if (sourceSize !== f.size) {
      logger.warn(
        `Backup verification: size mismatch for ${f.relativePath} — ` +
        `source=${sourceSize}, dest=${f.size}`
      )
      return false
    }
  }

  return true
}

/**
 * 验证源与目标文件的一致性
 * 比较文件数量、文件名集合以及文件大小
 */
export function verifyFileConsistency(
  sourceFiles: Array<{ relativePath: string; size: number }>,
  destFiles: Array<{ relativePath: string; size: number }>,
  logger: Logger
): boolean {
  // 过滤掉 .consistency-marker（只有目标目录有）和校验和文件
  const sourceDataFiles = sourceFiles.filter(
    f => f.relativePath !== '.consistency-marker' && !f.relativePath.endsWith('.sha256')
  )
  const destDataFiles = destFiles.filter(
    f => f.relativePath !== '.consistency-marker' && !f.relativePath.endsWith('.sha256')
  )

  if (sourceDataFiles.length !== destDataFiles.length) {
    logger.warn(
      `Backup verification: file count mismatch — source=${sourceDataFiles.length}, dest=${destDataFiles.length}`
    )
    return false
  }

  // 构建源文件映射：relativePath → size
  const sourceMap = new Map<string, number>()
  for (const f of sourceDataFiles) {
    sourceMap.set(f.relativePath, f.size)
  }

  for (const f of destDataFiles) {
    const sourceSize = sourceMap.get(f.relativePath)
    if (sourceSize === undefined) {
      logger.warn(`Backup verification: extra file in backup — ${f.relativePath}`)
      return false
    }
    if (sourceSize !== f.size) {
      logger.warn(
        `Backup verification: size mismatch for ${f.relativePath} — ` +
        `source=${sourceSize}, dest=${f.size}`
      )
      return false
    }
  }

  return true
}

/**
 * 确保目录下的所有文件都已 fsync
 */
export function fsyncDirectory(dir: string): void {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile()) {
        const fullPath = path.join(dir, entry.name)
        try {
          const fd = fs.openSync(fullPath, 'r')
          fs.fsyncSync(fd)
          fs.closeSync(fd)
        } catch {
          // 单个文件 fsync 失败不阻止整体流程
        }
      } else if (entry.isDirectory()) {
        fsyncDirectory(path.join(dir, entry.name))
      }
    }
  } catch {
    // 目录 fsync 失败不阻止整体流程
  }
}

/**
 * 计算目录下所有文件的字节数
 */
export function calculateDirectorySize(dir: string): number {
  let sizeBytes = 0
  const walkDir = (currentDir: string) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isFile()) {
        sizeBytes += fs.statSync(fullPath).size
      } else if (entry.isDirectory()) {
        walkDir(fullPath)
      }
    }
  }
  walkDir(dir)
  return sizeBytes
}

/**
 * 复制新增或修改过的非 WAL 数据文件。
 * 对比当前数据目录和 base 备份，只复制 base 备份中不存在或 mtime 更新的文件。
 * @returns 复制的文件数量
 */
export function copyNewOrChangedFiles(
  srcDir: string,
  dstDir: string,
  baseBakDir: string
): number {
  let count = 0
  const walk = (currentDir: string, relativePrefix: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullSrcPath = path.join(currentDir, entry.name)
      const relativePath = relativePrefix
        ? path.join(relativePrefix, entry.name)
        : entry.name
      if (entry.isFile()) {
        // 跳过 WAL 文件（单独处理）和元数据文件
        if (WAL_GLOB_PATTERN.test(entry.name)) {
          continue
        }

        const basePath = path.join(baseBakDir, relativePath)
        const dstFullPath = path.join(dstDir, relativePath)

        const srcStat = fs.statSync(fullSrcPath)
        let needsCopy = false

        if (!fs.existsSync(basePath)) {
          // 在 base 备份中不存在 → 新增文件
          needsCopy = true
        } else {
          // 在 base 备份中存在 → 比较 mtime
          const baseStat = fs.statSync(basePath)
          if (srcStat.mtimeMs > baseStat.mtimeMs + 1) {
            needsCopy = true
          }
        }

        if (needsCopy) {
          fs.mkdirSync(path.dirname(dstFullPath), { recursive: true })
          fs.copyFileSync(fullSrcPath, dstFullPath)
          count++
        }
      } else if (entry.isDirectory()) {
        walk(fullSrcPath, relativePath)
      }
    }
  }
  walk(srcDir, '')
  return count
}

/**
 * 写入 JSON 一致性标记文件并 fsync
 */
export function writeMarkerFile(
  destPath: string,
  marker: Record<string, unknown>
): void {
  fs.writeFileSync(
    path.join(destPath, '.consistency-marker'),
    JSON.stringify(marker, null, 2)
  )

  const markerPath = path.join(destPath, '.consistency-marker')
  try {
    const fd = fs.openSync(markerPath, 'r+')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
  } catch {
    // fsync 失败不阻止流程
  }
}

/**
 * 创建备份目标目录并复制整个数据目录
 * @returns 复制的文件数量
 */
export async function copyDataDirectory(
  dataDir: string,
  destPath: string
): Promise<void> {
  await fsp.cp(dataDir, destPath, { recursive: true })
  fsyncDirectory(destPath)
}
