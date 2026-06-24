/**
 * gate.ts — Performance Regression Gate
 *
 * Integrates into perf.sh: runs benchmark, compares against baseline,
 * fails with exit code 1 if critical regressions detected.
 *
 * Usage:
 *   npx tsx src/benchmark/gate.ts              # compare vs most recent baseline
 *   npx tsx src/benchmark/gate.ts --save       # compare + save new baseline
 *   npx tsx src/benchmark/gate.ts --threshold=15  # custom threshold (default 10)
 */

import { perf } from './runner'
import { BenchmarkBaseline, loadBaseline, saveBaseline, hasCriticalRegression, compareResults } from './baseline-store'
import { formatComparisonReport } from './reporter'
import * as fs from 'fs'
import * as path from 'path'

const BASELINE_DIR = path.resolve(__dirname, '../../benchmark/baselines')

interface GateOptions {
  /** Regression threshold (percent). Default: 30 (perf mode has high CPU variance) */
  threshold: number
  /** Whether to save the new baseline after successful gate */
  save: boolean
}

function findLatestBaseline(): string | null {
  if (!fs.existsSync(BASELINE_DIR)) return null
  const files = fs.readdirSync(BASELINE_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse()
  return files.length > 0 ? path.join(BASELINE_DIR, files[0]) : null
}

async function main() {
  const opts: GateOptions = {
    threshold: parseInt(process.argv.find(a => a.startsWith('--threshold='))?.split('=')[1] || '30', 10),
    save: process.argv.includes('--save'),
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
  console.log(`   Threshold: ${opts.threshold}%\n`)

  const report = formatComparisonReport(current, previous, opts.threshold)
  console.log(report)

  const rows = compareResults(current, previous, opts.threshold)

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
