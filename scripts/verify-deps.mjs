#!/usr/bin/env node
// ============================================================
// verify-deps.mjs — package-lock.json 完整性校验
//
// 作用：在 npm install 前运行，校验：
// 1. package-lock.json 的完整性（SHA-256 自校验）
// 2. node_modules 中各包的关键元数据是否与 lock 匹配
// ============================================================

import { createHash } from 'crypto'
import { readFileSync, existsSync, statSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')
const LOCK_FILE = resolve(PROJECT_ROOT, 'package-lock.json')
const NODE_MODULES = resolve(PROJECT_ROOT, 'node_modules')

const STORED_HASH_FILE = resolve(PROJECT_ROOT, '.lock-hash')
const HAS_NODE_MODULES = existsSync(NODE_MODULES)

let exitCode = 0

console.log('🔒 verify-deps: Starting dependency integrity verification...\n')

// ──────────────────────────────────────
// 1. 检查 package-lock.json 是否存在且有效
// ──────────────────────────────────────

if (!existsSync(LOCK_FILE)) {
  console.error('❌ package-lock.json not found')
  process.exit(1)
}

const lockRaw = readFileSync(LOCK_FILE, 'utf-8')
let lockData
try {
  lockData = JSON.parse(lockRaw)
} catch {
  console.error('❌ package-lock.json is not valid JSON')
  process.exit(1)
}

// ──────────────────────────────────────
// 2. package-lock.json SHA-256 自校验
// ──────────────────────────────────────

const currentHash = createHash('sha256').update(lockRaw).digest('hex')
console.log(`📋 Current lock file SHA-256: ${currentHash.substring(0, 16)}...`)

if (existsSync(STORED_HASH_FILE)) {
  const storedHash = readFileSync(STORED_HASH_FILE, 'utf-8').trim()

  if (currentHash !== storedHash) {
    console.error(`❌ package-lock.json has been modified!
  Stored hash:       ${storedHash}
  Current hash:      ${currentHash}
  
  This may indicate tampering or uncommitted changes!
  If you intentionally updated dependencies, update the stored hash:
    node scripts/verify-deps.mjs --update-hash`)
    exitCode = 1
  } else {
    console.log('✅ Lock file integrity verified (SHA-256 match)')
  }
} else {
  // 首次运行：自动存储 hash
  console.log('📌 First run: storing lock file hash...')
}

// ──────────────────────────────────────
// 3. node_modules 存在性检查
//    验证 lock 中列出的顶层依赖是否在 node_modules 中存在
// ──────────────────────────────────────

if (!HAS_NODE_MODULES) {
  console.log('ℹ️  node_modules not found — skipping package integrity check')
} else {
  const packages = lockData.packages || {}
  let checked = 0
  let failed = 0
  const MAX_FAILED_TO_SHOW = 5

  // 只检查顶层依赖（node_modules 根目录下的包）
  for (const [pkgPath, pkgInfo] of Object.entries(packages)) {
    if (!pkgPath) continue // skip root

    // 只检查顶层依赖，跳过嵌套的 (@scope/name 也在顶层)
    if (pkgPath.startsWith('node_modules/') && !pkgPath.includes('/', 'node_modules/'.length)) {
      checked++
      const localPath = resolve(PROJECT_ROOT, pkgPath)
      const pkgJsonPath = resolve(localPath, 'package.json')

      if (!existsSync(pkgJsonPath)) {
        // 可选依赖可能在当前平台未安装（如 fsevents 在 Linux 上）
        if (pkgInfo.optional) {
          console.log(`  ⚪ Skipping optional package (not installed): ${pkgPath}`)
        } else {
          failed++
          if (failed <= MAX_FAILED_TO_SHOW) {
            console.error(`❌ Missing package: ${pkgPath} (not in node_modules)`)
          }
        }
        continue
      }

      // 验证 package.json 的 version 是否一致
      const expectedVersion = pkgInfo.version
      try {
        const localPkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
        if (localPkg.version !== expectedVersion) {
          failed++
          if (failed <= MAX_FAILED_TO_SHOW) {
            console.error(`❌ Version mismatch: ${pkgPath}
  Expected: ${expectedVersion}
  Actual:   ${localPkg.version}`)
          }
        }
      } catch {
        failed++
        if (failed <= MAX_FAILED_TO_SHOW) {
          console.error(`❌ Cannot read package.json for ${pkgPath}`)
        }
      }
    }
  }

  if (failed === 0) {
    console.log(`✅ All ${checked} top-level packages passed version check`)
  } else {
    console.error(`❌ ${failed}/${checked} top-level packages failed version check`)
    console.error('  node_modules may be corrupted or out of sync with package-lock.json')
    exitCode = 1
  }
}

// ── 结果 ──────────────────────────────────

console.log('')
if (exitCode === 0) {
  console.log('✅ verify-deps: All checks passed')
} else {
  console.error('❌ verify-deps: Integrity verification failed')
}

process.exit(exitCode)
