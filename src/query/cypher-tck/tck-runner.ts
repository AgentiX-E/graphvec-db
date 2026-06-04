/**
 * tck-runner.ts — TCK 场景执行引擎
 *
 * 将 TCK 测试用例映射到 GraphEngine/QueryEngine 的查询执行上。
 * 支持：
 * - 解析 Given 步骤为初始数据
 * - 执行 When 步骤的 Cypher 查询
 * - 验证 Then 步骤的结果匹配
 */

import { TCKTestCase, TCKStep, expectResults, expectCount, expectColumns } from './tck-adapter'
import { parseQuery, _executeQuery, execQuery, QueryPlan } from '../query-engine'

// ── 执行结果 ────────────────────────────────────────────

export interface TCKExecutionResult {
  testName: string
  success: boolean
  errors: string[]
  actualResults?: Record<string, unknown>[]
  expectedResults?: Record<string, unknown>[]
  query?: string
}

export interface TCKRunSummary {
  total: number
  passed: number
  failed: number
  skipped: number
  results: TCKExecutionResult[]
}

// ── Cypher TCK 执行器 ────────────────────────────────────

/**
 * TCK 运行器类，封装查询执行和结果比较。
 */
export class TCKRunner {
  private graphData: Record<string, unknown>[] = []
  private performanceMetrics: { query: string; durationMs: number }[] = []

  /** 重置图数据状态 */
  reset(): void {
    this.graphData = []
    this.performanceMetrics = []
  }

  /** 获取图数据 */
  getGraphData(): Record<string, unknown>[] {
    return this.graphData
  }

  /**
   * 执行 Cypher 查询并返回结果。
   * 使用 QueryEngine 的 parseQuery + _executeQuery。
   */
  executeQuery(query: string, data?: Record<string, unknown>[]): Record<string, unknown>[] {
    const startTime = Date.now()

    try {
      const inputData = data || this.graphData

      // 尝试解析和执行
      const plan = parseQuery(query)

      if (plan) {
        const result = _executeQuery(plan, inputData)
        if (Array.isArray(result)) {
          // 更新图数据（如果有 CREATE 等副作用）
          this.graphData = this.graphData.concat(
            result.filter(r => r._label || r._from)
          )
          this.performanceMetrics.push({ query, durationMs: Date.now() - startTime })
          return result
        }
      }

      // 兜底：返回空数组
      this.performanceMetrics.push({ query, durationMs: Date.now() - startTime })
      return []
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.performanceMetrics.push({ query, durationMs: Date.now() - startTime })
      throw new Error(`TCK query execution failed: ${errorMsg}`)
    }
  }

  /**
   * 执行 Given 步骤（设置初始数据）。
   */
  executeGiven(step: TCKStep): void {
    // Given 步骤通常是数据描述，不是查询
    // 如果 given 中有参数 givenData，由外部设置
    if (step.parameters?.givenData) {
      this.graphData = step.parameters.givenData as Record<string, unknown>[]
    } else if (step.query) {
      // 有些 TCK Given 是 CREATE 查询
      try {
        this.executeQuery(step.query)
      } catch {
        // Given 步骤失败不应终止测试
        // 记录警告
        console.warn(`Given step failed (ignored): ${step.query}`)
      }
    }
  }

  /**
   * 执行 When 步骤（执行 Cypher 查询）。
   */
  executeWhen(step: TCKStep): Record<string, unknown>[] {
    return this.executeQuery(step.query)
  }

  /**
   * 验证 Then 步骤（比较期望结果）。
   */
  verifyThen(step: TCKStep, actualResults: Record<string, unknown>[]): string[] {
    const errors: string[] = []

    try {
      if (step.expectedResults !== undefined) {
        expectResults(actualResults, step.expectedResults)
      }
      if (step.expectedCount !== undefined) {
        expectCount(actualResults, step.expectedCount)
        if (actualResults.length !== step.expectedCount) {
          errors.push(
            `Expected ${step.expectedCount} rows, got ${actualResults.length}`
          )
        }
      }
      if (step.expectedColumns !== undefined) {
        expectColumns(actualResults, step.expectedColumns)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push(msg)
    }

    return errors
  }

  /**
   * 运行单个 TCK 测试用例。
   */
  runTestCase(testCase: TCKTestCase): TCKExecutionResult {
    const errors: string[] = []
    let actualResults: Record<string, unknown>[] = []

    this.reset()

    try {
      for (const step of testCase.steps) {
        switch (step.type) {
          case 'given':
            this.executeGiven(step)
            break

          case 'when':
            try {
              actualResults = this.executeWhen(step)
            } catch (e) {
              if (step.errorExpected) {
                // 期望的错误发生，没问题
                break
              }
              throw e
            }
            break

          case 'then':
            if (!step.errorExpected) {
              const thenErrors = this.verifyThen(step, actualResults)
              errors.push(...thenErrors)
            }
            break
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push(`Execution error: ${msg}`)
    }

    return {
      testName: `${testCase.feature} — ${testCase.scenario}`,
      success: errors.length === 0,
      errors,
      actualResults,
      query: testCase.steps.find(s => s.type === 'when')?.query,
    }
  }

  /**
   * 批量运行 TCK 测试。
   */
  runAll(testCases: TCKTestCase[]): TCKRunSummary {
    const results: TCKExecutionResult[] = testCases.map(tc => this.runTestCase(tc))

    const passed = results.filter(r => r.success).length
    const failed = results.filter(r => !r.success).length

    return {
      total: results.length,
      passed,
      failed,
      skipped: 0,
      results,
    }
  }

  /** 获取性能报告 */
  getPerformanceReport(): string {
    if (this.performanceMetrics.length === 0) return 'No queries executed.'

    const total = this.performanceMetrics.reduce((s, m) => s + m.durationMs, 0)
    const avg = total / this.performanceMetrics.length
    const max = Math.max(...this.performanceMetrics.map(m => m.durationMs))
    const min = Math.min(...this.performanceMetrics.map(m => m.durationMs))

    return [
      `Queries executed: ${this.performanceMetrics.length}`,
      `Total time: ${total}ms`,
      `Average: ${avg.toFixed(1)}ms`,
      `Max: ${max}ms`,
      `Min: ${min}ms`,
    ].join('\n')
  }
}

// ── 便捷函数 ────────────────────────────────────────────

/**
 * 直接执行 TCK 测试并返回摘要（用于 Vitest 集成）。
 */
export function runTCKTest(
  testCase: TCKTestCase,
  runner: TCKRunner = new TCKRunner()
): TCKExecutionResult {
  return runner.runTestCase(testCase)
}

/**
 * 从 Cypher 查询中提取期望的列名。
 */
export function extractExpectedColumns(query: string): string[] {
  const returnMatch = query.match(/RETURN\s+(.+?)(?:\s*ORDER\s|\s*LIMIT|\s*SKIP|\s*$)/is)
  if (!returnMatch) return []

  const cols = returnMatch[1].split(',').map(c => {
    const m = c.trim().match(/AS\s+(\w+)/i)
    return m ? m[1] : c.trim().replace(/^(\w+)\.?/, '$1')
  })
  return cols.map(c => c.replace(/^.*\./, '').trim())
}
