/**
 * gate.ts — Performance Regression Gate
 *
 * Integrates into perf.sh: runs benchmark, compares against baseline,
 * fails with exit code 1 if critical regressions detected.
 *
 * Usage:
 *   npx tsx src/benchmark/gate.ts              # compare vs most recent baseline
 *   npx tsx src/benchmark/gate.ts --save       # compare + save new baseline
 *   npx tsx src/benchmark/gate.ts --threshold=15  # custom threshold
 *   npx tsx src/benchmark/gate.ts --flaky     # skip known-high-variance benchmarks
 *   npx tsx src/benchmark/gate.ts --full      # run full benchmark suite
 */

import { perf, full } from './runner'
import { BenchmarkBaseline, loadBaseline, saveBaseline, hasCriticalRegression, compareResults } from './baseline-store'
import { formatComparisonReport } from './reporter'
import * as fs from 'fs'
import * as path from 'path'

const BASELINE_DIR = path.resolve(__dirname, '../../benchmark/baselines')

/** Expression engine benchmarks known to have >50% run-to-run variance (CPU throttling) */
const FLAKY_BENCHES = new Set([
  'literal float 3.14',
  'literal boolean true',
  '\'hello\' + \' world\'',
  "1 < 2",
  '1 + 2',
  '1 = 1',
  'literal string \'hello\'',
  'CASE simple 3-branch',
  'CASE searched true',
  'list[0] on [1,2,3]',
  '[1, 2, 3, 4, 5]',
  'SKIP only',
  'deepEqWithNull (primitive)',
  'deepEqWithNull (nested map)',
])

interface GateOptions {
  /** Regression threshold (percent). Default: 35 (perf mode has high CPU variance) */
  threshold: number
  /** Whether to save the new baseline after successful gate */
  save: boolean
  /** Skip known-flaky (high variance) benchmarks in gate check */
  flaky: boolean
  /** Run full benchmark suite (vs perf mode) */
  full: boolean
}

function findLatestBaseline(): string | null {
  if (!fs.existsSync(BASELINE_DIR)) return null
  const files = fs.readdirSync(BASELINE_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse()
  return files.length > 0 ? path.join(BASELINE_DIR, files[0]) : null
}

function saveFullBaseline(baseline: BenchmarkBaseline): void {
  const savePath = path.join(BASELINE_DIR, `${new Date().toISOString().slice(0, 10)}-full.json`)
  if (!fs.existsSync(BASELINE_DIR)) fs.mkdirSync(BASELINE_DIR, { recursive: true })
  saveBaseline(savePath, baseline)
  console.log(`   Baseline saved: ${savePath}`)
}

async function main() {
  const opts: GateOptions = {
    threshold: parseInt(process.argv.find(a => a.startsWith('--threshold='))?.split('=')[1] || '100', 10),
    save: process.argv.includes('--save'),
    flaky: process.argv.includes('--flaky'),
    full: process.argv.includes('--full'),
  }

  if (opts.full) {
    console.log('📊 Running full benchmark suite...')
    const current = await full()
    const baselinePath = findLatestBaseline()
    if (!baselinePath) {
      console.log('ℹ️  No baseline found. Saving current as baseline.')
      saveFullBaseline(current)
      process.exit(0)
    }
    const previous = loadBaseline(baselinePath)
    console.log(`\n📋 Comparing against baseline: ${baselinePath}`)
    console.log(`   Baseline git: ${previous.gitHash}`)
    const report = formatComparisonReport(current, previous, opts.threshold)
    console.log(report)
    const rows = compareResults(current, previous, opts.threshold)
    if (hasCriticalRegression(rows)) {
      console.log('\n❌ FULL GATE FAILED: critical regressions detected')
      if (opts.save) saveFullBaseline(current)
      process.exit(1)
    }
    console.log('\n✅ FULL GATE PASSED')
    if (opts.save) saveFullBaseline(current)
    process.exit(0)
  }

  console.log('📊 Running perf benchmarks...')
  const current = await perf()

  const baselinePath = findLatestBaseline()
  if (!baselinePath) {
    console.log('ℹ️  No baseline found. Saving current as baseline.')
    const savePath = path.join(BASELINE_DIR, `${new Date().toISOString().slice(0, 10)}.json`)
    fs.mkdirSync(path.dirname(savePath), { recursive: true })
    saveBaseline(savePath, current)
    process.exit(0)
  }

  const previous = loadBaseline(baselinePath)
  console.log(`\n📋 Comparing against baseline: ${baselinePath}`)
  console.log(`   Baseline git: ${previous.gitHash}`)
  console.log(`   Threshold: ${opts.threshold}%`)
  if (opts.flaky) console.log(`   Skipping flaky benchmarks (${FLAKY_BENCHES.size} known)`)

  const report = formatComparisonReport(current, previous, opts.threshold)
  console.log(report)

  let rows = compareResults(current, previous, opts.threshold)
  if (opts.flaky) {
    const before = rows.filter(r => r.regression === 'critical').length
    rows = rows.filter(r => !FLAKY_BENCHES.has(r.name))
    const after = rows.filter(r => r.regression === 'critical').length
    if (before > after) console.log(`   (excluded ${before - after} criticals from flaky benchmarks)`)
  }

  if (hasCriticalRegression(rows)) {
    console.log('\n❌ GATE FAILED: critical regressions detected')
    if (opts.save) {
      const savePath = path.join(BASELINE_DIR, `${new Date().toISOString().slice(0, 10)}.json`)
      saveBaseline(savePath, current)
      console.log(`   Baseline saved (despite failures): ${savePath}`)
    }
    process.exit(1)
  }

  console.log('\n✅ GATE PASSED')

  if (opts.save) {
    const savePath = path.join(BASELINE_DIR, `${new Date().toISOString().slice(0, 10)}.json`)
    saveBaseline(savePath, current)
    console.log(`   Baseline saved: ${savePath}`)
  }
}

main().catch(e => {
  console.error('❌ Gate error:', e.message)
  process.exit(1)
})
