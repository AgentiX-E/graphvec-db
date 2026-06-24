/**
 * runner.ts — Unified Benchmark Runner
 *
 * Two modes:
 *   perf: Quick smoke test, runs representative subset (~30s)
 *   full: Run all benchmark files, output full baseline JSON (~10min)
 *
 * Usage:
 *   import { perf, full, compareBaseline } from './runner'
 */

import { execSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { BenchmarkBaseline, BenchmarkResult, loadBaseline, saveBaseline } from './baseline-store'
import { formatMarkdownReport, formatComparisonReport } from './reporter'

const PROJECT_ROOT = path.resolve(__dirname, '../..')

/** Perf‑mode benchmark files (representative subset, ~30s total) */
const PERF_FILES: string[] = [
  'src/benchmark/expression-benchmark.spec.ts',
  'src/benchmark/parse-benchmark.spec.ts',
  'src/benchmark/format-benchmark.spec.ts',
  'src/benchmark/dml-benchmark.spec.ts',
  // Note: query-benchmark uses custom console.table output (not vitest bench API)
  // It's not parsed by vitest bench parser; results are captured in full mode only.
]

/** Full‑mode benchmark files — exclude huge files that risk timeout */
const FULL_FILES: string[] = [
  'src/benchmark/expression-benchmark.spec.ts',
  'src/benchmark/query-benchmark.spec.ts',
  'src/benchmark/ldbc-snb.spec.ts',
  'src/benchmark/ldbc-queries.spec.ts',
  'src/benchmark/label-str-index.spec.ts',
]

/** Huge benchmark files (run separately with longer timeout or skip in full) */
const FULL_LARGE_FILES: string[] = [
  'src/benchmark/latency.spec.ts',       // 117K, 15+ tests
  'src/benchmark/scalability.spec.ts',   // 105K
  'src/benchmark/throughput.spec.ts',    // 85K
  'src/benchmark/stability.spec.ts',     // 231K — SKIP (long running stress test)
]

/**
 * Parse console.table output from query-benchmark.spec.ts.
 * Table format: │ Name │ ops/sec │ p50(ms) │ p95(ms) │ p99(ms) │ Mem Δ (MB) │
 */
function parseTableFormat(output: string): BenchmarkResult[] {
  const results: BenchmarkResult[] = []
  const lines = output.split('\n')
  for (const line of lines) {
    if (!line.includes('│')) continue
    const parts = line.split('│').filter(p => p.trim().length > 0)
    if (parts.length < 6) continue
    const name = parts[0].trim()
    if (!name || name === 'Scenario' || name.includes('─')) continue
    const ops = parseFloat(parts[1].replace(/,/g, ''))
    if (isNaN(ops) || ops <= 0) continue
    results.push({
      name,
      opsPerSecond: Math.round(ops),
      samples: 0,
      durationMs: 0,
      timestamp: Date.now(),
    })
  }
  return results
}

/** Extract benchmark metrics from vitest console output */
function parseBenchMetrics(output: string): BenchmarkResult[] {
  const results: BenchmarkResult[] = []

  // Format 1: vitest bench API output
  const lineRegex = /^\s{2,}(\S.+) \s+([\d,]+)\s+ops\/s\s+\((\d+)x\s+in\s+([\d.]+)ms\)/gm
  let match: RegExpExecArray | null
  while ((match = lineRegex.exec(output)) !== null) {
    const name = match[1].trim()
    const ops = parseInt(match[2].replace(/,/g, ''), 10)
    const samples = parseInt(match[3], 10)
    const durationMs = parseFloat(match[4])
    results.push({ name, opsPerSecond: ops, samples, durationMs, timestamp: Date.now() })
  }

  // Format 2: console.table output (query-benchmark style)
  results.push(...parseTableFormat(output))

  return results
}

import { type ExecSyncOptionsWithBufferEncoding } from 'child_process'

export async function perf(): Promise<BenchmarkBaseline> {
  const allResults: BenchmarkResult[] = []
  // PERF_FILES 合并成一个 vitest 命令（避免 ANTLR 多次初始化）
  const files = PERF_FILES.join(' ')
  const cmd = `npx vitest run ${files} --no-coverage 2>&1`
  const out = execSync(cmd, { cwd: PROJECT_ROOT, timeout: 180_000, encoding: 'utf-8' })
  const metrics = parseBenchMetrics(out)
  allResults.push(...metrics)

  const baseline: BenchmarkBaseline = {
    createdAt: Date.now(),
    mode: 'perf',
    gitHash: execSync('git rev-parse HEAD', { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim(),
    results: allResults,
  }

  const md = formatMarkdownReport(baseline)
  console.log('\n' + md)

  return baseline
}

export async function full(): Promise<BenchmarkBaseline> {
  const allResults: BenchmarkResult[] = []
  const allFiles = [...FULL_FILES, ...FULL_LARGE_FILES]

  for (const file of allFiles) {
    const fullPath = path.resolve(PROJECT_ROOT, file)
    if (!fs.existsSync(fullPath)) {
      console.warn(`[full] WARN: file not found, skipping: ${fullPath}`)
      continue
    }
    const cmd = `npx vitest run ${file} --no-coverage 2>&1`
    try {
      const out = execSync(cmd, { cwd: PROJECT_ROOT, timeout: 300_000, encoding: 'utf-8' })
      const metrics = parseBenchMetrics(out)
      allResults.push(...metrics)
      console.log(`[full] OK: ${file} (${metrics.length} metrics)`)
    } catch (e: any) {
      console.warn(`[full] WARN: ${file} failed (timeout or error): ${e.message?.slice(0, 80)}`)
    }
  }

  const baseline: BenchmarkBaseline = {
    createdAt: Date.now(),
    mode: 'full',
    gitHash: execSync('git rev-parse HEAD', { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim(),
    results: metrics,
  }

  // Save baseline to file
  const baselinePath = path.resolve(PROJECT_ROOT, `benchmark/baselines/${new Date().toISOString().slice(0, 10)}.json`)
  const dir = path.dirname(baselinePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  saveBaseline(baselinePath, baseline)

  const md = formatMarkdownReport(baseline)
  console.log('\n' + md)
  console.log(`\n[full] Baseline saved to: ${baselinePath}`)

  return baseline
}

export function compareBaseline(current: BenchmarkBaseline, previous: BenchmarkBaseline): string {
  return formatComparisonReport(current, previous)
}

export { BenchmarkBaseline, BenchmarkResult }
