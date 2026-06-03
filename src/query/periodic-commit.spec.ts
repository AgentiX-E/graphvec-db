/**
 * period-commit.spec.ts — USING PERIODIC COMMIT 语法解析与规划测试
 *
 * 测试清单（≥4）：
 * 1. USING PERIODIC COMMIT 500 解析 → plan.periodicCommit.batchSize === 500 ✅
 * 2. USING PERIODIC COMMIT（无数字）→ plan.periodicCommit.batchSize undefined ✅
 * 3. 没有 USING PERIODIC COMMIT → plan.periodicCommit undefined ✅
 * 4. USING PERIODIC COMMIT + DML（如 CREATE）→ 正确传递 ✅
 * 5. (额外) USING PERIODIC COMMIT + MATCH + RETURN → 不干扰查询体 ✅
 */
import { describe, it, expect } from 'vitest'
import { parseQuery } from './query-engine'

// ── 1. 解析 USING PERIODIC COMMIT 500 ───────────────────

describe('USING PERIODIC COMMIT — 语法解析', () => {
  it('解析 USING PERIODIC COMMIT 500 — plan.periodicCommit.batchSize === 500', () => {
    const plan = parseQuery('USING PERIODIC COMMIT 500 MATCH (n:Person) RETURN n')
    expect(plan.periodicCommit).toBeDefined()
    expect(plan.periodicCommit!.batchSize).toBe(500)
  })

  it('解析 USING PERIODIC COMMIT（无数字）— batchSize 为 undefined', () => {
    const plan = parseQuery('USING PERIODIC COMMIT MATCH (n) RETURN n')
    expect(plan.periodicCommit).toBeDefined()
    expect(plan.periodicCommit!.batchSize).toBeUndefined()
  })

  it('无 USING PERIODIC COMMIT — periodicCommit 为 undefined', () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n.name')
    expect(plan.periodicCommit).toBeUndefined()
  })

  it('USING PERIODIC COMMIT + CREATE — 正确传递 batchSize', () => {
    const plan = parseQuery("USING PERIODIC COMMIT 100 CREATE (n:Test {name: 'foo'})")
    expect(plan.periodicCommit).toBeDefined()
    expect(plan.periodicCommit!.batchSize).toBe(100)
    expect(plan.type).toBe('CREATE')
  })

  it('USING PERIODIC COMMIT 不干扰查询体 — match/return 正常', () => {
    const plan = parseQuery("USING PERIODIC COMMIT 50 MATCH (n:Person) WHERE n.age > 30 RETURN n.name")
    expect(plan.periodicCommit!.batchSize).toBe(50)
    expect(plan.scanLabel).toBe('Person')
    expect(plan.returnColumns).toContain('name')
    expect(plan.filters.length).toBeGreaterThan(0)
  })
})
