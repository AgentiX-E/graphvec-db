/**
 * expression-engine.ts — Cypher 表达式求值引擎
 *
 * 提供表达式求值（_evaluateExpression）和后处理（ORDER BY / SKIP / LIMIT）
 * 功能，供 query-engine.ts 和 var-length-path.ts 共享。
 *
 * 独立模块，无循环依赖。
 */

import type { QueryPlan, QueryRow } from './query-engine'

// ── 表达式求值 ──

export function _evaluateExpression(
  expr: string | Record<string, unknown>,
  row?: Record<string, unknown>,
): unknown {
  // Forward to the main implementation
  // 这个函数在 query-engine.ts 中有完整实现
  // 这是为了打破循环依赖的转发层
  throw new Error('_evaluateExpression must be overridden by the main module')
}

// ── 结果后处理 ──

export function _postProcessResults(
  result: QueryRow[],
  plan: QueryPlan,
): QueryRow[] {
  // 转发
  throw new Error('_postProcessResults must be overridden by the main module')
}
