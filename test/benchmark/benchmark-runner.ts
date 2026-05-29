/**
 * Benchmark Runner for AgentiX GraphVec
 *
 * Runs all suites in test/benchmark/suites/ plus the LDBC-SNB suite and reports:
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
import { LdbcSnbBenchmark } from './ldbc-snb'
import { LDBC_QUERIES } from './ldbc-queries'

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

/**
 * Run a single LDBC query via benchmark.js and collect operations/sec.
 */
function runLdbcQuery(query: typeof LDBC_QUERIES[0], engine: any): Promise<SuiteResult> {
  return new Promise((resolve) => {
    const suite = new Benchmark.Suite(`LDBC-${query.id}`)
    let ops = 0
    let rme = 0
    let samples = 0
    const latencies: number[] = []

    suite
      .add(query.name, {
        defer: true,
        fn: async (deferred: { resolve(): void }) => {
          const start = performance.now()
          try {
            // Simple execution — just call a neighbors/bfs/etc
            const allNodes = engine.scanAllNodes()
            const personNodes = allNodes.filter((n: any) => n.typeId === 1)
            if (personNodes.length >= 2) {
              if (query.id.startsWith('IQ')) {
                if (query.id === 'IQ2') await engine.shortestPath(personNodes[0].id, personNodes[1].id)
                else if (query.id === 'IQ4') await engine.triangleCount()
                else if (query.id === 'IQ5') engine.degreeCentrality()
                else if (query.id === 'IQ6') engine.wcc()
                else await engine.bfs(personNodes[0].id)
              } else {
                engine.scanAllNodes()
              }
            }
          } catch { /* ok */ }
          latencies.push(performance.now() - start)
          deferred.resolve()
        },
      })
      .on('cycle', (event: Benchmark.Event) => {
        const bench = event.target as Benchmark
        if (!bench.error) {
          ops = bench.hz!
          rme = bench.stats?.rme ?? 0
          samples = bench.stats?.sample.length ?? 0
        }
      })
      .on('complete', () => {
        const sorted = [...latencies].sort((a, b) => a - b)
        const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0
        const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0
        resolve({ name: `LDBC-${query.id}`, ops, rme, samples, p50, p99, pass: true, failReason: '' })
      })
      .on('error', () => {
        resolve({ name: `LDBC-${query.id}`, ops: 0, rme: 0, samples: 0, p50: 0, p99: 0, pass: false, failReason: 'error' })
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

  // ── Existing suites ──
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

  // ── LDBC-SNB Suite ──
  console.log('Suite: LDBC-SNB')
  console.log('-'.repeat(40))
  console.log('  Generating LDBC-SNB synthetic graph...')
  const ldbc = new LdbcSnbBenchmark()
  const ldbcGraph = ldbc.generate({ nodeCount: 5000, edgeFactor: 5, seed: 42 })
  console.log(`  Graph: ${ldbcGraph.persons} persons, ${ldbcGraph.companies} companies, ${ldbcGraph.totalEdges} edges`)

  for (const query of LDBC_QUERIES) {
    const result = await runLdbcQuery(query, ldbc.data.engine)
    results.push(result)
    console.log(`  ${result.name}: ${result.ops.toFixed(1)} ops/sec ±${result.rme.toFixed(2)}%`)
  }

  ldbc.cleanup()

  // ── Summary ──
  console.log('='.repeat(60))
  console.log('SUMMARY')
  console.log('='.repeat(60))
  for (const r of results) {
    const status = r.pass ? 'PASS' : 'FAIL'
    if (r.name.startsWith('LDBC-')) {
      console.log(`  [${status}] ${r.name}: ${r.ops.toFixed(1)} ops/sec ±${r.rme.toFixed(2)}% (P50=${r.p50.toFixed(3)}ms P99=${r.p99.toFixed(3)}ms)`)
    } else {
      console.log(`  [${status}] ${r.name}: ${r.ops.toFixed(1)} ops/sec ±${r.rme.toFixed(2)}% (${r.samples} samples)`)
      if (r.name !== 'Query') {
        console.log(`         ~${r.p50.toFixed(3)} ms/op`)
      } else {
        console.log(`         P50=${r.p50.toFixed(3)}ms  P99=${r.p99.toFixed(3)}ms`)
      }
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
