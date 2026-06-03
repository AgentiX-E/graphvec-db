/**
 * CASE 表达式运行时求值单元测试
 *
 * 测试 _evalCaseExprOnRow 对 PEG 生成的 CASE AST 的运行时求值。
 */

import { _evalCaseExprOnRow, _applyCaseColumns } from './query-engine'

// ── 辅助函数：构造行数据 ──

function row(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    name: 'Alice',
    age: 30,
    score: 85,
    city: 'Beijing',
    isActive: true,
    ...overrides,
  }
}

// ── Test Suite ──

describe('_evalCaseExprOnRow — CASE 表达式运行时求值', () => {

  // 1. CASE WHEN 属性引用 + 比较操作符
  test('CASE WHEN n.age = 30 THEN adult', () => {
    // CASE WHEN n.age = 30 THEN 'adult'
    const expr = {
      type: 'CASE',
      caseExpr: null,
      whens: [
        {
          condition: {
            type: 'COMPARISON',
            operator: 'EQ',
            left: { type: 'PROP_REF', name: 'n', property: 'age' },
            right: { type: 'NUMBER', value: 30 },
          },
          result: { type: 'STRING', value: 'adult' },
        },
      ],
      elseExpr: null,
    }
    expect(_evalCaseExprOnRow(expr, row())).toBe('adult')
    expect(_evalCaseExprOnRow(expr, row({ age: 25 }))).toBeNull()
  })

  test('CASE WHEN n.age > 18 THEN adult', () => {
    // CASE WHEN n.age > 18 THEN 'adult'
    const expr = {
      type: 'CASE',
      caseExpr: null,
      whens: [
        {
          condition: {
            type: 'COMPARISON',
            operator: 'GT',
            left: { type: 'PROP_REF', name: 'n', property: 'age' },
            right: { type: 'NUMBER', value: 18 },
          },
          result: { type: 'STRING', value: 'adult' },
        },
      ],
      elseExpr: null,
    }
    expect(_evalCaseExprOnRow(expr, row({ age: 20 }))).toBe('adult')
    expect(_evalCaseExprOnRow(expr, row({ age: 15 }))).toBeNull()
  })

  test('CASE WHEN n.score >= 60 THEN pass', () => {
    const expr = {
      type: 'CASE',
      caseExpr: null,
      whens: [
        {
          condition: {
            type: 'COMPARISON',
            operator: 'GTE',
            left: { type: 'PROP_REF', name: 'n', property: 'score' },
            right: { type: 'NUMBER', value: 60 },
          },
          result: { type: 'STRING', value: 'pass' },
        },
      ],
      elseExpr: null,
    }
    expect(_evalCaseExprOnRow(expr, row({ score: 85 }))).toBe('pass')
    expect(_evalCaseExprOnRow(expr, row({ score: 59 }))).toBeNull()
  })

  test('CASE WHEN n.age < 18 THEN minor', () => {
    const expr = {
      type: 'CASE',
      caseExpr: null,
      whens: [
        {
          condition: {
            type: 'COMPARISON',
            operator: 'LT',
            left: { type: 'PROP_REF', name: 'n', property: 'age' },
            right: { type: 'NUMBER', value: 18 },
          },
          result: { type: 'STRING', value: 'minor' },
        },
      ],
      elseExpr: null,
    }
    expect(_evalCaseExprOnRow(expr, row({ age: 15 }))).toBe('minor')
    expect(_evalCaseExprOnRow(expr, row({ age: 20 }))).toBeNull()
  })

  test('CASE WHEN n.name != Alice THEN other', () => {
    const expr = {
      type: 'CASE',
      caseExpr: null,
      whens: [
        {
          condition: {
            type: 'COMPARISON',
            operator: 'NEQ',
            left: { type: 'PROP_REF', name: 'n', property: 'name' },
            right: { type: 'STRING', value: 'Alice' },
          },
          result: { type: 'STRING', value: 'other' },
        },
      ],
      elseExpr: null,
    }
    expect(_evalCaseExprOnRow(expr, row({ name: 'Bob' }))).toBe('other')
    expect(_evalCaseExprOnRow(expr, row({ name: 'Alice' }))).toBeNull()
  })

  // 2. CASE WHEN AND/OR 组合条件
  test('CASE WHEN n.age > 18 AND n.age < 65 THEN working', () => {
    // CASE WHEN n.age > 18 AND n.age < 65 THEN 'working'
    const expr = {
      type: 'CASE',
      caseExpr: null,
      whens: [
        {
          condition: {
            type: 'AND',
            left: {
              type: 'COMPARISON',
              operator: 'GT',
              left: { type: 'PROP_REF', name: 'n', property: 'age' },
              right: { type: 'NUMBER', value: 18 },
            },
            right: {
              type: 'COMPARISON',
              operator: 'LT',
              left: { type: 'PROP_REF', name: 'n', property: 'age' },
              right: { type: 'NUMBER', value: 65 },
            },
          },
          result: { type: 'STRING', value: 'working' },
        },
      ],
      elseExpr: null,
    }
    expect(_evalCaseExprOnRow(expr, row({ age: 30 }))).toBe('working')
    expect(_evalCaseExprOnRow(expr, row({ age: 10 }))).toBeNull()
    expect(_evalCaseExprOnRow(expr, row({ age: 70 }))).toBeNull()
  })

  test('CASE WHEN n.age < 18 OR n.age > 65 THEN special', () => {
    const expr = {
      type: 'CASE',
      caseExpr: null,
      whens: [
        {
          condition: {
            type: 'OR',
            left: {
              type: 'COMPARISON',
              operator: 'LT',
              left: { type: 'PROP_REF', name: 'n', property: 'age' },
              right: { type: 'NUMBER', value: 18 },
            },
            right: {
              type: 'COMPARISON',
              operator: 'GT',
              left: { type: 'PROP_REF', name: 'n', property: 'age' },
              right: { type: 'NUMBER', value: 65 },
            },
          },
          result: { type: 'STRING', value: 'special' },
        },
      ],
      elseExpr: null,
    }
    expect(_evalCaseExprOnRow(expr, row({ age: 15 }))).toBe('special')
    expect(_evalCaseExprOnRow(expr, row({ age: 70 }))).toBe('special')
    expect(_evalCaseExprOnRow(expr, row({ age: 30 }))).toBeNull()
  })

  test('CASE WHEN n.age > 18 AND n.city = Beijing THEN local-adult', () => {
    const expr = {
      type: 'CASE',
      caseExpr: null,
      whens: [
        {
          condition: {
            type: 'AND',
            left: {
              type: 'COMPARISON',
              operator: 'GT',
              left: { type: 'PROP_REF', name: 'n', property: 'age' },
              right: { type: 'NUMBER', value: 18 },
            },
            right: {
              type: 'COMPARISON',
              operator: 'EQ',
              left: { type: 'PROP_REF', name: 'n', property: 'city' },
              right: { type: 'STRING', value: 'Beijing' },
            },
          },
          result: { type: 'STRING', value: 'local-adult' },
        },
      ],
      elseExpr: null,
    }
    expect(_evalCaseExprOnRow(expr, row({ age: 25, city: 'Beijing' }))).toBe('local-adult')
    expect(_evalCaseExprOnRow(expr, row({ age: 25, city: 'Shanghai' }))).toBeNull()
  })

  // 3. CASE ELSE 兜底
  test('CASE WHEN n.age > 18 THEN adult ELSE minor', () => {
    const expr = {
      type: 'CASE',
      caseExpr: null,
      whens: [
        {
          condition: {
            type: 'COMPARISON',
            operator: 'GT',
            left: { type: 'PROP_REF', name: 'n', property: 'age' },
            right: { type: 'NUMBER', value: 18 },
          },
          result: { type: 'STRING', value: 'adult' },
        },
      ],
      elseExpr: { type: 'STRING', value: 'minor' },
    }
    expect(_evalCaseExprOnRow(expr, row({ age: 25 }))).toBe('adult')
    expect(_evalCaseExprOnRow(expr, row({ age: 15 }))).toBe('minor')
  })

  test('CASE WHEN n.score >= 90 THEN A WHEN n.score >= 80 THEN B ELSE C', () => {
    const expr = {
      type: 'CASE',
      caseExpr: null,
      whens: [
        {
          condition: {
            type: 'COMPARISON',
            operator: 'GTE',
            left: { type: 'PROP_REF', name: 'n', property: 'score' },
            right: { type: 'NUMBER', value: 90 },
          },
          result: { type: 'STRING', value: 'A' },
        },
        {
          condition: {
            type: 'COMPARISON',
            operator: 'GTE',
            left: { type: 'PROP_REF', name: 'n', property: 'score' },
            right: { type: 'NUMBER', value: 80 },
          },
          result: { type: 'STRING', value: 'B' },
        },
      ],
      elseExpr: { type: 'STRING', value: 'C' },
    }
    expect(_evalCaseExprOnRow(expr, row({ score: 95 }))).toBe('A')
    expect(_evalCaseExprOnRow(expr, row({ score: 85 }))).toBe('B')
    expect(_evalCaseExprOnRow(expr, row({ score: 70 }))).toBe('C')
  })

  // 4. 简化 CASE (CASE expr WHEN val)
  test('CASE n.age WHEN 10 THEN child WHEN 20 THEN youth', () => {
    const expr = {
      type: 'CASE',
      caseExpr: { type: 'PROP_REF', name: 'n', property: 'age' },
      whens: [
        {
          condition: { type: 'NUMBER', value: 10 },
          result: { type: 'STRING', value: 'child' },
        },
        {
          condition: { type: 'NUMBER', value: 20 },
          result: { type: 'STRING', value: 'youth' },
        },
      ],
      elseExpr: { type: 'STRING', value: 'other' },
    }
    expect(_evalCaseExprOnRow(expr, row({ age: 10 }))).toBe('child')
    expect(_evalCaseExprOnRow(expr, row({ age: 20 }))).toBe('youth')
    expect(_evalCaseExprOnRow(expr, row({ age: 30 }))).toBe('other')
  })

  test('CASE n.name WHEN Alice THEN found ELSE missing', () => {
    const expr = {
      type: 'CASE',
      caseExpr: { type: 'PROP_REF', name: 'n', property: 'name' },
      whens: [
        {
          condition: { type: 'STRING', value: 'Alice' },
          result: { type: 'STRING', value: 'found' },
        },
      ],
      elseExpr: { type: 'STRING', value: 'missing' },
    }
    expect(_evalCaseExprOnRow(expr, row({ name: 'Alice' }))).toBe('found')
    expect(_evalCaseExprOnRow(expr, row({ name: 'Bob' }))).toBe('missing')
  })

  // 5. _applyCaseColumns 集成测试
  test('_applyCaseColumns 添加计算列', () => {
    const rows = [
      { name: 'Alice', age: 25 },
      { name: 'Bob', age: 15 },
      { name: 'Charlie', age: 30 },
    ]

    const caseColumns = [
      {
        alias: 'category',
        expression: {
          type: 'CASE',
          caseExpr: null,
          whens: [
            {
              condition: {
                type: 'COMPARISON',
                operator: 'GT',
                left: { type: 'PROP_REF', name: 'n', property: 'age' },
                right: { type: 'NUMBER', value: 18 },
              },
              result: { type: 'STRING', value: 'adult' },
            },
          ],
          elseExpr: { type: 'STRING', value: 'minor' },
        },
      },
    ]

    const result = _applyCaseColumns(rows as any, caseColumns as any)
    expect(result[0].category).toBe('adult')
    expect(result[1].category).toBe('minor')
    expect(result[2].category).toBe('adult')
    // Original columns preserved
    expect(result[0].name).toBe('Alice')
    expect(result[1].age).toBe(15)
  })

  // 6. NULL/空值处理
  test('CASE WHEN 处理缺失属性', () => {
    const expr = {
      type: 'CASE',
      caseExpr: null,
      whens: [
        {
          condition: {
            type: 'COMPARISON',
            operator: 'EQ',
            left: { type: 'PROP_REF', name: 'n', property: 'missingProp' },
            right: { type: 'NUMBER', value: 10 },
          },
          result: { type: 'STRING', value: 'found' },
        },
      ],
      elseExpr: { type: 'STRING', value: 'not-found' },
    }
    // Missing property should evaluate to null, comparison null === 10 is false
    expect(_evalCaseExprOnRow(expr, row())).toBe('not-found')
  })

  // 7. 多个 WHEN 依次匹配
  test('CASE WHEN 多个 WHEN 依次匹配（短路）', () => {
    const expr = {
      type: 'CASE',
      caseExpr: null,
      whens: [
        {
          condition: {
            type: 'COMPARISON',
            operator: 'EQ',
            left: { type: 'PROP_REF', name: 'n', property: 'age' },
            right: { type: 'NUMBER', value: 10 },
          },
          result: { type: 'STRING', value: 'first' },
        },
        {
          condition: {
            type: 'COMPARISON',
            operator: 'EQ',
            left: { type: 'PROP_REF', name: 'n', property: 'age' },
            right: { type: 'NUMBER', value: 20 },
          },
          result: { type: 'STRING', value: 'second' },
        },
      ],
      elseExpr: null,
    }
    expect(_evalCaseExprOnRow(expr, row({ age: 10 }))).toBe('first')
    expect(_evalCaseExprOnRow(expr, row({ age: 20 }))).toBe('second')
    expect(_evalCaseExprOnRow(expr, row({ age: 30 }))).toBeNull()
  })
})
