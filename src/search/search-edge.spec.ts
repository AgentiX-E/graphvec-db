/**
 * search-edge.spec.ts — 搜索模块边界测试
 *
 * 新增测试（不修改已有 test）：
 * - 节点属性模糊搜索
 * - 全文搜索边界（null、空字符串）
 * - 按类型搜索
 * - 组合搜索条件
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { GraphEngine } from '../core/graph-engine'
import * as fs from 'fs'
import * as path from 'path'

const STRESS_DIR = path.join(__dirname, '../../test-data/edge')

function makeConfig(name: string) {
  const dir = path.join(STRESS_DIR, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(dir, { recursive: true })
  return { path: dir, denseVector: { dimension: 384 } }
}

function cleanup(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

describe('Search - Edge Cases', () => {
  describe('节点属性模糊搜索', () => {
    test('should find nodes by partial name match with scanAllNodes', async () => {
      const cfg = makeConfig('search-fuzzy-name')
      const engine = new GraphEngine(cfg)
      try {
        engine.open()
        await engine.upsertNode(1, 'alice', { props: { name: 'Alice Smith' } })
        await engine.upsertNode(2, 'bob', { props: { name: 'Bob Jones' } })
        await engine.upsertNode(1, 'charlie', { props: { name: 'Charlie Alice' } })

        const all = engine.scanAllNodes()
        // 通过属性过滤模拟模糊搜索
        const alice = all.filter(n => String(n.props.name || '').toLowerCase().includes('alice'))
        expect(alice.length).toBeGreaterThanOrEqual(1)
        expect(alice.some(n => n.name === 'alice')).toBe(true)
      } finally {
        engine.close()
        cleanup(cfg.path)
      }
    }, 30000)

    test('should find nodes by numeric property range', async () => {
      const cfg = makeConfig('search-num-range')
      const engine = new GraphEngine(cfg)
      try {
        engine.open()
        for (let i = 0; i < 20; i++) {
          await engine.upsertNode(1, `node-${i}`, { props: { age: 20 + i, score: i * 10 } })
        }
        const all = engine.scanAllNodes()
        const young = all.filter(n => Number(n.props.age) < 30)
        expect(young.length).toBe(10)
        const scored = all.filter(n => Number(n.props.score) > 100)
        expect(scored.length).toBe(9)
      } finally {
        engine.close()
        cleanup(cfg.path)
      }
    }, 30000)

    test('should search by boolean property', async () => {
      const cfg = makeConfig('search-bool-prop')
      const engine = new GraphEngine(cfg)
      try {
        engine.open()
        await engine.upsertNode(1, 'active1', { props: { active: true } })
        await engine.upsertNode(2, 'inactive1', { props: { active: false } })
        await engine.upsertNode(1, 'active2', { props: { active: true } })

        const all = engine.scanAllNodes()
        const active = all.filter(n => n.props.active === true)
        expect(active.length).toBe(2)
      } finally {
        engine.close()
        cleanup(cfg.path)
      }
    }, 30000)
  })

  describe('全文搜索边界', () => {
    test('should handle null property values without crashing', async () => {
      const cfg = makeConfig('search-null-prop')
      const engine = new GraphEngine(cfg)
      try {
        engine.open()
        await engine.upsertNode(1, 'null-node', { props: { name: null } })
        await engine.upsertNode(2, 'empty-node', { props: {} })

        const all = engine.scanAllNodes()
        expect(all.length).toBe(2)
        // 有 null 属性时 scanAllNodes 不应抛异常
      } finally {
        engine.close()
        cleanup(cfg.path)
      }
    }, 30000)

    test('should handle empty string property', async () => {
      const cfg = makeConfig('search-empty-string')
      const engine = new GraphEngine(cfg)
      try {
        engine.open()
        await engine.upsertNode(1, 'empty-name', { props: { name: '' } })
        await engine.upsertNode(2, 'regular', { props: { name: 'hello' } })

        const all = engine.scanAllNodes()
        expect(all.length).toBe(2)
      } finally {
        engine.close()
        cleanup(cfg.path)
      }
    }, 30000)

    test('should handle undefined property values', async () => {
      const cfg = makeConfig('search-undefined-prop')
      const engine = new GraphEngine(cfg)
      try {
        engine.open()
        await engine.upsertNode(1, 'undef-node')
        await engine.upsertNode(2, 'undef-node2', { props: { tag: undefined as any } })

        const all = engine.scanAllNodes()
        expect(all.length).toBe(2)
      } finally {
        engine.close()
        cleanup(cfg.path)
      }
    }, 30000)
  })

  describe('按类型搜索', () => {
    test('should search for nodes of a specific type using scanAllNodes', async () => {
      const cfg = makeConfig('search-by-type')
      const engine = new GraphEngine(cfg)
      try {
        engine.open()
        await engine.upsertNode(1, 'person-1', { props: { name: 'Alice' } })
        await engine.upsertNode(2, 'company-1', { props: { name: 'Acme' } })
        await engine.upsertNode(1, 'person-2', { props: { name: 'Bob' } })
        await engine.upsertNode(3, 'product-1', { props: { name: 'Widget' } })

        const all = engine.scanAllNodes()
        const persons = all.filter(n => n.type === 1)
        const companies = all.filter(n => n.type === 2)
        const products = all.filter(n => n.type === 3)

        expect(persons.length).toBe(2)
        expect(companies.length).toBe(1)
        expect(products.length).toBe(1)
      } finally {
        engine.close()
        cleanup(cfg.path)
      }
    }, 30000)

    test('should handle type with zero nodes', async () => {
      const cfg = makeConfig('search-type-empty')
      const engine = new GraphEngine(cfg)
      try {
        engine.open()
        await engine.upsertNode(5, 'only-node')
        const all = engine.scanAllNodes()
        const type99 = all.filter(n => n.type === 99)
        expect(type99.length).toBe(0)
      } finally {
        engine.close()
        cleanup(cfg.path)
      }
    }, 30000)

    test('should handle all nodes of same type', async () => {
      const cfg = makeConfig('search-all-same-type')
      const engine = new GraphEngine(cfg)
      try {
        engine.open()
        for (let i = 0; i < 10; i++) {
          await engine.upsertNode(7, `same-type-${i}`)
        }
        const all = engine.scanAllNodes()
        expect(all.length).toBe(10)
        expect(all.every(n => n.type === 7)).toBe(true)
      } finally {
        engine.close()
        cleanup(cfg.path)
      }
    }, 30000)
  })

  describe('组合搜索条件', () => {
    test('should combine type filter and property filter', async () => {
      const cfg = makeConfig('search-combo-filter')
      const engine = new GraphEngine(cfg)
      try {
        engine.open()
        await engine.upsertNode(1, 'alice', { props: { city: 'NYC', age: 30 } })
        await engine.upsertNode(1, 'bob', { props: { city: 'LA', age: 25 } })
        await engine.upsertNode(1, 'charlie', { props: { city: 'NYC', age: 35 } })
        await engine.upsertNode(2, 'acme-nyc', { props: { city: 'NYC' } })

        const all = engine.scanAllNodes()
        const nycPersons = all.filter(n => n.type === 1 && n.props.city === 'NYC')
        expect(nycPersons.length).toBe(2)
      } finally {
        engine.close()
        cleanup(cfg.path)
      }
    }, 30000)

    test('should combine node type and edge traversal', async () => {
      const cfg = makeConfig('search-combo-edges')
      const engine = new GraphEngine(cfg)
      try {
        engine.open()
        const alice = await engine.upsertNode(1, 'alice')
        const bob = await engine.upsertNode(2, 'bob')
        const charlie = await engine.upsertNode(1, 'charlie')
        await engine.upsertEdge(alice, bob, 10)
        await engine.upsertEdge(alice, charlie, 10)

        // Neighbors of alice
        const result = engine.neighbors(alice)
        // Filter neighbors that are of type 1 (Person)
        const personNeighbors = result.nodes.filter(n => n.type === 1)
        expect(personNeighbors.length).toBe(1) // charlie is type 1
        expect(result.nodes.filter(n => n.type === 2).length).toBe(1) // bob is type 2
      } finally {
        engine.close()
        cleanup(cfg.path)
      }
    }, 30000)

    test('should combine edge type and node property', async () => {
      const cfg = makeConfig('search-combo-edge-prop')
      const engine = new GraphEngine(cfg)
      try {
        engine.open()
        const a = await engine.upsertNode(1, 'a', { props: { dept: 'eng' } })
        const b = await engine.upsertNode(1, 'b', { props: { dept: 'eng' } })
        const c = await engine.upsertNode(1, 'c', { props: { dept: 'sales' } })
        await engine.upsertEdge(a, b, 10, { props: { relation: 'friend' } })
        await engine.upsertEdge(a, c, 10, { props: { relation: 'manager' } })

        const result = engine.neighbors(a)
        const engNeighbors = result.nodes.filter(n => n.props.dept === 'eng')
        expect(engNeighbors.length).toBe(1)
      } finally {
        engine.close()
        cleanup(cfg.path)
      }
    }, 30000)

    test('should filter edges by property value using getEdge', async () => {
      const cfg = makeConfig('search-edge-prop-filter')
      const engine = new GraphEngine(cfg)
      try {
        engine.open()
        const a = await engine.upsertNode(1, 'hub')
        const b = await engine.upsertNode(1, 'b')
        const c = await engine.upsertNode(1, 'c')
        const d = await engine.upsertNode(1, 'd')
        await engine.upsertEdge(a, b, 10, { props: { weight: 1 } })
        await engine.upsertEdge(a, c, 10, { props: { weight: 5 } })
        await engine.upsertEdge(a, d, 10, { props: { weight: 10 } })

        // Use getEdge which carries props
        const edge1 = engine.getEdge(a, b, 10)
        const edge2 = engine.getEdge(a, c, 10)
        const edge3 = engine.getEdge(a, d, 10)

        expect(edge1!.props.weight).toBe(1)
        expect(edge2!.props.weight).toBe(5)
        expect(edge3!.props.weight).toBe(10)
      } finally {
        engine.close()
        cleanup(cfg.path)
      }
    }, 30000)
  })
})
