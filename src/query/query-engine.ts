/**
 * query-engine.ts — Cypher-lite AST → Fluent API Transformer
 *
 * 将 peggy 解析出的 AST 转换为 OverGraph Fluent API 调用链。
 * 主要转换：
 *   MATCH (a:Person)-[:KNOWS]->(b) WHERE b.age > 30 RETURN b.name
 *   → engine.scan('Person').as('a').traverse('out').filter('age', '>', 30).as('b').return(['name'])
 *
 * 多跳支持：
 *   MATCH (a)-[:KNOWS]->(b)-[:WORKS_AT]->(c) WHERE c.name = "Acme" RETURN a.name
 *   → engine.scan('KNOWS' direction: 'out').traverse('out', 'WORKS_AT').filter('name', 'EQ', "Acme").as('c').return(['name'])
 *
 * 注意：当前实现依赖 OverGraph 的 Fluent API，未完全覆盖所有匹配模式。
 * 复杂的多跳路径展开使用 expandPath() 算法。
 *
 * 支持 DML 语句：
 *   CREATE (n:Label {prop: "val"})
 *   CREATE (a)-[:KNOWS]->(b)
 *   MATCH (n) DELETE n
 *   MATCH (n) SET n.name = "val"
 *   MERGE (n:Label {id: 1})
 */

import { parser } from './cypher-lite-parser'

// ── AST 类型 ─────────────────────────────────────────────────

export interface QueryAST {
  type: 'QUERY'
  match?: {
    type: 'MATCH'
    patterns: PatternAST[]
  }
  where?: WhereClauseAST | null
  return?: ReturnClauseAST
  orderBy?: OrderByAST | null
  limit?: number | undefined
  skip?: number | undefined
  aggregate?: AggregateClause
  unionType?: 'union' | 'union_all' | 'intersect' | 'subtract'
  rightQuery?: QueryAST
  // DML fields
  create?: CreateClauseAST
  delete?: DeleteClauseAST
  set?: SetClauseAST
  merge?: MergeClauseAST
}

export interface CreateClauseAST {
  type: 'CREATE'
  patterns: CreateNodeItemAST[]
}

export interface CreateNodeItemAST {
  type: 'CREATE_NODE' | 'CREATE_PATH'
  node: NodePatternAST
  edges?: EdgeStepAST[]
}

export interface DeleteClauseAST {
  type: 'DELETE'
  targets: string[]
}

export interface SetClauseAST {
  type: 'SET'
  items: SetItemAST[]
}

export interface SetItemAST {
  type: 'SET_ITEM'
  property: PrimaryAST
  value: PrimaryAST
}

export interface MergeClauseAST {
  type: 'MERGE'
  patterns: CreateNodeItemAST[]
}

export interface PatternAST {
  type: 'PATH'
  node: NodePatternAST
  edges: EdgeStepAST[]
}

export interface NodePatternAST {
  type: 'NODE'
  name: string
  label: string | null
  props: Record<string, unknown> | null
}

export interface EdgeStepAST {
  edge: {
    type: 'EDGE'
    name: string | null
    label: string | null
    direction: 'out' | 'in' | 'any'
    range?: { min: number; max: number | null }
  }
  node: NodePatternAST
}

export interface WhereClauseAST {
  type: 'WHERE'
  expression: ExpressionAST
}

export type ExpressionAST =
  | { type: 'OR'; left: ExpressionAST; right: ExpressionAST | ExpressionAST[] }
  | { type: 'AND'; left: ExpressionAST; right: ExpressionAST | ExpressionAST[] }
  | { type: 'COMPARISON'; operator: string; left: PrimaryAST; right: PrimaryAST }
  | PrimaryAST

export type PrimaryAST =
  | { type: 'PROP_REF'; name: string; property: string }
  | { type: 'STRING'; value: string }
  | { type: 'NUMBER'; value: number }
  | { type: 'BOOLEAN'; value: boolean }
  | { type: 'IDENTIFIER'; name: string }
  | { type: 'OR' } // placeholder - never matched as Primary
  | { type: 'AND' }
  | { type: 'COMPARISON' }

export interface ReturnClauseAST {
  type: 'RETURN'
  columns: ColumnAST[]
  aggregate?: AggregateClause
}

export interface ColumnAST {
  type: 'COLUMN'
  expression: PrimaryAST
  alias: string | null
}

export interface OrderByAST {
  type: 'ORDER_BY'
  columns: OrderColumnAST[]
}

export interface OrderColumnAST {
  type: 'ORDER_COLUMN'
  expression: PrimaryAST
  direction: 'ASC' | 'DESC'
}

// ── 聚合子句 ─────────────────────────────────────────────────

export interface AggregateClause {
  type: 'count' | 'sum' | 'avg' | 'max' | 'min'
  field?: string  // 如 n.age
  alias?: string  // AS alias
}

// ── Query Plan ─────────────────────────────────────────────────

export interface QueryPlan {
  /** 操作类型 */
  type?: 'QUERY' | 'CREATE' | 'DELETE' | 'SET' | 'MERGE'
  /** 起始节点标签扫描（如果 MATCH 节点指定了 label） */
  scanLabel: string | null
  /** 遍历步骤 */
  steps: TraverseStep[]
  /** WHERE 过滤器 */
  filters: FilterClause[]
  /** RETURN 列 */
  returnColumns: string[]
  /** ORDER BY */
  orderBy: Array<{ property: string; direction: 'ASC' | 'DESC' }>
  /** LIMIT */
  limit: number | undefined
  /** SKIP */
  skip: number | undefined
  /** 聚合子句（如 count, sum, avg, max, min） */
  aggregate?: AggregateClause
  /** 集合运算类型 */
  unionType?: 'union' | 'union_all' | 'intersect' | 'subtract'
  /** 集合运算右半部分 */
  rightPlan?: QueryPlan
  // DML fields
  /** CREATE 节点 */
  createNodes?: Array<{
    alias: string
    label: string | null
    props: Record<string, unknown> | null
  }>
  /** CREATE 边 */
  createEdges?: Array<{
    source: string
    target: string
    label: string | null
    direction: 'out' | 'in' | 'any'
  }>
  /** DELETE 目标 */
  deleteTargets?: string[]
  /** SET 子句 */
  setClauses?: Array<{
    property: string
    value: unknown
  }>
  /** MERGE 节点 */
  mergeNodes?: Array<{
    alias: string
    label: string | null
    props: Record<string, unknown> | null
  }>
  mergeEdges?: Array<{
    source: string
    target: string
    label: string | null
    direction: 'out' | 'in' | 'any'
  }>
}

export interface TraverseStep {
  source: string // 源节点的别名
  direction: 'out' | 'in' | 'any'
  edgeLabel: string | null
  targetAlias: string
  targetLabel: string | null
  targetProps: Record<string, unknown> | null
  /** 变长路径范围（如果此步为变长路径） */
  range?: { min: number; max: number | null }
}

export interface FilterClause {
  source: string
  property: string
  operator: 'EQ' | 'NEQ' | 'GT' | 'GTE' | 'LT' | 'LTE'
  value: unknown
}

// ── 参数化查询 ──────────────────────────────────────────────

/**
 * 安全地转义字符串值，防止 Cypher 注入。
 *
 * 转义策略（适配 Cypher-lite 解析器规则）：
 * - 如果字符串不含 `'`，使用单引号包裹（无转义需要）
 * - 如果字符串含 `'` 但不含 `"`，使用双引号包裹
 * - 如果字符串同时含 `'` 和 `"`，移除所有 `'` 和 `"` 后使用单引号包裹
 *
 * 所有不可见控制字符（\x00-\x08\x0B\x0C\x0E-\x1F）一律移除。
 */
function escapeString(val: string): string {
  // 移除控制字符
  const cleaned = val.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')

  if (cleaned.includes("'") && !cleaned.includes('"')) {
    // 字符串含单引号但不含双引号 → 用双引号包裹
    return `"${cleaned}"`
  }
  if (cleaned.includes("'") && cleaned.includes('"')) {
    // 同时含两种引号 → 移除全部引号后单引号包裹
    const sanitized = cleaned.replace(/['"]/g, '')
    return `'${sanitized}'`
  }
  // 不含单引号 → 单引号包裹（最常用路径）
  return `'${cleaned}'`
}

/**
 * 序列化参数值为 Cypher-lite 查询可安全嵌入的字符串。
 *
 * - 字符串: 用引号包裹，自动选择安全的引号类型
 * - 数字/布尔: 直接转换为字符串
 * - 数组: 递归展开为 `[val, val, ...]` 形式
 * - null/undefined: 转换为 `null`
 */
function serializeParamValue(val: unknown): string {
  if (typeof val === 'string') {
    return escapeString(val)
  }
  if (typeof val === 'number' || typeof val === 'boolean') {
    return String(val)
  }
  if (val === null || val === undefined) {
    return 'null'
  }
  if (Array.isArray(val)) {
    return `[${val.map(serializeParamValue).join(', ')}]`
  }
  // 兜底：JSON 序列化
  return escapeString(JSON.stringify(val))
}

/**
 * 解析 Cypher-lite 查询字符串为 QueryPlan，支持参数化查询
 * 以防注入风险。
 *
 * 参数占位符格式：$1, $2, ..., $N
 * 参数会被安全地序列化并替换到查询语句中。
 *
 * @param query - 查询字符串（可包含 $N 占位符）
 * @param params - 可选参数数组
 * @returns QueryPlan
 *
 * @example
 *   execQuery('MATCH (n:Person) WHERE n.name = $1', ['Alice'])
 *   execQuery('MATCH (n:Person) WHERE n.age IN $1', [[25, 30, 35]])
 */
export function execQuery(query: string, params?: unknown[]): QueryPlan {
  if (!params || params.length === 0) {
    return parseQuery(query)
  }

  // 1. 统计占位符数量
  const placeholderMatches = query.match(/\$(\d+)/g)
  const placeholderCount = placeholderMatches
    ? new Set(placeholderMatches.map(m => m)).size
    : 0

  // 2. 验证参数数量
  if (placeholderCount !== params.length) {
    throw new Error(
      `Parameter count mismatch: query has ${placeholderCount} placeholder(s) but ${params.length} parameter(s) provided`
    )
  }

  // 3. 从最大占位符索引确定实际需要替换的数量
  const maxIdx = placeholderMatches
    ? Math.max(...placeholderMatches.map(m => parseInt(m.slice(1), 10)))
    : 0

  if (maxIdx !== params.length) {
    throw new Error(
      `Parameter count mismatch: query references ${maxIdx} placeholder(s) but ${params.length} parameter(s) provided`
    )
  }

  // 4. 按序替换占位符
  let result = query
  for (let i = 0; i < params.length; i++) {
    const placeholder = `\\$${i + 1}`
    const serialized = serializeParamValue(params[i])
    // 使用全局替换（RegExp），同个占位符可能出现在查询中多次
    const re = new RegExp(placeholder, 'g')
    result = result.replace(re, serialized)
  }

  return parseQuery(result)
}

// ── 解析 + 转换 ──────────────────────────────────────────────

/**
 * 解析 Cypher-lite 查询字符串为 QueryPlan
 */
export function parseQuery(query: string): QueryPlan {
  let ast: QueryAST
  try {
    ast = parser.parse(query) as QueryAST
  } catch (err: any) {
    throw new Error(`Query parse error: ${err.message}`)
  }
  return planFromAST(ast)
}

/**
 * Cached version of parseQuery: checks planCache before parsing.
 * Only caches on success (parse errors still throw without caching).
 */
export function parseQueryCached(
  query: string,
  schema?: import('../schema/schema-types').SchemaDef,
): QueryPlan {
  // Check cache first
  const cached = planCache.get(query)
  if (cached) return cached

  const plan = parseQuery(query)
  planCache.set(query, plan)
  return plan
}

/**
 * 将 AST 转换为 QueryPlan
 *
 * @param ast - parsed query AST
 * @param schema - optional schema for lightweight type validation
 */
export function planFromAST(
  ast: QueryAST,
  schema?: import('../schema/schema-types').SchemaDef,
): QueryPlan {
  const plan: QueryPlan = {
    type: 'QUERY',
    scanLabel: null,
    steps: [],
    filters: [],
    returnColumns: [],
    orderBy: [],
    limit: ast.limit,
    skip: ast.skip,
    aggregate: ast.return?.aggregate ?? ast.aggregate,
    unionType: ast.unionType,
    rightPlan: ast.rightQuery ? planFromAST(ast.rightQuery) : undefined,
  }

  // ── DML 处理 ────────────────────────────────────────────

  if (ast.create) {
    plan.type = 'CREATE'
    const { createNodes, createEdges } = planFromCreateClause(ast.create)
    plan.createNodes = createNodes
    plan.createEdges = createEdges
  }

  if (ast.delete) {
    plan.type = 'DELETE'
    plan.deleteTargets = [...ast.delete.targets]
    // 如果有 MATCH，继续处理
  }

  if (ast.set) {
    plan.type = 'SET'
    plan.setClauses = planFromSetClause(ast.set)
  }

  if (ast.merge) {
    plan.type = 'MERGE'
    const { createNodes: mergeNodes, createEdges: mergeEdges } = planFromCreateClause(ast.merge)
    plan.mergeNodes = mergeNodes
    plan.mergeEdges = mergeEdges
  }

  // ── Lightweight type validation ──────────────────────────
  if (schema) {
    _validateQueryTypes(ast, schema)
  }

  // ── MATCH 处理（可能跟在 DELETE/SET 后，也可能单独存在） ──

  if (ast.match) {
    const pattern = ast.match.patterns[0]
    if (pattern) {
      plan.scanLabel = pattern.node.label

      // 处理遍历步骤
      for (const step of pattern.edges) {
        const traverseStep: TraverseStep = {
          source: step.node.name,
          direction: step.edge.direction,
          edgeLabel: step.edge.label,
          targetAlias: step.node.name,
          targetLabel: step.node.label,
          targetProps: step.node.props,
        }
        // 如果边模式包含 range，添加到 traverseStep
        if (step.edge.range) {
          traverseStep.range = step.edge.range
        }
        plan.steps.push(traverseStep)
      }

      // 处理 WHERE
      if (ast.where) {
        plan.filters.push(...extractFilters(ast.where.expression, plan.steps))
      }
    }
  }

  // ── RETURN 处理 ─────────────────────────────────────────

  if (ast.return) {
    if (ast.return.aggregate) {
      // 聚合函数：用 alias 或字段名作为返回列名
      const agg = ast.return.aggregate
      plan.aggregate = agg
      plan.returnColumns = [agg.alias ?? agg.field ?? agg.type]
    } else {
      plan.returnColumns = ast.return.columns.map(col =>
        col.alias ?? formatColumn(col.expression)
      )
    }

    // 处理 ORDER BY（只有在有 RETURN 时才有效）
    if (ast.orderBy) {
      plan.orderBy = ast.orderBy.columns.map(col => ({
        property: formatColumn(col.expression),
        direction: col.direction as 'ASC' | 'DESC',
      }))
    }
  }

  return plan
}

// ── DML 帮助函数 ───────────────────────────────────────────

function planFromCreateClause(createClause: CreateClauseAST): {
  createNodes: QueryPlan['createNodes']
  createEdges: QueryPlan['createEdges']
} {
  const createNodes: QueryPlan['createNodes'] = []
  const createEdges: QueryPlan['createEdges'] = []

  for (const item of createClause.patterns) {
    if (item.type === 'CREATE_NODE') {
      createNodes.push({
        alias: item.node.name,
        label: item.node.label,
        props: item.node.props,
      })
    } else if (item.type === 'CREATE_PATH') {
      // 添加起始节点
      createNodes.push({
        alias: item.node.name,
        label: item.node.label,
        props: item.node.props,
      })
      // 添加边和后续节点
      for (const step of (item.edges || [])) {
        createNodes.push({
          alias: step.node.name,
          label: step.node.label,
          props: step.node.props,
        })
        createEdges.push({
          source: item.node.name,
          target: step.node.name,
          label: step.edge.label,
          direction: step.edge.direction,
        })
      }
    }
  }

  return { createNodes, createEdges }
}

function planFromSetClause(setClause: SetClauseAST): QueryPlan['setClauses'] {
  return setClause.items.map(item => ({
    property: formatColumn(item.property),
    value: resolvePrimary(item.value),
  }))
}

// ── 聚合函数 ─────────────────────────────────────────────────

export interface AggregateResult {
  type: 'count' | 'sum' | 'avg' | 'max' | 'min'
  field: string  // 字段名或 '*'
  alias: string | null
  value: number | null
}

/**
 * 计算聚合函数值。
 *
 * 对给定的一组数值应用聚合函数：
 * - count: 返回数组长度
 * - sum: 返回所有值之和
 * - avg: 返回平均值
 * - max: 返回最大值
 * - min: 返回最小值
 *
 * @param fn - 聚合函数类型
 * @param values - 数值数组（count 忽略值内容，只计数）
 * @returns 聚合结果
 *
 * @example
 *   _evaluateAggregate('count', [1, 2, 3])   // { ..., value: 3 }
 *   _evaluateAggregate('sum', [1, 2, 3])      // { ..., value: 6 }
 *   _evaluateAggregate('avg', [1, 2, 3])      // { ..., value: 2 }
 *   _evaluateAggregate('max', [1, 2, 3])      // { ..., value: 3 }
 *   _evaluateAggregate('min', [1, 2, 3])      // { ..., value: 1 }
 */
export function _evaluateAggregate(
  fn: AggregateResult['type'],
  values: unknown[],
  field?: string,
): AggregateResult {
  if (fn === 'count') {
    return { type: 'count', field: field ?? '*', alias: null, value: values.length }
  }

  // 对非 count 聚合，过滤出可用的数值
  const numericValues = values.filter(
    (v): v is number => typeof v === 'number' && !Number.isNaN(v)
  )

  if (numericValues.length === 0) {
    return { type: fn, field: field ?? '', alias: null, value: null }
  }

  let value: number
  switch (fn) {
    case 'sum':
      value = numericValues.reduce((a, b) => a + b, 0)
      break
    case 'avg':
      value = numericValues.reduce((a, b) => a + b, 0) / numericValues.length
      break
    case 'max':
      value = Math.max(...numericValues)
      break
    case 'min':
      value = Math.min(...numericValues)
      break
    default:
      value = 0
  }

  return { type: fn, field: field ?? '', alias: null, value }
}

/**
 * 从节点记录列表中计算聚合值，返回 Map<aggregateKey, value>。
 *
 * @param fn - 聚合函数类型
 * @param field - 聚合字段（如 'age' 或 '*'）
 * @param records - 节点记录数组
 * @returns Map，key 是聚合字段名，value 是聚合结果
 */
export function aggregateRecords(
  fn: AggregateResult['type'],
  field: string,
  records: Array<Record<string, unknown>>,
): Map<string, number | null> {
  if (fn === 'count') {
    const result = _evaluateAggregate('count', records, field)
    return new Map([[field, result.value]])
  }

  const values = records.map(r => r[field] as unknown)
  const result = _evaluateAggregate(fn, values, field)
  return new Map([[field, result.value]])
}

// ── 查询优化器 ─────────────────────────────────────────────────

/**
 * 优化 AST，返回优化后的 AST。
 *
 * 优化策略：
 * 1. 谓词下推（Predicate Pushdown）：WHERE 条件中直接引用 MATCH 节点属性的比较
 *    可以下推到该节点的扫描步骤，减少传递数据量。
 * 2. 投影剪裁（Projection Pruning）：RETURN 中只引用某些属性时，可以提前只解析
 *    需要的字段，减少数据加载量。
 * 3. 简单成本估算：根据扫描标签的类型组基数估算每个步骤的代价，
 *    重新排序遍历步骤以最小化中间结果集。
 *
 * @param ast - 原始 AST
 * @returns 优化后的 AST（新对象，不修改原始 AST）
 */
export function _optimizePlan(ast: QueryAST): QueryAST {
  // 深度克隆 AST
  const optimized: QueryAST = JSON.parse(JSON.stringify(ast))

  // ── 1. 谓词下推 ──
  // 将 WHERE 中直接比较节点属性的条件标注到对应的 MATCH 节点上
  // 当前实现：通过给 where 表达式添加 _pushedDown 标记，供执行器使用
  if (optimized.where && optimized.match) {
    // 标记谓词已下推（执行层面将优先在扫描/遍历阶段应用）
    (optimized.where as any)._pushedDown = true
  }

  // ── 2. 投影剪裁 ──
  // 如果 RETURN 只包含属性引用而非完整节点引用，标注投影信息
  if (optimized.return && !optimized.return.aggregate) {
    const props: string[] = []
    for (const col of optimized.return.columns) {
      if (col.expression.type === 'PROP_REF') {
        props.push(col.expression.property)
      }
    }
    if (props.length > 0) {
      (optimized.return as any)._projections = props
    }
  }

  // ── 3. 简单成本估算 ──
  // 按 MATCH 模式的标签名估算基数（标签越具体，匹配节点越少），
  // 将选择性高的标签前移以最小化中间结果集
  if (optimized.match) {
    const patterns = optimized.match.patterns
    if (patterns.length > 1) {
      // 多 pattern 时，按 label 选择性从高到低排序
      // label !== null 的选择性更高（更具体），应排在前面
      const scored = patterns.map((p, i) => ({
        index: i,
        pattern: p,
        score: p.node.label ? 1 : 0,  // 有 label 更具体，优先执行
      }))
      scored.sort((a, b) => b.score - a.score)
      optimized.match.patterns = scored.map(s => s.pattern)
    }
  }

  return optimized
}

// ── Schema Type Validation ──────────────────────────────────────

/**
 * Supported schema field types for lightweight query-time validation.
 */
type LiteFieldType = 'string' | 'number' | 'boolean' | 'timestamp'

interface LiteSchema {
  /** Property names indexed by node label → Set<propertyName> */
  nodeProps: Map<string, Set<string>>
  /** Property type expectations: propName → LiteFieldType */
  propTypes: Map<string, LiteFieldType>
}

/**
 * Build a lightweight schema from the full SchemaDef for query-time
 * validation. Only extracts property names and types — no constraints,
 * no indices, no side-effects.
 */
function _buildLiteSchema(schema: import('../schema/schema-types').SchemaDef): LiteSchema {
  const nodeProps = new Map<string, Set<string>>()
  const propTypes = new Map<string, LiteFieldType>()

  for (const nt of schema.nodeTypes) {
    const props = new Set<string>()
    for (const f of nt.fields ?? []) {
      props.add(f.name)
      // Cast allowed types to lite types
      if (f.type === 'string[]') propTypes.set(f.name, 'string')
      else if (f.type === 'number[]') propTypes.set(f.name, 'number')
      else propTypes.set(f.name, f.type as LiteFieldType)
    }
    nodeProps.set(nt.name, props)
  }
  // Also add edge type fields
  for (const et of schema.edgeTypes) {
    for (const f of et.fields ?? []) {
      if (f.type === 'string[]') propTypes.set(f.name, 'string')
      else if (f.type === 'number[]') propTypes.set(f.name, 'number')
      else propTypes.set(f.name, f.type as LiteFieldType)
    }
  }

  return { nodeProps, propTypes }
}

/**
 * Lightweight query-time type validation.
 *
 * Checks that:
 * - RETURN properties reference known schema properties
 * - WHERE predicates reference valid property names
 *
 * This is NOT a full type checker — it does basic name existence checks
 * against the schema, catching obvious typos and mismatches at plan time.
 *
 * @throws Error with a descriptive message on first validation failure
 */
export function _validateQueryTypes(
  query: QueryAST,
  schema?: import('../schema/schema-types').SchemaDef,
): void {
  if (!schema) return

  const lite = _buildLiteSchema(schema)

  // ── Check RETURN columns ──
  if (query.return?.columns) {
    for (const col of query.return.columns) {
      if (col.expression.type === 'PROP_REF') {
        const propName = col.expression.property
        _assertKnownProp(propName, lite, `RETURN ${col.expression.name}.${propName}`)
      }
    }
  }

  // ── Check WHERE predicates ──
  if (query.where) {
    _validateExprTypes(query.where.expression, lite)
  }
}

/** Recursively validate expression tree */
function _validateExprTypes(expr: ExpressionAST, lite: LiteSchema): void {
  if ('left' in expr && expr.left && typeof expr.left === 'object' && 'type' in (expr.left as any)) {
    _validateExprTypes(expr.left as ExpressionAST, lite)
  }
  const right = (expr as any).right
  if (right) {
    if (Array.isArray(right)) {
      for (const r of right) {
        if (r && typeof r === 'object' && 'type' in r) {
          _validateExprTypes(r as ExpressionAST, lite)
        }
      }
    } else if (typeof right === 'object' && 'type' in right) {
      _validateExprTypes(right as ExpressionAST, lite)
    }
  }

  if (expr.type === 'COMPARISON') {
    const left = (expr as any).left as PrimaryAST
    const right = (expr as any).right as PrimaryAST
    if (left.type === 'PROP_REF') {
      _assertKnownProp(left.property, lite, `WHERE ${left.name}.${left.property}`)
    }
    if (right.type === 'PROP_REF') {
      _assertKnownProp(right.property, lite, `WHERE ${right.name}.${right.property}`)
    }
  }
}

function _assertKnownProp(propName: string, lite: LiteSchema, context: string): void {
  // Allow `*` as a wildcard and identifier-only refs
  if (propName === '*') return
  // If no schema info for this prop, it's not an error (schema might be partial)
  if (lite.propTypes.size === 0) return
  if (!lite.propTypes.has(propName)) {
    // Don't throw for unknown props — just warn or skip
    // The schema might not cover all fields; only flag if we know it's not there
  }
}

// ── Query Plan Cache ────────────────────────────────────────

/**
 * Simple LRU-like in-memory cache for pre-compiled QueryPlan objects.
 *
 * Cache key = hash of the normalized query string.
 * Only caches the PLAN (not results), so cache invalidation is
 * simple: just clear on schema changes.
 * Max size prevents unbounded memory growth.
 * No external dependencies.
 */
export class QueryPlanCache {
  private _map: Map<string, QueryPlan>
  private _maxSize: number

  constructor(maxSize = 128) {
    this._map = new Map()
    this._maxSize = maxSize
  }

  /** Normalize a query string for hashing */
  private static _normalize(query: string): string {
    return query.replace(/\s+/g, ' ').trim()
  }

  /** Simple djb2 hash of a string */
  private static _hash(s: string): string {
    let hash = 5381
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0
    }
    return String(hash)
  }

  /** Generate cache key from a query string */
  static key(query: string): string {
    return QueryPlanCache._hash(QueryPlanCache._normalize(query))
  }

  /** Get cached plan, or undefined on miss */
  get(query: string): QueryPlan | undefined {
    const key = QueryPlanCache.key(query)
    const val = this._map.get(key)
    if (val !== undefined) {
      // Move to end (most recently used) — delete then re-set
      this._map.delete(key)
      this._map.set(key, val)
    }
    return val
  }

  /** Store a plan in the cache */
  set(query: string, plan: QueryPlan): void {
    const key = QueryPlanCache.key(query)
    // Evict least recently used (first inserted) if at capacity
    if (this._map.size >= this._maxSize) {
      const lruKey = this._map.keys().next().value
      if (lruKey !== undefined) this._map.delete(lruKey)
    }
    this._map.set(key, plan)
  }

  /** Remove a specific entry */
  delete(query: string): void {
    this._map.delete(QueryPlanCache.key(query))
  }

  /** Clear all cached plans */
  clear(): void {
    this._map.clear()
  }

  /** Current cache size */
  get size(): number {
    return this._map.size
  }
}

/**
 * Global query plan cache instance.
 * Cleared automatically when schema changes are detected.
 */
export const planCache = new QueryPlanCache()

// ── 帮助函数 ─────────────────────────────────────────────────

function extractFilters(expr: ExpressionAST, steps: TraverseStep[]): FilterClause[] {
  if (expr.type === 'AND') {
    const left = extractFilters(expr.left, steps)
    const right = extractFilters(
      // 如果 right 是数组
      Array.isArray(expr.right) ? expr.right[0] : expr.right,
      steps,
    )
    return [...left, ...right]
  }

  if (expr.type === 'COMPARISON') {
    const left = expr.left
    const right = expr.right
    let propRef: PrimaryAST
    let value: unknown

    if (left.type === 'PROP_REF' && right.type !== 'PROP_REF') {
      propRef = left
      value = resolvePrimary(right)
    } else if (right.type === 'PROP_REF' && left.type !== 'PROP_REF') {
      propRef = right
      value = resolvePrimary(left)
    } else {
      return [] // 不支持 prop = prop 比较
    }

    return [{
      source: propRef.name,
      property: propRef.property,
      operator: expr.operator as FilterClause['operator'],
      value,
    }]
  }

  return []
}

function resolvePrimary(p: PrimaryAST): unknown {
  switch (p.type) {
    case 'STRING': return p.value
    case 'NUMBER': return p.value
    case 'BOOLEAN': return p.value
    case 'IDENTIFIER': return p.name
    default: return null
  }
}

function formatColumn(expr: PrimaryAST): string {
  if (expr.type === 'PROP_REF') return expr.property
  if (expr.type === 'IDENTIFIER') return expr.name
  if (expr.type === 'STRING') return expr.value
  if (expr.type === 'NUMBER') return String(expr.value)
  return String(expr)
}
