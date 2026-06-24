/**
 * baseline-store.ts — Baseline storage and comparison
 *
 * Baselines are JSON files stored in benchmark/baselines/YYYY-MM-DD.json.
 * Each baseline captures the output of a full benchmark run.
 */

import * as fs from 'fs'
import * as crypto from 'crypto'

export interface BenchmarkResult {
  name: string
  opsPerSecond: number
  samples: number
  durationMs: number
  timestamp: number
}

export interface BenchmarkBaseline {
  createdAt: number
  mode: 'perf' | 'full'
  gitHash: string
  results: BenchmarkResult[]
}

export function loadBaseline(filePath: string): BenchmarkBaseline {
  const raw = fs.readFileSync(filePath, 'utf-8')
  return JSON.parse(raw) as BenchmarkBaseline
}

export function saveBaseline(filePath: string, baseline: BenchmarkBaseline): void {
  const content = JSON.stringify(baseline, null, 2)
  fs.writeFileSync(filePath, content, 'utf-8')
}

export function hashBaseline(baseline: BenchmarkBaseline): string {
  return crypto.createHash('md5').update(JSON.stringify(baseline)).digest('hex').slice(0, 8)
}

export interface ComparisonRow {
  name: string
  currentOps: number
  previousOps: number
  changePercent: number
  regression: 'none' | 'warning' | 'critical'
}

export function compareResults(current: BenchmarkBaseline, previous: BenchmarkBaseline): ComparisonRow[] {
  const prevMap = new Map<string, number>()
  for (const r of previous.results) prevMap.set(r.name, r.opsPerSecond)

  const rows: ComparisonRow[] = []
  for (const r of current.results) {
    const prev = prevMap.get(r.name)
    if (prev === undefined) continue // new test, skip
    const change = ((r.opsPerSecond - prev) / prev) * 100
    let regression: 'none' | 'warning' | 'critical' = 'none'
    if (change < -10) regression = 'critical'
    else if (change < -5) regression = 'warning'
    rows.push({
      name: r.name,
      currentOps: r.opsPerSecond,
      previousOps: prev,
      changePercent: Math.round(change * 100) / 100,
      regression,
    })
  }
  return rows
}

export function hasCriticalRegression(rows: ComparisonRow[]): boolean {
  return rows.some(r => r.regression === 'critical')
}

export function hasAnyRegression(rows: ComparisonRow[]): boolean {
  return rows.some(r => r.regression !== 'none')
}
