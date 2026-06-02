/**
 * LOAD CSV 查询解析测试
 */
import { describe, it, expect } from 'vitest'
import { parseQuery } from './query-engine'

describe('LOAD CSV 解析', () => {
  it('LOAD CSV FROM URL AS row', () => {
    const plan = parseQuery("LOAD CSV FROM 'https://example.com/data.csv' AS row RETURN row")
    expect(plan.loadCsv).toBeDefined()
    expect(plan.loadCsv!.url).toBe('https://example.com/data.csv')
    expect(plan.loadCsv!.rowVariable).toBe('row')
    expect(plan.loadCsv!.hasHeaders).toBe(false)
  })

  it('LOAD CSV WITH HEADERS', () => {
    const plan = parseQuery("LOAD CSV FROM 'file.csv' AS row WITH HEADERS RETURN row")
    expect(plan.loadCsv).toBeDefined()
    expect(plan.loadCsv!.hasHeaders).toBe(true)
  })

  it('无 LOAD CSV 的查询为 undefined', () => {
    const plan = parseQuery('MATCH (n) RETURN n')
    expect(plan.loadCsv).toBeUndefined()
  })
})
