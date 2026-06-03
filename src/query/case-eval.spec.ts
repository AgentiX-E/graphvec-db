import { describe, test, expect } from 'vitest'
import { _evalCaseExprOnRow, _applyCaseColumns } from './query-engine'

describe('CASE expression runtime evaluation', () => {
  test('searched CASE: WHEN condition matches first then', () => {
    const row = { age: 25, name: 'Alice' }
    const expr = {
      type: 'CASE',
      caseExpr: null,
      whens: [
        { condition: { type: 'BINARY', left: { type: 'PROPERTY_REF', name: 'age' }, operator: '<', right: { type: 'NUMBER', value: 18 } }, result: { type: 'STRING', value: 'minor' } },
        { condition: { type: 'BINARY', left: { type: 'PROPERTY_REF', name: 'age' }, operator: '>=', right: { type: 'NUMBER', value: 18 } }, result: { type: 'STRING', value: 'adult' } },
      ],
      elseExpr: { type: 'STRING', value: 'unknown' },
    }
    expect(_evalCaseExprOnRow(expr, row)).toBe('adult')
  })

  test('searched CASE: last WHEN matches', () => {
    const row = { age: 70 }
    const expr = {
      type: 'CASE',
      caseExpr: null,
      whens: [
        { condition: { type: 'BINARY', left: { type: 'PROPERTY_REF', name: 'age' }, operator: '<', right: { type: 'NUMBER', value: 18 } }, result: { type: 'STRING', value: 'minor' } },
        { condition: { type: 'BINARY', left: { type: 'PROPERTY_REF', name: 'age' }, operator: '<', right: { type: 'NUMBER', value: 60 } }, result: { type: 'STRING', value: 'adult' } },
      ],
      elseExpr: { type: 'STRING', value: 'senior' },
    }
    expect(_evalCaseExprOnRow(expr, row)).toBe('senior')
  })

  test('searched CASE: falls through to ELSE', () => {
    const row = { age: 12 }
    const expr = {
      type: 'CASE',
      caseExpr: null,
      whens: [
        { condition: { type: 'BINARY', left: { type: 'PROPERTY_REF', name: 'age' }, operator: '>=', right: { type: 'NUMBER', value: 18 } }, result: { type: 'STRING', value: 'adult' } },
      ],
      elseExpr: { type: 'STRING', value: 'minor' },
    }
    expect(_evalCaseExprOnRow(expr, row)).toBe('minor')
  })

  test('searched CASE: no ELSE returns null', () => {
    const row = { age: 5 }
    const expr = {
      type: 'CASE',
      caseExpr: null,
      whens: [
        { condition: { type: 'BINARY', left: { type: 'PROPERTY_REF', name: 'age' }, operator: '>=', right: { type: 'NUMBER', value: 18 } }, result: { type: 'STRING', value: 'adult' } },
      ],
      elseExpr: null,
    }
    expect(_evalCaseExprOnRow(expr, row)).toBeNull()
  })

  test('simple CASE: matches exact value', () => {
    const row = { status: 'active' }
    const expr = {
      type: 'CASE',
      caseExpr: { type: 'PROPERTY_REF', name: 'status' },
      whens: [
        { condition: { type: 'STRING', value: 'active' }, result: { type: 'STRING', value: 'green' } },
        { condition: { type: 'STRING', value: 'inactive' }, result: { type: 'STRING', value: 'red' } },
      ],
      elseExpr: { type: 'STRING', value: 'gray' },
    }
    expect(_evalCaseExprOnRow(expr, row)).toBe('green')
  })

  test('simple CASE with ELSE fallback', () => {
    const row = { status: 'unknown' }
    const expr = {
      type: 'CASE',
      caseExpr: { type: 'PROPERTY_REF', name: 'status' },
      whens: [
        { condition: { type: 'STRING', value: 'active' }, result: { type: 'STRING', value: 'green' } },
      ],
      elseExpr: { type: 'STRING', value: 'gray' },
    }
    expect(_evalCaseExprOnRow(expr, row)).toBe('gray')
  })

  test('numeric CASES: property comparison', () => {
    const row = { score: 85 }
    // CASE WHEN score >= 90 THEN 'A' WHEN score >= 80 THEN 'B' ELSE 'C' END
    const expr = {
      type: 'CASE', caseExpr: null,
      whens: [
        { condition: { type: 'BINARY', left: { type: 'PROPERTY_REF', name: 'score' }, operator: '>=', right: { type: 'NUMBER', value: 90 } }, result: { type: 'STRING', value: 'A' } },
        { condition: { type: 'BINARY', left: { type: 'PROPERTY_REF', name: 'score' }, operator: '>=', right: { type: 'NUMBER', value: 80 } }, result: { type: 'STRING', value: 'B' } },
      ],
      elseExpr: { type: 'STRING', value: 'C' },
    }
    expect(_evalCaseExprOnRow(expr, row)).toBe('B')
  })

  test('_applyCaseColumns adds case column to all rows', () => {
    const rows = [
      { age: 25, name: 'Alice' },
      { age: 17, name: 'Bob' },
      { age: 70, name: 'Charlie' },
    ]
    const caseColumns = [
      {
        alias: 'category',
        expression: {
          type: 'CASE', caseExpr: null,
          whens: [
            { condition: { type: 'BINARY', left: { type: 'PROPERTY_REF', name: 'age' }, operator: '<', right: { type: 'NUMBER', value: 18 } }, result: { type: 'STRING', value: 'minor' } },
            { condition: { type: 'BINARY', left: { type: 'PROPERTY_REF', name: 'age' }, operator: '<', right: { type: 'NUMBER', value: 60 } }, result: { type: 'STRING', value: 'adult' } },
          ],
          elseExpr: { type: 'STRING', value: 'senior' },
        },
      },
    ]
    const result = _applyCaseColumns(rows, caseColumns as any)
    expect(result[0].category).toBe('adult')
    expect(result[1].category).toBe('minor')
    expect(result[2].category).toBe('senior')
  })

  test('unknown property returns null', () => {
    const row = { name: 'Alice' }
    const expr = {
      type: 'CASE', caseExpr: null,
      whens: [
        { condition: { type: 'BINARY', left: { type: 'PROPERTY_REF', name: 'age' }, operator: '>=', right: { type: 'NUMBER', value: 18 } }, result: { type: 'STRING', value: 'adult' } },
      ],
      elseExpr: null,
    }
    expect(_evalCaseExprOnRow(expr, row)).toBeNull()
  })

  test('not a CASE node returns null', () => {
    expect(_evalCaseExprOnRow({ type: 'LITERAL', value: 42 }, {} as any)).toBeNull()
    expect(_evalCaseExprOnRow(null, {} as any)).toBeNull()
  })
})
