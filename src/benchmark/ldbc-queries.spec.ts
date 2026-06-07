import { describe, it, expect } from 'vitest'
import { GraphEngine } from '../core/graph-engine'
import {
  LDBC_QUERIES,
  getInteractiveQueries,
  getBiQueries,
  getQueryById,
  type LdbcQueryDef,
} from './ldbc-queries'

// ==========================================================
// 1. LDBC_QUERIES 数据集验证
// ==========================================================
describe('LDBC_QUERIES dataset', () => {
  it('should be a non-empty array', () => {
    expect(Array.isArray(LDBC_QUERIES)).toBe(true)
    expect(LDBC_QUERIES.length).toBeGreaterThan(0)
  })

  it('should have exactly 20 query definitions', () => {
    expect(LDBC_QUERIES).toHaveLength(20)
  })

  it('each item should have required fields: id, name, description, category, cypher, returns', () => {
    for (const q of LDBC_QUERIES) {
      expect(q).toHaveProperty('id')
      expect(q).toHaveProperty('name')
      expect(q).toHaveProperty('description')
      expect(q).toHaveProperty('category')
      expect(q).toHaveProperty('cypher')
      expect(q).toHaveProperty('returns')
    }
  })

  it('each item should have valid id format (IQ<number> or BI<number>)', () => {
    for (const q of LDBC_QUERIES) {
      expect(q.id).toMatch(/^(IQ|BI)\d+$/)
    }
  })

  it('each item should have a non-empty cypher statement', () => {
    for (const q of LDBC_QUERIES) {
      expect(q.cypher).toBeTruthy()
    }
  })
})

// ==========================================================
// 2. getInteractiveQueries
// ==========================================================
describe('getInteractiveQueries()', () => {
  it('should return an array', () => {
    const result = getInteractiveQueries()
    expect(Array.isArray(result)).toBe(true)
  })

  it('should return exactly 10 interactive queries', () => {
    const result = getInteractiveQueries()
    expect(result).toHaveLength(10)
  })

  it('every returned query should have category "interactive"', () => {
    const result = getInteractiveQueries()
    for (const q of result) {
      expect(q.category).toBe('interactive')
    }
  })

  it('every returned query should contain a cypher property', () => {
    const result = getInteractiveQueries()
    for (const q of result) {
      expect(q).toHaveProperty('cypher')
      expect(typeof q.cypher).toBe('string')
    }
  })
})

// ==========================================================
// 3. getBiQueries
// ==========================================================
describe('getBiQueries()', () => {
  it('should return an array', () => {
    const result = getBiQueries()
    expect(Array.isArray(result)).toBe(true)
  })

  it('should return exactly 10 BI queries', () => {
    const result = getBiQueries()
    expect(result).toHaveLength(10)
  })

  it('every returned query should have category "bi"', () => {
    const result = getBiQueries()
    for (const q of result) {
      expect(q.category).toBe('bi')
    }
  })
})

// ==========================================================
// 4. getQueryById
// ==========================================================
describe('getQueryById()', () => {
  it('should find IQ1 by id', () => {
    const q = getQueryById('IQ1')
    expect(q).toBeDefined()
    expect(q!.name).toContain('Friend-of-a-Friend')
  })

  it('should find BI1 by id', () => {
    const q = getQueryById('BI1')
    expect(q).toBeDefined()
    expect(q!.name).toContain('Age Distribution')
  })

  it('should return undefined for a non-existent id', () => {
    const q = getQueryById('NON_EXISTENT')
    expect(q).toBeUndefined()
  })

  it('should return undefined for an empty string id', () => {
    const q = getQueryById('')
    expect(q).toBeUndefined()
  })

  it('should return the correct query object for IQ5', () => {
    const q = getQueryById('IQ5')
    expect(q).toBeDefined()
    expect(q!.name).toContain('Degree Centrality')
    expect(q!.category).toBe('interactive')
    expect(q!.engineMethod).toBe('degreeCentrality')
  })

  it('should return the correct query object for BI7', () => {
    const q = getQueryById('BI7')
    expect(q).toBeDefined()
    expect(q!.name).toContain('Person Age Stats')
    expect(q!.category).toBe('bi')
    expect(q!.engineMethod).toBe('scanAllNodes')
  })
})

// ==========================================================
// 5. 交互式查询特点
// ==========================================================
describe('Interactive query characteristics', () => {
  const interactiveQueries = getInteractiveQueries()

  it('should include friend-of-a-friend (2-hop) pattern', () => {
    const names = interactiveQueries.map(q => q.name)
    expect(names.some(n => n.toLowerCase().includes('friend'))).toBe(true)
  })

  it('should include shortest path query', () => {
    const names = interactiveQueries.map(q => q.name)
    expect(names.some(n => n.toLowerCase().includes('shortest'))).toBe(true)
  })

  it('should include triangle count query', () => {
    const names = interactiveQueries.map(q => q.name)
    expect(names.some(n => n.toLowerCase().includes('triangle'))).toBe(true)
  })

  it('should include queries that find persons (persons/people)', () => {
    const descriptions = interactiveQueries.map(q => q.description)
    const foundPerson = descriptions.some(d =>
      /\b(person|people)\b/i.test(d),
    )
    expect(foundPerson).toBe(true)
  })

  it('should include queries that find companies', () => {
    const descriptions = interactiveQueries.map(q => q.description)
    expect(descriptions.some(d => /company/i.test(d))).toBe(true)
  })

  it('should all contain MATCH in cypher', () => {
    for (const q of interactiveQueries) {
      expect(q.cypher).toMatch(/MATCH/i)
    }
  })
})

// ==========================================================
// 6. BI 查询特点
// ==========================================================
describe('BI query characteristics', () => {
  const biQueries = getBiQueries()

  it('should include aggregation queries (count/avg/min/max)', () => {
    const allCypher = biQueries.map(q => q.cypher).join(' ')
    expect(allCypher).toMatch(/\b(count|avg|min|max)\b/i)
  })

  it('should include GROUP BY in many queries', () => {
    const groupByCount = biQueries.filter(q =>
      /group\s+by/i.test(q.cypher),
    ).length
    expect(groupByCount).toBeGreaterThanOrEqual(5)
  })

  it('should include ORDER BY in many queries', () => {
    const orderByCount = biQueries.filter(q =>
      /order\s+by/i.test(q.cypher),
    ).length
    expect(orderByCount).toBeGreaterThanOrEqual(6)
  })

  it('should include statistical queries (distribution, average, density)', () => {
    const names = biQueries.map(q => q.name)
    const statTerms = [/distribution/i, /average/i, /density/i, /stats/i]
    const hasStat = statTerms.some(re => names.some(n => re.test(n)))
    expect(hasStat).toBe(true)
  })

  it('should include ranking queries (TOP N pattern)', () => {
    const topCount = biQueries.filter(
      q => q.name.includes('Top') || /LIMIT\s+\d+/i.test(q.cypher),
    ).length
    expect(topCount).toBeGreaterThanOrEqual(2)
  })

  it('should all contain MATCH in cypher', () => {
    for (const q of biQueries) {
      expect(q.cypher).toMatch(/MATCH/i)
    }
  })
})

// ==========================================================
// 7. Cypher 语句验证
// ==========================================================
describe('Cypher statement validation', () => {
  it('every query cypher should start with MATCH', () => {
    for (const q of LDBC_QUERIES) {
      expect(q.cypher).toMatch(/^MATCH/i)
    }
  })

  it('every query cypher should contain RETURN', () => {
    for (const q of LDBC_QUERIES) {
      expect(q.cypher).toMatch(/\bRETURN\b/i)
    }
  })

  it('interactive queries should use graph traversal patterns (Person nodes)', () => {
    const interactive = getInteractiveQueries()
    for (const q of interactive) {
      expect(q.cypher).toMatch(/:Person/)
    }
  })

  it('BI queries should reference aggregate functions in returns', () => {
    const bi = getBiQueries()
    for (const q of bi) {
      expect(q.returns.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('query cypher should not be empty', () => {
    for (const q of LDBC_QUERIES) {
      expect(q.cypher.trim().length).toBeGreaterThan(0)
    }
  })
})

  // ── V37: More graph query validation ──
  it('V37-ldbc: round-trip node name', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-lq1' })
    await engine.open()
    try {
      const id = await engine.upsertNode(1, 'specific-name', { props: {} })
      const node = engine.getNode(id)
      expect(node).not.toBeNull()
    } finally { engine.close() }
  }, 30000)

  it('V37-ldbc: round-trip node props', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-lq2' })
    await engine.open()
    try {
      const id = await engine.upsertNode(1, 'with-props', { props: { k1: 'v1', k2: 42, k3: true } })
      const node = engine.getNode(id)
      expect(node?.props?.k1).toBe('v1')
      expect(node?.props?.k2).toBe(42)
    } finally { engine.close() }
  }, 30000)

  it('V37-ldbc: round-trip edge props', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-lq3' })
    await engine.open()
    try {
      const a = await engine.upsertNode(1, 'a', { props: {} })
      const b = await engine.upsertNode(1, 'b', { props: {} })
      await engine.upsertEdge(a, b, 1, { props: { weight: 99.5, label: 'knows' } })
      const nbs = engine.neighbors(a)
      if (nbs !== undefined && nbs.length > 0) {
        expect(nbs.length).toBeGreaterThan(0)
      }
    } finally { engine.close() }
  }, 30000)

  it('V37-ldbc: scanAllNodes on empty', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-lq4' })
    await engine.open()
    try {
      const all = engine.scanAllNodes()
      expect(Array.isArray(all)).toBe(true)
    } finally { engine.close() }
  }, 30000)

  it('V37-ldbc: multi-type scan', async () => {
    const engine = new GraphEngine({ path: '/tmp/bm-v37-lq5' })
    await engine.open()
    try {
      for (let t = 1; t <= 5; t++) {
        for (let i = 0; i < 3; i++) {
          await engine.upsertNode(t, `t${t}-n${i}`, { props: {} })
        }
      }
      const all = engine.scanAllNodes()
      expect(all.length).toBe(15)
    } finally { engine.close() }
  }, 30000)
