/**
 * explain.ts — EXPLAIN 查询分析器
 *
 * 支持：
 * - EXPLAIN MATCH ... → 输出执行计划（text 格式）
 * - EXPLAIN JSON MATCH ... → 输出 JSON 格式执行计划
 * - EXPLAIN ANALYZE MATCH ... → 实际执行 + 耗时统计
 *
 * GAP-30 实现：
 * - ExplainFormatter: text / JSON / ANALYZE 格式
 * - 从 QueryPlan 生成执行计划描述
 * - EXPLAIN 语法支持（拦截查询字符串）
 * - AST 中添加 ExplainNode
 */
import { QueryPlan, parseQuery, execQuery } from './query-engine'

/** 计算过滤器显示左侧：复合表达式（`expression`）优先，否则退化为 `source.property`。 */
function filterLeft(f: { source: string; property: string; expression?: string }): string {
  if (f.expression) return f.expression
  if (f.source && f.property) return `${f.source}.${f.property}`
  return f.property
}

/** 把过滤操作符枚举映射回可读的 Cypher 符号（GT → `>`, STARTS_WITH → `STARTS WITH`）。 */
const OPERATOR_SYMBOLS: Record<string, string> = {
  EQ: '=',
  NEQ: '!=',
  GT: '>',
  GTE: '>=',
  LT: '<',
  LTE: '<=',
  IN: 'IN',
  STARTS_WITH: 'STARTS WITH',
  ENDS_WITH: 'ENDS WITH',
  CONTAINS: 'CONTAINS',
  IS_NULL: 'IS NULL',
  IS_NOT_NULL: 'IS NOT NULL',
}

function operatorSymbol(op: string): string {
  return OPERATOR_SYMBOLS[op] ?? op
}

// ──────────────────────────────────────────
// ExplainNode — AST 中的 EXPLAIN 节点
// ──────────────────────────────────────────

export interface ExplainNode {
  type: 'EXPLAIN'
  /** EXPLAIN 模式 */
  mode: 'text' | 'json' | 'analyze'
  /** 被包裹的查询 AST（通过解析得到） */
  innerQuery: string
}

// ──────────────────────────────────────────
// ExplainFormatter
// ──────────────────────────────────────────

export interface ExplainOptions {
  /** 输出格式 */
  mode?: 'text' | 'json' | 'analyze'
  /** 缩进空格数（仅 text/analyze 格式） */
  indent?: number
}

export interface AnalyzeTiming {
  phase: string
  durationMs: number
  rows: number
}

export interface ExplainResult {
  /** 原始查询 */
  query: string
  /** 执行计划描述文本 */
  planText: string
  /** JSON 格式的执行计划 */
  planJson: object
  /** ANALYZE 模式下的阶段耗时（仅在 analyze 模式下有值） */
  timings?: AnalyzeTiming[]
  /** 总执行时间（毫秒） */
  totalTimeMs?: number
}

/**
 * ExplainFormatter — 生成 EXPLAIN 输出
 */
export class ExplainFormatter {
  /**
   * 判断是否是 EXPLAIN 查询
   */
  static isExplainQuery(query: string): boolean {
    return /^\s*EXPLAIN\s/i.test(query.trim())
  }

  /**
   * 解析 EXPLAIN 模式并提取内部查询
   *
   * 语法：
   *   EXPLAIN [JSON] [ANALYZE] <query>
   *   EXPLAIN <query>  ← text 模式
   *   EXPLAIN JSON <query>  ← JSON 模式
   *   EXPLAIN ANALYZE <query>  ← ANALYZE 模式
   */
  static parseExplainQuery(query: string): { mode: 'text' | 'json' | 'analyze'; innerQuery: string } | null {
    const trimmed = query.trim()
    const explainMatch = trimmed.match(/^\s*EXPLAIN\s+/i)
    if (!explainMatch) return null

    const rest = trimmed.slice(explainMatch[0].length).trim()

    // 检查 JSON 或 ANALYZE 关键字
    const jsonMatch = rest.match(/^\s*JSON\s+/i)
    const analyzeMatch = rest.match(/^\s*ANALYZE\s+/i)

    let mode: 'text' | 'json' | 'analyze' = 'text'
    let innerQuery = rest

    if (jsonMatch) {
      mode = 'json'
      innerQuery = rest.slice(jsonMatch[0].length).trim()
    } else if (analyzeMatch) {
      mode = 'analyze'
      innerQuery = rest.slice(analyzeMatch[0].length).trim()
    }

    return { mode, innerQuery }
  }

  /**
   * 从 QueryPlan 生成执行计划描述
   *
   * @param plan QueryPlan
   * @param options 格式选项
   * @returns 格式化的 EXPLAIN 结果
   */
  static format(plan: QueryPlan, options?: ExplainOptions): ExplainResult {
    const mode = options?.mode ?? 'text'
    const indent = options?.indent ?? 2

    const planText = mode === 'json'
      ? ExplainFormatter._formatJSON(plan, indent)
      : ExplainFormatter._formatText(plan, indent)

    const planJson = ExplainFormatter._toJSON(plan)

    return {
      query: ExplainFormatter._planToQueryString(plan),
      planText,
      planJson,
    }
  }

  /**
   * 执行 ANALYZE 并返回带耗时结果的执行计划
   *
   * @param plan QueryPlan
   * @param executeFn 实际的执行函数（返回行数）
   * @returns 带耗时Info的 ExplainResult
   */
  static async analyze(
    plan: QueryPlan,
    executeFn: () => Promise<number>,
  ): Promise<ExplainResult> {
    const planText = ExplainFormatter._formatText(plan, 2)
    const planJson = ExplainFormatter._toJSON(plan)
    const timings: AnalyzeTiming[] = []

    // 1. 解析阶段
    const parseStart = Date.now()
    // Plan is already parsed
    const parseDuration = Date.now() - parseStart
    timings.push({ phase: '解析 (Parse)', durationMs: parseDuration, rows: 0 })

    // 2. 执行阶段
    const execStart = Date.now()
    let totalRows = 0
    try {
      totalRows = await executeFn()
    } catch (e: any) {
      totalRows = 0
    }
    const execDuration = Date.now() - execStart
    timings.push({ phase: '执行 (Execute)', durationMs: execDuration, rows: totalRows })

    const totalTimeMs = timings.reduce((sum, t) => sum + t.durationMs, 0)

    return {
      query: ExplainFormatter._planToQueryString(plan),
      planText,
      planJson,
      timings,
      totalTimeMs,
    }
  }

  // ── 内部格式器 ──

  /**
   * 生成文本格式执行计划
   */
  private static _formatText(plan: QueryPlan, indent: number = 2): string {
    const lines: string[] = []

    const space = ' '.repeat(indent)

    // 查询类型
    lines.push(`查询类型: ${plan.type ?? 'QUERY'}`)

    // 扫描标签
    if (plan.scanLabel) {
      lines.push(`${space}节点扫描: :${plan.scanLabel}`)
    } else {
      lines.push(`${space}节点扫描: ALL (全表扫描)`)
    }

    // 遍历步骤
    if (plan.steps && plan.steps.length > 0) {
      for (let i = 0; i < plan.steps.length; i++) {
        const step = plan.steps[i]
        const dirLabel = step.direction === 'in' ? '<-' : step.direction === 'any' ? '<->' : '->'
        const edgeLabel = step.edgeLabel ? `:${step.edgeLabel}` : ''
        lines.push(`${space}边遍历 #${i + 1}: ${dirLabel}${edgeLabel}${dirLabel}`)
        if (step.targetLabel) {
          lines.push(`${' '.repeat(indent * 2)}目标标签: :${step.targetLabel}`)
        }
        if (step.range?.min !== undefined || step.range?.max !== undefined) {
          const min = step.range?.min ?? 1
          const max = step.range?.max ?? Infinity
          lines.push(`${' '.repeat(indent * 2)}变长路径: ${min}..${max === Infinity ? '∞' : max}`)
        }
      }
    }

    // OPTIONAL MATCH
    if (plan.optionalMatchSteps && plan.optionalMatchSteps.length > 0) {
      for (let i = 0; i < plan.optionalMatchSteps.length; i++) {
        const om = plan.optionalMatchSteps[i]
        lines.push(`${space}OPTIONAL MATCH #${i + 1}: ${om.scanLabel ? `:${om.scanLabel}` : 'ALL'}`)
      }
    }

    // 过滤器
    if (plan.filters && plan.filters.length > 0) {
      for (const f of plan.filters) {
        lines.push(`${space}过滤器: ${filterLeft(f)} ${operatorSymbol(f.operator)} ${f.value}`)
      }
    }

    // EXISTS 子查询过滤器
    if (plan.existsFilters && plan.existsFilters.length > 0) {
      for (const ef of plan.existsFilters) {
        lines.push(`${space}EXISTS 子查询: ${ef.source} -${ef.direction === 'in' ? '' : '->'} ${ef.edgeLabel ? `[${ef.edgeLabel}]` : '[*]'} ${ef.direction === 'in' ? '->' : ''} ${ef.target}`)
      }
    }

    // WITH 子句
    if (plan.with) {
      lines.push(`${space}WITH 投影: [${plan.with.columns.map(c => c.alias || c.expression).join(', ')}]`)
    }

    // 聚合
    if (plan.aggregate) {
      const func = plan.aggregate.function
      const col = plan.aggregate.column
      lines.push(`${space}聚合: ${func}(${col ?? '*'})`)
    }

    // GROUP BY
    if (plan.groupBy && plan.groupBy.length > 0) {
      lines.push(`${space}GROUP BY: ${plan.groupBy.join(', ')}`)
    }

    // RETURN 列
    if (plan.returnColumns && plan.returnColumns.length > 0) {
      lines.push(`${space}返回列: [${plan.returnColumns.join(', ')}]`)
    }

    // ORDER BY
    if (plan.orderBy && plan.orderBy.length > 0) {
      for (const ob of plan.orderBy) {
        lines.push(`${space}排序: ${ob.property} ${ob.direction}`)
      }
    }

    // LIMIT / SKIP
    if (plan.limit !== undefined) {
      lines.push(`${space}LIMIT: ${plan.limit}`)
    }
    if (plan.skip !== undefined) {
      lines.push(`${space}SKIP: ${plan.skip}`)
    }

    // 集合运算
    if (plan.unionType) {
      lines.push(`${space}集合运算: ${plan.unionType.replace('_', ' ').toUpperCase()}`)
    }

    // CREATE
    if (plan.createNodes && plan.createNodes.length > 0) {
      for (const cn of plan.createNodes) {
        lines.push(`${space}创建节点: ${cn.alias}${cn.label ? ` :${cn.label}` : ''}`)
      }
    }
    if (plan.createEdges && plan.createEdges.length > 0) {
      for (const ce of plan.createEdges) {
        lines.push(`${space}创建边: (${ce.source})-[:${ce.label}]->(${ce.target})`)
      }
    }

    // CALL 子查询
    if (plan.callQuery) {
      lines.push(`${space}CALL 子查询:`)
      const subPlanText = ExplainFormatter._formatText(plan.callQuery, indent + 2)
      lines.push(subPlanText)
    }

    return lines.join('\n')
  }

  /**
   * 生成 JSON 格式执行计划
   */
  private static _formatJSON(plan: QueryPlan, _indent: number = 2): string {
    return JSON.stringify(ExplainFormatter._toJSON(plan), null, 2)
  }

  /**
   * 将 QueryPlan 转换为可序列化的 JSON 对象
   */
  private static _toJSON(plan: QueryPlan): object {
    const obj: Record<string, unknown> = {
      type: plan.type ?? 'QUERY',
    }

    if (plan.scanLabel !== null) {
      obj.scanLabel = plan.scanLabel
    } else {
      obj.scanLabel = 'ALL'
    }

    if (plan.steps && plan.steps.length > 0) {
      obj.steps = plan.steps.map((s, i) => ({
        step: i + 1,
        direction: s.direction,
        edgeLabel: s.edgeLabel ?? undefined,
        targetLabel: s.targetLabel ?? undefined,
        minDepth: s.range?.min,
        maxDepth: s.range?.max,
      }))
    }

    if (plan.filters && plan.filters.length > 0) {
      obj.filters = plan.filters.map(f => ({
        left: filterLeft(f),
        operator: operatorSymbol(f.operator),
        right: f.value,
      }))
    }

    if (plan.returnColumns && plan.returnColumns.length > 0) {
      obj.returnColumns = plan.returnColumns
    }

    if (plan.orderBy && plan.orderBy.length > 0) {
      obj.orderBy = plan.orderBy.map(o => ({
        property: o.property,
        direction: o.direction,
      }))
    }

    if (plan.limit !== undefined) obj.limit = plan.limit
    if (plan.skip !== undefined) obj.skip = plan.skip

    if (plan.aggregate) {
      obj.aggregate = {
        function: plan.aggregate.function,
        column: plan.aggregate.column ?? '*',
      }
    }

    if (plan.groupBy && plan.groupBy.length > 0) {
      obj.groupBy = plan.groupBy
    }

    if (plan.unionType) {
      obj.unionType = plan.unionType
    }

    if (plan.createNodes && plan.createNodes.length > 0) {
      obj.createNodes = plan.createNodes.map(n => ({
        alias: n.alias,
        label: n.label,
        props: n.props,
      }))
    }

    if (plan.createEdges && plan.createEdges.length > 0) {
      obj.createEdges = plan.createEdges.map(e => ({
        from: e.source,
        label: e.label,
        to: e.target,
        props: e.props,
      }))
    }

    return obj
  }

  /**
   * 从 QueryPlan 重建查询字符串（用于展示）
   */
  private static _planToQueryString(plan: QueryPlan): string {
    const parts: string[] = []

    // MATCH
    if (plan.scanLabel || (plan.steps && plan.steps.length > 0)) {
      let matchStr = 'MATCH ('
      if (plan.scanLabel) matchStr += `:${plan.scanLabel}`
      matchStr += ')'

      if (plan.steps) {
        for (const step of plan.steps) {
          const dir1 = step.direction === 'in' ? '<-' : '-'
          const dir2 = step.direction === 'in' ? '--' : '->'
          matchStr += dir1
          if (step.edgeLabel) {
            const depthStr = (step.range?.min !== undefined || step.range?.max !== undefined)
              ? `*${step.range?.min ?? 1}..${step.range?.max ?? ''}`
              : ''
            matchStr += `[:${step.edgeLabel}${depthStr}]`
          }
          matchStr += dir2 + '('
          if (step.targetLabel) matchStr += `:${step.targetLabel}`
          matchStr += ')'
        }
      }

      parts.push(matchStr)
    }

    // WHERE
    if (plan.filters && plan.filters.length > 0) {
      const whereParts = plan.filters.map(f => `${filterLeft(f)} ${operatorSymbol(f.operator)} ${f.value}`)
      parts.push('WHERE ' + whereParts.join(' AND '))
    }

    // RETURN
    if (plan.returnColumns && plan.returnColumns.length > 0) {
      parts.push('RETURN ' + plan.returnColumns.join(', '))
    }

    // ORDER BY
    if (plan.orderBy && plan.orderBy.length > 0) {
      parts.push('ORDER BY ' + plan.orderBy.map(o => `${o.property} ${o.direction}`).join(', '))
    }

    // LIMIT
    if (plan.limit !== undefined) {
      parts.push(`LIMIT ${plan.limit}`)
    }

    return parts.join(' ')
  }
}

/**
 * 从查询字符串解析 EXPLAIN 节点
 */
export function parseExplainNode(query: string): ExplainNode | null {
  const parsed = ExplainFormatter.parseExplainQuery(query)
  if (!parsed) return null

  return {
    type: 'EXPLAIN',
    mode: parsed.mode,
    innerQuery: parsed.innerQuery,
  }
}

/**
 * 将 EXPLAIN 节点格式化为可读输出
 */
export function formatExplainNode(
  node: ExplainNode,
  innerPlan: QueryPlan,
  timings?: AnalyzeTiming[],
): string {
  const result = ExplainFormatter.format(innerPlan, { mode: node.mode })

  if (node.mode === 'analyze' && timings) {
    const timingLines = timings.map(t =>
      `  ${t.phase}: ${t.durationMs.toFixed(2)}ms, 行数: ${t.rows}`
    ).join('\n')
    const totalMs = timings.reduce((s, t) => s + t.durationMs, 0)
    return `执行计划:\n${result.planText}\n\n执行耗时:\n${timingLines}\n  总耗时: ${totalMs.toFixed(2)}ms`
  }

  return `执行计划:\n${result.planText}`
}
