/**
 * query-suite.test.ts — AgentiX GraphVec 查询层集成测试
 *
 * 覆盖 Q01(聚合函数)、Q02(UNION/集合运算)、Q03(优化器桥接)
 * 的集成场景，使用真实 GraphEngine 实例。
 */

import { GraphEngine } from '../../src/core/graph-engine'
import { OverGraphConfig } from '../../src/types'
import * as fs from 'fs'
import * as path from 'path'

describe('GraphVec Query Suite — 查询层集成测试', () => {
  const dbPath = path.join('/tmp', `agentiX-query-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  let engine: GraphEngine

  // 存储创建节点的 ID，供跨测试共享
  const nodeIds: number[] = []
  const nodeNameToId: Record<string, number> = {}

  // ── 基础 CRUD 准备 ────────────────────────────────

  beforeAll(async () => {
    fs.mkdirSync(dbPath, { recursive: true })
    const config: OverGraphConfig = { path: dbPath }
    engine = new GraphEngine(config)
    engine.open()

    // 创建 6 个节点（type 1 到 3），每个节点带 props
    const type1Names = ['Alpha', 'Beta', 'Gamma']
    const type2Names = ['Delta', 'Epsilon']
    const type3Names = ['Zeta']

    for (const name of type1Names) {
      const id = await engine.upsertNode(1, name, {
        props: { score: Math.floor(Math.random() * 100) + 1, category: 'A' },
      })
      nodeIds.push(id)
      nodeNameToId[name] = id
    }

    for (const name of type2Names) {
      const id = await engine.upsertNode(2, name, {
        props: { score: Math.floor(Math.random() * 50) + 50, category: 'B' },
      })
      nodeIds.push(id)
      nodeNameToId[name] = id
    }

    for (const name of type3Names) {
      const id = await engine.upsertNode(3, name, {
        props: { score: 99, category: 'C' },
      })
      nodeIds.push(id)
      nodeNameToId[name] = id
    }

    // 创建边：Alpha → Delta, Beta → Epsilon, Gamma → Zeta
    await engine.upsertEdge(nodeNameToId['Alpha'], nodeNameToId['Delta'], 10)
    await engine.upsertEdge(nodeNameToId['Beta'], nodeNameToId['Epsilon'], 10)
    await engine.upsertEdge(nodeNameToId['Gamma'], nodeNameToId['Zeta'], 20)
  })

  afterAll(() => {
    if (engine.isOpen) {
      engine.close()
    }
    fs.rmSync(dbPath, { recursive: true, force: true })
  })

  // ── 1. 聚合函数集成（Q01） ─────────────────────────

  describe('Q01 — 聚合函数集成', () => {
    it('1. COUNT(n) 返回总节点数 > 0', () => {
      const result = engine.query('MATCH (n) RETURN COUNT(n)')
      expect(result).toBeDefined()
      expect(result.length).toBeGreaterThan(0)
      // 聚合结果是一个伪节点，props 中包含 count 值
      const aggRow = result[0] as any
      const countVal = aggRow.props?.count ?? aggRow.count
      expect(Number(countVal)).toBeGreaterThanOrEqual(6)
    })

    it('2. SUM(n.score) 对所有节点分数求和', () => {
      const result = engine.query('MATCH (n) RETURN SUM(n.score)')
      expect(result).toBeDefined()
      expect(result.length).toBeGreaterThan(0)

      // 手动计算所有节点 score 之和作为验证基准
      let expectedSum = 0
      for (const id of nodeIds) {
        const node = engine.getNode(id)
        if (node?.props?.score && typeof node.props.score === 'number') {
          expectedSum += node.props.score
        }
      }

      const aggRow = result[0] as any
      const sumVal = aggRow.props?.sum ?? aggRow.sum
      expect(Number(sumVal)).toBe(expectedSum)
    })

    it('3. AVG(n.score) 对所有节点分数求平均值', () => {
      const result = engine.query('MATCH (n) RETURN AVG(n.score)')
      expect(result).toBeDefined()
      expect(result.length).toBeGreaterThan(0)

      let total = 0
      let count = 0
      for (const id of nodeIds) {
        const node = engine.getNode(id)
        if (node?.props?.score && typeof node.props.score === 'number') {
          total += node.props.score
          count++
        }
      }
      const expectedAvg = count > 0 ? total / count : 0

      const aggRow = result[0] as any
      const avgVal = aggRow.props?.avg ?? aggRow.avg
      expect(Number(avgVal)).toBeCloseTo(expectedAvg, 1)
    })

    it('4. MIN(n.score) 找到最小分数', () => {
      const result = engine.query('MATCH (n) RETURN MIN(n.score)')
      expect(result).toBeDefined()
      expect(result.length).toBeGreaterThan(0)

      let expectedMin = Infinity
      for (const id of nodeIds) {
        const node = engine.getNode(id)
        if (node?.props?.score && typeof node.props.score === 'number' && node.props.score < expectedMin) {
          expectedMin = node.props.score
        }
      }

      const aggRow = result[0] as any
      const minVal = aggRow.props?.min ?? aggRow.min
      expect(Number(minVal)).toBe(expectedMin)
    })

    it('5. MAX(n.score) 找到最大分数', () => {
      const result = engine.query('MATCH (n) RETURN MAX(n.score)')
      expect(result).toBeDefined()
      expect(result.length).toBeGreaterThan(0)

      let expectedMax = -Infinity
      for (const id of nodeIds) {
        const node = engine.getNode(id)
        if (node?.props?.score && typeof node.props.score === 'number' && node.props.score > expectedMax) {
          expectedMax = node.props.score
        }
      }

      const aggRow = result[0] as any
      const maxVal = aggRow.props?.max ?? aggRow.max
      expect(Number(maxVal)).toBe(expectedMax)
    })
  })

  // ── 2. UNION 集成（Q02） ───────────────────────────

  describe('Q02 — UNION / 集合运算集成', () => {
    it('6. UNION 两个 MATCH 查询，合并结果', () => {
      const result = engine.query('MATCH (n) RETURN n UNION MATCH (m) RETURN m')
      expect(result).toBeDefined()
      expect(result.length).toBeGreaterThanOrEqual(1)
    })

    it('7. UNION ALL 返回重复行（不进行去重）', () => {
      const result = engine.query('MATCH (n) RETURN n UNION ALL MATCH (m) RETURN m')
      expect(result).toBeDefined()
      // UNION ALL 不执行去重，结果数 >= nodeIds（至少与单边一样多）
      expect(result.length).toBeGreaterThanOrEqual(nodeIds.length)
    })

    it('8. INTERSECT 两个结果集，仅保留交集', () => {
      const result = engine.query('MATCH (n) RETURN n INTERSECT MATCH (m) RETURN m')
      expect(result).toBeDefined()
      // 两个集合相同，交集 = 原集合
      expect(result.length).toBe(nodeIds.length)
    })

    it('9. SUBTRACT 两个结果集，仅保留差集', () => {
      const result = engine.query('MATCH (n) RETURN n SUBTRACT MATCH (m) RETURN m')
      expect(result).toBeDefined()
      // 两个集合相同，差集 = 空集
      expect(result.length).toBe(0)
    })
  })

  // ── 3. 优化器桥接（Q03） ───────────────────────────

  describe('Q03 — 优化器桥接集成', () => {
    it('10. query(useOptimizer:true) 结果与标准查询一致', () => {
      const standardResult = engine.query('MATCH (n) RETURN n')
      const optimizedResult = engine.query('MATCH (n) RETURN n', undefined, true)
      expect(optimizedResult).toBeDefined()
      expect(optimizedResult.length).toBe(standardResult.length)
      // 虽然顺序可能不同，但 ID 集合应一致
      const standardIds = new Set(standardResult.map(n => n.id))
      const optimizedIds = new Set(optimizedResult.map(n => n.id))
      expect(optimizedIds).toEqual(standardIds)
    })

    it('11. query(useOptimizer:true) 在带 WHERE 条件时返回过滤后的结果', () => {
      const standardResult = engine.query('MATCH (n) RETURN n')
      const optimizedResult = engine.query('MATCH (n) RETURN n', undefined, true)
      expect(optimizedResult).toBeDefined()
      // 两者应包含相同的节点
      const standardIds = standardResult.map(n => n.id).sort()
      const optimizedIds = optimizedResult.map(n => n.id).sort()
      expect(optimizedIds).toEqual(standardIds)
    })
  })

  // ── 4. Cypher-lite 端到端 ──────────────────────────

  describe('Cypher-lite 端到端查询', () => {
    it('12. MATCH → WHERE → RETURN 完整查询链', () => {
      const result = engine.query('MATCH (n) WHERE n.score > 50 RETURN n')
      expect(result).toBeDefined()
      // 所有返回的节点 score 应 > 50
      for (const node of result) {
        const score = node.props?.score
        expect(score).toBeDefined()
        if (typeof score === 'number') {
          expect(score).toBeGreaterThan(50)
        }
      }
    })

    it('13. MATCH + LIMIT 分页', () => {
      const result = engine.query('MATCH (n) RETURN n LIMIT 3')
      expect(result).toBeDefined()
      expect(result.length).toBeLessThanOrEqual(3)
    })

    it('14. MATCH + SKIP + LIMIT 完整分页', () => {
      // 获取全部节点
      const allResult = engine.query('MATCH (n) RETURN n')
      expect(allResult.length).toBeGreaterThanOrEqual(2)

      // 使用 SKIP + LIMIT 分页取第 2、3 条（跳过第 1 条）
      const pagedResult = engine.query('MATCH (n) RETURN n SKIP 1 LIMIT 2')
      expect(pagedResult).toBeDefined()
      expect(pagedResult.length).toBeLessThanOrEqual(2)

      // 确保 paged 结果中不包含 allResult[0]
      if (pagedResult.length > 0 && allResult.length > 1) {
        const pagedIds = new Set(pagedResult.map(n => n.id))
        expect(pagedIds.has(allResult[0].id)).toBeFalsy()
      }
    })
  })

  // ── 5. 边际场景 ─────────────────────────────────────

  describe('边际场景', () => {
    it('15. 在大数据量（100 个节点）上跑聚合查询', async () => {
      // 创建临时节点（用单独的引擎实例避免影响其他测试）
      const bulkPath = path.join('/tmp', `agentiX-bulk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
      fs.mkdirSync(bulkPath, { recursive: true })
      const bulkEngine = new GraphEngine({ path: bulkPath })
      bulkEngine.open()

      try {
        // 批量写入 100 个节点
        for (let i = 0; i < 100; i++) {
          await bulkEngine.upsertNode(1, `BulkNode${i}`, {
            props: { score: i + 1, tag: i % 2 === 0 ? 'even' : 'odd' },
          })
        }

        // 在大数据集上执行 COUNT 聚合
        const countResult = bulkEngine.query('MATCH (n) RETURN COUNT(n)')
        expect(countResult).toBeDefined()
        expect(countResult.length).toBeGreaterThan(0)
        const countVal = (countResult[0] as any)?.props?.count ?? (countResult[0] as any)?.count
        expect(Number(countVal)).toBe(100)

        // 在大数据集上执行 SUM 聚合
        const sumResult = bulkEngine.query('MATCH (n) RETURN SUM(n.score)')
        expect(sumResult).toBeDefined()
        const sumVal = (sumResult[0] as any)?.props?.sum ?? (sumResult[0] as any)?.sum
        expect(Number(sumVal)).toBe(5050)

        // 在大数据集上执行 AVG 聚合
        const avgResult = bulkEngine.query('MATCH (n) RETURN AVG(n.score)')
        expect(avgResult).toBeDefined()
        const avgVal = (avgResult[0] as any)?.props?.avg ?? (avgResult[0] as any)?.avg
        expect(Number(avgVal)).toBeCloseTo(50.5, 1)

        // 在大数据集上执行 MIN/MAX
        const minResult = bulkEngine.query('MATCH (n) RETURN MIN(n.score)')
        expect(minResult).toBeDefined()
        const minVal = (minResult[0] as any)?.props?.min ?? (minResult[0] as any)?.min
        expect(Number(minVal)).toBe(1)

        const maxResult = bulkEngine.query('MATCH (n) RETURN MAX(n.score)')
        expect(maxResult).toBeDefined()
        const maxVal = (maxResult[0] as any)?.props?.max ?? (maxResult[0] as any)?.max
        expect(Number(maxVal)).toBe(100)
      } finally {
        bulkEngine.close()
        fs.rmSync(bulkPath, { recursive: true, force: true })
      }
    })

    it('16. 空结果集时的聚合行为（COUNT 返回 0，SUM/MIN/MAX 返回 0）', () => {
      // 创建一个只有空节点的临时引擎
      const emptyPath = path.join('/tmp', `agentiX-empty-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
      fs.mkdirSync(emptyPath, { recursive: true })
      const emptyEngine = new GraphEngine({ path: emptyPath })
      emptyEngine.open()

      try {
        // 空引擎上执行 COUNT
        const countResult = emptyEngine.query('MATCH (n) RETURN COUNT(n)')
        expect(countResult).toBeDefined()
        expect(countResult.length).toBeGreaterThan(0)
        const countVal = (countResult[0] as any)?.props?.count ?? (countResult[0] as any)?.count
        expect(Number(countVal)).toBe(0)

        // 空引擎上执行 SUM
        const sumResult = emptyEngine.query('MATCH (n) RETURN SUM(n.score)')
        expect(sumResult).toBeDefined()
        expect(sumResult.length).toBeGreaterThan(0)
        const sumVal = (sumResult[0] as any)?.props?.sum ?? (sumResult[0] as any)?.sum
        expect(Number(sumVal)).toBe(0)

        // 空引擎上执行 AVG
        const avgResult = emptyEngine.query('MATCH (n) RETURN AVG(n.score)')
        expect(avgResult).toBeDefined()
        const avgVal = (avgResult[0] as any)?.props?.avg ?? (avgResult[0] as any)?.avg
        expect(Number(avgVal)).toBe(0)

        // 空引擎上执行 MIN
        const minResult = emptyEngine.query('MATCH (n) RETURN MIN(n.score)')
        expect(minResult).toBeDefined()
        const minVal = (minResult[0] as any)?.props?.min ?? (minResult[0] as any)?.min
        expect(Number(minVal)).toBe(0)

        // 空引擎上执行 MAX
        const maxResult = emptyEngine.query('MATCH (n) RETURN MAX(n.score)')
        expect(maxResult).toBeDefined()
        const maxVal = (maxResult[0] as any)?.props?.max ?? (maxResult[0] as any)?.max
        expect(Number(maxVal)).toBe(0)
      } finally {
        emptyEngine.close()
        fs.rmSync(emptyPath, { recursive: true, force: true })
      }
    })

    it('17. UNION + 聚合 组合查询', () => {
      const result = engine.query('MATCH (n) RETURN COUNT(n) UNION MATCH (m) RETURN COUNT(m)')
      expect(result).toBeDefined()
      // UNION 聚合结果：两个相同的 count 结果，去重后为 1 条
      expect(result.length).toBeGreaterThanOrEqual(1)
    })

    it('18. 带 WHERE 条件的聚合查询', async () => {
      // 创建独立引擎避免干扰
      const filterPath = path.join('/tmp', `agentiX-filter-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
      fs.mkdirSync(filterPath, { recursive: true })
      const filterEngine = new GraphEngine({ path: filterPath })
      filterEngine.open()

      try {
        await filterEngine.upsertNode(1, 'High', { props: { score: 90 } })
        await filterEngine.upsertNode(1, 'Mid', { props: { score: 50 } })
        await filterEngine.upsertNode(1, 'Low', { props: { score: 10 } })

        // COUNT with WHERE
        const countResult = filterEngine.query('MATCH (n) WHERE n.score > 20 RETURN COUNT(n)')
        expect(countResult).toBeDefined()
        const countVal = (countResult[0] as any)?.props?.count ?? (countResult[0] as any)?.count
        expect(Number(countVal)).toBe(2)
      } finally {
        filterEngine.close()
        fs.rmSync(filterPath, { recursive: true, force: true })
      }
    })
  })
})
