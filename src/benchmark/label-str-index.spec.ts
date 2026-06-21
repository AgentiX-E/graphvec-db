/**
 * label-str-index.spec.ts — _labelStrIndex 性能基准（spec 级可重复基线）
 *
 * 度量 _scanNodesByLabel 在不同数据集大小和 label 分布下的性能。
 * 用于锁定 _labelStrIndex 40x 加速（586ms → 15ms）为 CI 可重复基线。
 *
 * Baseline: commit c012426a (Phase 9)
 *
 * Usage:
 *   npx vitest run src/benchmark/label-str-index.spec.ts --no-coverage
 *
 * 注意：
 * - 冷启动（无 OS page cache）场景下首次 run 可能稍慢
 * - 断言阈值基于当前硬件（Linux x64，Node v24，NVMe SSD）
 * - 如果硬件变化，更新 docs/benchmark-baseline-20260621.md 中的断言阈值
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GraphEngine } from '../core/graph-engine'
import * as fs from 'fs'
import * as path from 'node:path'
import * as os from 'node:os'

// ── Constants ────────────────────────────────────────────────────
const TYPE_PERSON = 1
const TYPE_OTHER = 2

// ── State ────────────────────────────────────────────────────────
let engine: GraphEngine
let benchDir: string

function dbDir(): string {
  benchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bli-'))
  return path.join(benchDir, 'graph.db')
}

function cleanup(): void {
  if (engine) { try { engine.close() } catch { /* ignore */ } }
  if (benchDir) { try { fs.rmSync(benchDir, { recursive: true, force: true }) } catch { /* ignore */ } }
}

// ════════════════════════════════════════════════════════════════
// 100K 节点基准
// ════════════════════════════════════════════════════════════════
describe('_labelStrIndex — 100K 节点基准', () => {
  beforeAll(() => {
    engine = new GraphEngine({ path: dbDir() })
    engine.open()
    // Seed 100K 节点: 80K Person + 20K Other
    for (let i = 0; i < 80000; i++) {
      engine.upsertNode(TYPE_PERSON, 'p' + i, { props: { _label: 'Person', name: 'person-' + i, seq: i } })
    }
    for (let i = 0; i < 20000; i++) {
      engine.upsertNode(TYPE_OTHER, 'o' + i, { props: { _label: 'Other', tag: 'other-' + i } })
    }
  })

  afterAll(() => { cleanup() })

  it('_scanNodesByLabel("Person") on 100K (80K Person) — ≤1000ms', () => {
    const iterations = 5
    const times: number[] = []
    for (let r = 0; r < iterations; r++) {
      const t0 = performance.now()
      const nodes = engine._scanNodesByLabel('Person')
      const elapsed = performance.now() - t0
      times.push(elapsed)
      expect(nodes.length).toBe(80000) // 所有 Person 节点被召回
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length
    console.log(`  avg: ${avg.toFixed(2)} ms over ${iterations} runs (threshold: 1000ms)`)
    if (avg < 500) console.log(`  ✅ _labelStrIndex 加速有效 (<500ms)`)
    expect(avg).toBeLessThan(1000)
  })

  it('_scanNodesByLabel("NonExistent") on 100K — ≤1000ms', () => {
    const iterations = 5
    const times: number[] = []
    for (let r = 0; r < iterations; r++) {
      const t0 = performance.now()
      const nodes = engine._scanNodesByLabel('NonExistent')
      const elapsed = performance.now() - t0
      times.push(elapsed)
      expect(nodes.length).toBe(0)
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length
    console.log(`  avg: ${avg.toFixed(2)} ms over ${iterations} runs (threshold: 1000ms)`)
    expect(avg).toBeLessThan(1000)
  })

  it('_scanNodesByLabel("Other") on 100K (20K Other) — ≤500ms', () => {
    const iterations = 5
    const times: number[] = []
    for (let r = 0; r < iterations; r++) {
      const t0 = performance.now()
      const nodes = engine._scanNodesByLabel('Other')
      const elapsed = performance.now() - t0
      times.push(elapsed)
      expect(nodes.length).toBe(20000)
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length
    console.log(`  avg: ${avg.toFixed(2)} ms over ${iterations} runs (threshold: 500ms)`)
    expect(avg).toBeLessThan(500)
  })
})

// ════════════════════════════════════════════════════════════════
// 空库基准
// ════════════════════════════════════════════════════════════════
describe('_labelStrIndex — 空数据集', () => {
  beforeAll(() => {
    engine = new GraphEngine({ path: dbDir() })
    engine.open()
    // 不 seed 任何节点
  })

  afterAll(() => { cleanup() })

  it('_scanNodesByLabel on 0 nodes — ≤2ms', () => {
    const iterations = 10
    const times: number[] = []
    for (let r = 0; r < iterations; r++) {
      const t0 = performance.now()
      const nodes = engine._scanNodesByLabel('Anything')
      const elapsed = performance.now() - t0
      times.push(elapsed)
      expect(nodes.length).toBe(0)
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length
    console.log(`  avg: ${avg.toFixed(2)} ms over ${iterations} runs (threshold: 2ms)`)
    expect(avg).toBeLessThan(2)
  })
})

// ════════════════════════════════════════════════════════════════
// 混合 Label 基准（35K Person + 15K Other — 模拟 benchmark.sh 数据）
// ════════════════════════════════════════════════════════════════
describe('_labelStrIndex — 混合 Label', () => {
  beforeAll(() => {
    engine = new GraphEngine({ path: dbDir() })
    engine.open()
    for (let i = 0; i < 35000; i++) {
      engine.upsertNode(TYPE_PERSON, 'p' + i, { props: { _label: 'Person', name: 'person-' + i } })
    }
    for (let i = 0; i < 15000; i++) {
      engine.upsertNode(TYPE_OTHER, 'o' + i, { props: { _label: 'Other' } })
    }
  })

  afterAll(() => { cleanup() })

  it('_scanNodesByLabel("Person") on 50K (35K Person + 15K Other) — ≤800ms', () => {
    const iterations = 5
    const times: number[] = []
    for (let r = 0; r < iterations; r++) {
      const t0 = performance.now()
      const nodes = engine._scanNodesByLabel('Person')
      const elapsed = performance.now() - t0
      times.push(elapsed)
      expect(nodes.length).toBe(35000)
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length
    console.log(`  avg: ${avg.toFixed(2)} ms over ${iterations} runs (threshold: 800ms)`)
    expect(avg).toBeLessThan(800)
  })
})
