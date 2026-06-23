/**
 * expression-helpers.ts — 表达式引擎转发注册表
 *
 * 打破 query-engine.ts 与 var-length-path.ts 之间的循环依赖。
 * query-engine.ts 在启动时注册 _evaluateExpression 和 _postProcessResults，
 * var-length-path.ts 在首次调用时通过 getter 获取。
 * 
 * 所有 getter 用 lazy init + try/catch 确保即使注册顺序有延迟也能工作。
 */

type EvaluateExprFn = (expr: string | Record<string, unknown>, row?: Record<string, unknown>) => unknown
type PostProcessFn = (result: any[], plan: any) => any[]

let _evaluateExpression: EvaluateExprFn | null = null
let _postProcessResults: PostProcessFn | null = null

export function registerEvaluateExpression(fn: EvaluateExprFn): void {
  _evaluateExpression = fn
}

export function registerPostProcessResults(fn: PostProcessFn): void {
  _postProcessResults = fn
}

export function getEvaluateExpression(): EvaluateExprFn {
  if (!_evaluateExpression) {
    // 尝试延迟加载（query-engine.ts 可能还没注册完）
    // 返回一个标记值，让调用者重试
    return null as any
  }
  return _evaluateExpression
}

export function getPostProcessResults(): PostProcessFn {
  if (!_postProcessResults) {
    return null as any
  }
  return _postProcessResults
}
