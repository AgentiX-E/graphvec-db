/**
 * scripts/profile-temporal.ts — Temporay profiling script for TCK Temporal 1004 tests.
 *
 * Instruments 5 expression-engine functions with hrtime and profiles
 * their execution across 10 TCK temporal feature files.
 *
 * Strategy: Creates temp wrapper files that redirect imports through
 * an instrumented expression-engine module. Uses a custom cucumber config
 * to avoid loading original step-definitions.
 *
 * Usage: npx tsx scripts/profile-temporal.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'src/query')

const tempFiles: string[] = []

function cleanup() {
  for (const tf of tempFiles) {
    try { fs.unlinkSync(tf) } catch {}
  }
}
process.on('exit', cleanup)
process.once('SIGTERM', () => process.exit(0))
process.once('SIGINT', () => process.exit(0))

// ── 1. Create profiled expression-engine wrapper ──

const wrapperCode = `
const hrt = process.hrtime.bigint
const _rawProfiles: Record<string, { totalNs: bigint; callCount: number; minNs: bigint; maxNs: bigint }> = {}
function getOrCreate(name: string) {
  if (!_rawProfiles[name]) {
    _rawProfiles[name] = { totalNs: 0n, callCount: 0, minNs: BigInt(Number.MAX_SAFE_INTEGER), maxNs: 0n }
  }
  return _rawProfiles[name]
}
function wrapFn<T extends (...args: any[]) => any>(name: string, fn: T): T {
  return function (this: any, ...args: any[]): any {
    const start = hrt()
    try { return fn.apply(this, args) }
    finally {
      const elapsed = hrt() - start
      const p = getOrCreate(name)
      p.callCount++; p.totalNs += elapsed
      if (elapsed < p.minNs) p.minNs = elapsed
      if (elapsed > p.maxNs) p.maxNs = elapsed
    }
  } as T
}
process.on('exit', () => {
  const out: Record<string, any> = {}
  for (const [name, p] of Object.entries(_rawProfiles)) {
    out[name] = {
      totalNs: p.totalNs.toString(), callCount: p.callCount,
      minNs: p.minNs.toString(), maxNs: p.maxNs.toString(),
      avgNs: (p.totalNs / BigInt(p.callCount || 1)).toString()
    }
  }
  try { require('fs').writeFileSync('/tmp/temporal-profile-result.json', JSON.stringify(out, null, 2), 'utf-8') } catch {}
})
import {
  _evaluateExpression as _oee, _evalBinary as _oeb,
  _resolveNamedTimezone as _ornt, _resolveDateFromMap as _ordm,
  _formatTime as _oft,
  _evalStructuredLiteral, _parseAggregate, _postProcessResults,
  _extractAggColumns, _hasAggregates, _executeAggregation,
  _validateLiterals, _evalUnary, _evalLiteral, _bigintReplacer,
  _bigintReviver, _evalCase, _formatTimezone, _evalComparison,
  type ExprValue, type QueryRow, type AggColumnInfo
} from './expression-engine'
export const _evaluateExpression = wrapFn('_evaluateExpression', _oee)
export const _evalBinary = wrapFn('_evalBinary', _oeb)
export const _resolveNamedTimezone = wrapFn('_resolveNamedTimezone', _ornt)
export const _resolveDateFromMap = wrapFn('_resolveDateFromMap', _ordm)
export const _formatTime = wrapFn('_formatTime', _oft)
export {
  _evalStructuredLiteral, _parseAggregate, _postProcessResults,
  _extractAggColumns, _hasAggregates, _executeAggregation,
  _validateLiterals, _evalUnary, _evalLiteral, _bigintReplacer,
  _bigintReviver, _evalCase, _formatTimezone, _evalComparison,
  ExprValue, QueryRow, AggColumnInfo
}
`

const wrapperPath = path.join(SRC, 'expression-engine-profile.ts')
fs.writeFileSync(wrapperPath, wrapperCode, 'utf-8')
tempFiles.push(wrapperPath)
console.log('[profile] Created: ' + wrapperPath)

// ── 2. Create profile wrappers for files that import from expression-engine ──

const importers = [
  'executor-common.ts',
  'executor-non-ge.ts',
  'executor-registry.ts',
  'executor-validate-plan.ts',
  'query-executor.ts',
  'query-parser.ts',
  'var-length-path.ts',
]

for (const file of importers) {
  const content = fs.readFileSync(path.join(SRC, file), 'utf-8')
  const patched = content.replace(/from\s+['"]\.\/expression-engine['"]/g, "from './expression-engine-profile'")
  const tempPath = path.join(SRC, file.replace('.ts', '-profile.ts'))
  fs.writeFileSync(tempPath, patched, 'utf-8')
  tempFiles.push(tempPath)
}

console.log(`[profile] Created ${importers.length} intermediate wrappers`)

// ── 3. Create query-engine-profile.ts ──

const qeContent = fs.readFileSync(path.join(SRC, 'query-engine.ts'), 'utf-8')
let patchedQE = qeContent
for (const file of importers) {
  const base = file.replace('.ts', '')
  patchedQE = patchedQE.replace(new RegExp(`from\\s+['"]\\.\\/${base}['"]`, 'g'), `from './${base}-profile'`)
}
const qeProfilePath = path.join(SRC, 'query-engine-profile.ts')
fs.writeFileSync(qeProfilePath, patchedQE, 'utf-8')
tempFiles.push(qeProfilePath)

// ── 4. Create step-definitions-profile.ts that imports from query-engine-profile ──

const sdContent = fs.readFileSync(path.join(SRC, 'cypher-tck/step-definitions.ts'), 'utf-8')
const patchedSD = sdContent.replace(/from\s+['"]\.\.\/query-engine['"]/g, "from '../query-engine-profile'")
const sdProfilePath = path.join(SRC, 'cypher-tck/step-definitions-profile.ts')
fs.writeFileSync(sdProfilePath, patchedSD, 'utf-8')
tempFiles.push(sdProfilePath)

// ── 5. Create a temporary cucumber profile config ──

const cucumberConfig = {
  default: {
    require: ['src/query/cypher-tck/step-definitions-profile.ts'],
    requireModule: ['tsx'],
    format: ['summary'],
    publishQuiet: true,
    timeout: 30000,
  },
}

// Can't use cucumber.js config because require paths use --require CLI
// Let's just use explicit CLI args.

// ── 6. Run cucumber with temporal features only ──

const temporalDir = path.join(SRC, 'cypher-tck/features/expressions/temporal')
const featureFiles = fs.readdirSync(temporalDir).filter(f => f.endsWith('.feature')).sort()

console.log(`\n[profile] Running ${featureFiles.length} temporal feature files (max 2 min)...`)

const featureArgs = featureFiles.map(f => path.join(temporalDir, f))

try {
  execSync(
    'npx cucumber-js ' +
    featureArgs.map(f => `"${f}"`).join(' ') +
    ' --require "' + sdProfilePath + '"' +
    ' --require-module tsx' +
    ' --format summary' +
    ' --publish-quiet',
    {
      cwd: ROOT,
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
      maxBuffer: 10 * 1024 * 1024,
    }
  )
  console.log('[profile] Cucumber completed')
} catch (e: any) {
  const out = e.stdout?.toString() || ''
  const lines = out.split('\n').filter(l => l.trim())
  const summary = lines.filter(l => /\d+\s+(passed|failed|ambiguous|scenarios|steps)/.test(l))
  console.log('[profile] Cucumber exit:', e.status)
  if (summary.length) console.log(summary.join('\n'))
}

// ── 7. Read results ──
const resultPath = '/tmp/temporal-profile-result.json'
if (fs.existsSync(resultPath)) {
  const data = JSON.parse(fs.readFileSync(resultPath, 'utf-8'))
  console.log('\n========== PROFILE RESULTS ==========')
  for (const [name, p] of Object.entries(data)) {
    const pdata = p as any
    const totalMs = (BigInt(pdata.totalNs) / 1000000n).toString()
    const avgUs = (BigInt(pdata.totalNs) / BigInt(Math.max(pdata.callCount, 1)) / 1000n).toString()
    console.log(`  ${name}: ${pdata.callCount} calls, ${totalMs}ms total, ${avgUs}µs avg`)
  }
} else {
  console.log('\n[profile] WARNING: No profile data at', resultPath)
  console.log('[profile] This means the cucumber subprocess exited without calling the profiled functions.')
  console.log('[profile] Check if step-definitions-profile.ts imports are resolved correctly.')
}

// Cleanup happens via process.on('exit')
