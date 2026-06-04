/**
 * tck-adapter.ts — TCK（Technology Compatibility Kit）适配器
 *
 * 提供将 Cypher 查询结果转换为 TCK 期望格式的辅助函数，
 * 以及常用的测试数据工厂函数。
 *
 * TCK 标准结果格式：
 *   { "column1": value1, "column2": value2 }
 *
 * 节点格式：
 *   { "name": "Alice", "age": 30, "_label": "Person" }
 *
 * 关系格式：
 *   { "_from": <node>, "_to": <node>, "_label": "KNOWS", "since": 2020 }
 */

import { describe, it, expect } from 'vitest'

// ── 类型定义 ────────────────────────────────────────────────

/** TCK 测试中的一个步骤 */
export interface TCKStep {
  type: 'given' | 'when' | 'then'
  // given: 初始数据操作
  query: string
  parameters?: Record<string, unknown>
  // expected: 期望的结果（then 时使用）
  expectedResults?: TCKResult[]
  expectedColumns?: string[]
  expectedCount?: number
  errorExpected?: boolean
  errorMessage?: string
}

/** TCK 单行结果 */
export interface TCKResult {
  [key: string]: unknown
}

/** 完整的 TCK 测试用例 */
export interface TCKTestCase {
  /** Feature 标题 */
  feature: string
  /** Scenario 标题 */
  scenario: string
  /** 测试步骤 */
  steps: TCKStep[]
  /** Tags（如 @wip, @skip） */
  tags?: string[]
}

// ── 测试数据工厂 ────────────────────────────────────────────

/** 创建测试节点 */
export function node(label: string, props: Record<string, unknown> = {}): Record<string, unknown> {
  return { _label: label, ...props }
}

/** 创建测试关系 */
export function edge(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
  label: string,
  props: Record<string, unknown> = {}
): Record<string, unknown> {
  return { _from: from, _to: to, _label: label, ...props }
}

// ── TCK Given 数据构建器 ────────────────────────────────────

/**
 * 构建 Given 初始图数据。
 *
 * TCK 的 Given 子句描述初始图结构，需要将节点和关系转为
 * 查询引擎可处理的数据格式。
 */
export function buildGivenGraph(
  nodes: Record<string, unknown>[],
  edges: Record<string, unknown>[] = []
): { givenNodes: Record<string, unknown>[]; givenEdges: Record<string, unknown>[] } {
  return { givenNodes: nodes, givenEdges: edges }
}

// ── 结果比较函数 ────────────────────────────────────────────

/**
 * TCK 标准结果比较。
 * 忽略结果顺序（TCK 标准中 RETURN 结果无序，除非指定 ORDER BY）。
 */
export function expectResults(
  actual: Record<string, unknown>[],
  expected: TCKResult[]
): void {
  expect(actual.length).toBe(expected.length)
  // 检查每一行时允许无序匹配
  const actualStr = actual.map(r => JSON.stringify(r, Object.keys(r).sort())).sort()
  const expectedStr = expected.map(r => JSON.stringify(r, Object.keys(r).sort())).sort()
  for (let i = 0; i < actualStr.length; i++) {
    expect(actualStr[i]).toBe(expectedStr[i])
  }
}

/** 验证结果计数 */
export function expectCount(actual: unknown[], expectedCount: number): void {
  expect(actual.length).toBe(expectedCount)
}

/** 验证结果列名 */
export function expectColumns(actual: any[], columns: string[]): void {
  if (actual.length > 0) {
    const actualCols = Object.keys(actual[0])
    columns.forEach(col => {
      expect(actualCols).toContain(col)
    })
  }
}

// ── 标准 TCK 测试生成器 ─────────────────────────────────────

/**
 * 创建一个标准 TCK 测试用例结构，供 spec 文件使用。
 * 每个测试包含标准的 Given-When-Then 三部分。
 */
export function createTCKTest(
  feature: string,
  scenario: string,
  givenQuery: string,
  whenQuery: string,
  thenResults: TCKResult[],
  givenData?: Record<string, unknown>[]
): TCKTestCase {
  const steps: TCKStep[] = [
    {
      type: 'given',
      query: givenQuery,
      parameters: { givenData },
    },
    {
      type: 'when',
      query: whenQuery,
    },
    {
      type: 'then',
      query: whenQuery,
      expectedResults: thenResults,
    },
  ]

  return {
    feature,
    scenario,
    steps,
  }
}

/**
 * 将 TCK 测试用例转换为 vitest 的 it() 调用。
 * spec 文件应调用此函数来注册测试。
 */
export function registerTCKTest(
  testCase: TCKTestCase,
  executor: (query: string, data?: Record<string, unknown>[]) => Record<string, unknown>[]
): void {
  const fullName = `${testCase.feature} — ${testCase.scenario}`

  it(fullName, () => {
    // Step 1: Given — 处理测试数据
    let data: Record<string, unknown>[] = []

    for (const step of testCase.steps) {
      switch (step.type) {
        case 'given':
          if (step.parameters?.givenData) {
            data = step.parameters.givenData as Record<string, unknown>[]
          }
          break

        case 'when':
          // 执行查询
          const result = executor(step.query, data)
          // 对于纯解析测试，我们不执行查询
          break

        case 'then':
          if (step.expectedResults) {
            const result = executor(step.query, data)
            expectResults(result, step.expectedResults)
          }
          if (step.expectedCount !== undefined) {
            const result = executor(step.query, data)
            expectCount(result, step.expectedCount)
          }
          break
      }
    }
  })
}
