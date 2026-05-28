/**
 * Benchmark Runner for AgentiX GraphVec
 *
 * Runs all suites in test/benchmark/suites/ and reports:
 *   - ops/sec, margin of error, sample count
 *   - P50 / P99 latency (for query benchmarks)
 *   - Pass/fail against acceptance thresholds
 *
 * Exit code: 0 = all pass, 1 = any failure
 */
import Benchmark from 'benchmark'
import { createInsertBenchmark } from './suites/insert-bench.js'
import { createQueryBenchmark } from './suites/query-bench.js'
import { createScanBenchmark } from './suites/scan-bench.js'

// ── Thresholds ──
const THRESHOLDS: Record<string, { minOps?: number; maxP99Ms?: number }> = {
  'Insert':          { minOps: 1000 },
  'Query':           { maxP99Ms: 200 },
  'Scan':            { minOps: 10 },
}

interface SuiteResult {
  name: string
  ops: number
  rme: number        // relative margin of error (%)
  samples: number
  p50: number        // ms
  p99: number        // ms
  pass: boolean
  failReason: string
}

const results: SuiteResult[] = []

function runSuite(suite: Benchmark.Suite): Promise<void> {
  return new Promise((resolve, reject) => {
    const name = suite.name
    let ops = 0
    let rme = 0
    let samples = 0
    let p50 = 0
    let p99 = 0

    suite
      .on('cycle', (event: Benchmark.Event) => {
        const bench = event.target as Benchmark
        if (bench.error) {
          console.error(`  ✗ ${bench.name}: ERROR — ${bench.error.message}`)
          return
        }

        console.log(`  ${bench}`)
        ops = bench.hz!
        rme = bench.stats?.rme ?? 0
        samples = bench.stats?.sample.length ?? 0

        // hz is ops/sec → ms/op = 1000/hz
        const msPerOp = 1000 / ops
        p50 = msPerOp
        p99 = msPerOp * 1.5  // rough estimate since benchmark.js doesn't give percentiles directly

        // For the query suite, use async deferred timing
        if (bench.name.includes('shortestPath') && bench.stats?.sample) {
          const sorted = [...bench.stats.sample].sort((a, b) => a - b)
          p50 = sorted[Math.floor(sorted.length * 0.5)] * 1000 // convert seconds to ms
          p99 = sorted[Math.floor(sorted.length * 0.99)] * 1000
        }
      })
      .on('complete', () => {
        const threshold = THRESHOLDS[name] ?? {}
        const failReason: string[] = []

        if (threshold.minOps !== undefined && ops < threshold.minOps) {
          failReason.push(`ops/sec (${ops.toFixed(1)}) < min (${threshold.minOps})`)
        }
        if (threshold.maxP99Ms !== undefined && p99 > threshold.maxP99Ms) {
          failReason.push(`P99 (${p99.toFixed(2)}ms) > max (${threshold.maxP99Ms}ms)`)
        }

        const pass = failReason.length === 0
        results.push({ name, ops, rme, samples, p50, p99, pass, failReason: failReason.join('; ') })

        const passIcon = pass ? '✓' : '✗'
        const msg = pass
          ? `${passIcon} ${name} suite PASSED`
          : `${passIcon} ${name} suite FAILED: ${failReason.join(', ')}`
        console.log(`  => ${msg}\n`)
        resolve()
      })
      .on('error', (err: Error) => {
        console.error(`  ✗ ${name} suite ERROR: ${err.message}`)
        results.push({ name, ops: 0, rme: 0, samples: 0, p50: 0, p99: 0, pass: false, failReason: err.message })
        resolve()
      })
      .run({ async: true })
  })
}

async function main(): Promise<number> {
  // Show benchmark.js version
  console.log(`Benchmark.js v${Benchmark.version}`)
  console.log('='.repeat(60))
  console.log('AgentiX GraphVec — Benchmark Suite')
  console.log('='.repeat(60) + '\n')

  const suites = [
    createInsertBenchmark(),
    createQueryBenchmark(),
    createScanBenchmark(),
  ]

  for (const suite of suites) {
    console.log(`Suite: ${suite.name}`)
    console.log('-'.repeat(40))
    await runSuite(suite)
  }

  // ── Summary ──
  console.log('='.repeat(60))
  console.log('SUMMARY')
  console.log('='.repeat(60))
  for (const r of results) {
    const status = r.pass ? 'PASS' : 'FAIL'
    console.log(`  [${status}] ${r.name}: ${r.ops.toFixed(1)} ops/sec ±${r.rme.toFixed(2)}% (${r.samples} samples)`)
    if (r.name !== 'Query') {
      console.log(`         ~${r.p50.toFixed(3)} ms/op`)
    } else {
      console.log(`         P50=${r.p50.toFixed(3)}ms  P99=${r.p99.toFixed(3)}ms`)
    }
  }

  const allPass = results.every(r => r.pass)
  console.log(`\nOverall: ${allPass ? 'ALL PASS ✓' : 'SOME FAILURES ✗'}`)

  return allPass ? 0 : 1
}

main()
  .then(code => {
    process.exit(code)
  })
  .catch(err => {
    console.error('FATAL:', err)
    process.exit(1)
  })
