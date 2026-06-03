/**
 * list-ops.spec.ts — List literal, subscript, slice, and concatenation tests
 */

import { describe, it, expect } from 'vitest'
import { _executeQuery, planFromAST } from '../query/query-engine'
import { parser } from './cypher-lite-parser'

function execQuery(query: string, nodes: any[] = []): any[] {
  const ast = parser.parse(query)
  const plan = planFromAST(ast)
  if (plan.orderBy) {
    plan.orderBy = plan.orderBy.filter((ob: any) => ob.property !== undefined)
  }
  const result = _executeQuery(plan, nodes)
  return Array.isArray(result) ? result : []
}

describe('List Operations', () => {

  it('should evaluate list literal [1,2,3]', () => {
    const rows = execQuery('RETURN [1,2,3] as mylist')
    expect(rows).toHaveLength(1)
    expect(rows[0].mylist).toEqual([1, 2, 3])
  })

  it('should evaluate empty list []', () => {
    const rows = execQuery('RETURN [] as empty')
    expect(rows).toHaveLength(1)
    expect(rows[0].empty).toEqual([])
  })

  it('should concatenate two lists with +', () => {
    const rows = execQuery('RETURN [1,2] + [3,4] as combined')
    expect(rows).toHaveLength(1)
    expect(rows[0].combined).toEqual([1, 2, 3, 4])
  })

  it('should handle list literal as RETURN column (no alias)', () => {
    const rows = execQuery('RETURN [1,2,3]')
    expect(rows).toHaveLength(1)
    const keys = Object.keys(rows[0])
    expect(keys.length).toBeGreaterThanOrEqual(1)
    expect(rows[0][keys[0]]).toEqual([1, 2, 3])
  })

  it('should evaluate subscript n.items[0]', () => {
    const node = { name: 'test', items: ['a', 'b', 'c'] }
    const rows = execQuery('MATCH (n) RETURN n.items[0] as first', [node])
    expect(rows).toHaveLength(1)
    expect(rows[0].first).toBe('a')
  })

  it('should evaluate slice n.items[1..3]', () => {
    const node = { name: 'test', items: ['a', 'b', 'c', 'd', 'e'] }
    const rows = execQuery('MATCH (n) RETURN n.items[1..3] as slice', [node])
    expect(rows).toHaveLength(1)
    expect(rows[0].slice).toEqual(['b', 'c'])
  })

  it('should handle subscript out of bounds', () => {
    const node = { name: 'test', items: ['a', 'b', 'c'] }
    const rows = execQuery('MATCH (n) RETURN n.items[99] as out', [node])
    expect(rows).toHaveLength(1)
    expect(rows[0].out).toBeNull()
  })

  it('should handle slice past end of array', () => {
    const node = { name: 'test', items: [1, 2, 3] }
    const rows = execQuery('MATCH (n) RETURN n.items[2..10] as tail', [node])
    expect(rows).toHaveLength(1)
    expect(rows[0].tail).toEqual([3])
  })

})
