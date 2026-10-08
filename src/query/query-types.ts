/**
 * query-types.ts — Cypher Query 类型定义
 *
 * 从 query-engine.ts 拆分出的纯类型模块。
 * 包含所有 AST 节点类型、QueryPlan、TraverseStep、FilterClause 等。
 * 零依赖：不引用任何运行时模块。
 */

import type { ForEachClause } from './ast-to-plan-v2'

// ── AST 类型 ─────────────────────────────────────────────────

export interface QueryAST {
  type: 'QUERY'
  match?: {
    type: 'MATCH'
    patterns: PatternAST[]
  }
  /** OPTIONAL MATCH clauses */
  optionalMatches?: Array<{
    type: 'OPTIONAL_MATCH'
    patterns: PatternAST[]
    where?: WhereClauseAST | null
  }>
  /** WITH clause */
  with?: WithClauseAST
  where?: WhereClauseAST | null
  return?: ReturnClauseAST
  orderBy?: OrderByAST | null
  /** GROUP BY columns */
  groupBy?: PrimaryAST[]
  limit?: number | undefined
  skip?: number | undefined
  aggregate?: AggregateClause
  unionType?: 'union' | 'union_all' | 'intersect' | 'subtract'
  rightQuery?: QueryAST
  // DML fields
  create?: CreateClauseAST
  delete?: DeleteClauseAST
  set?: SetClauseAST
  remove?: RemoveClauseAST
  merge?: MergeClauseAST
  /** Periodic commit hint: USING PERIODIC COMMIT [batchSize] */
  periodicCommitHint?: {
    type: 'PERIODIC_COMMIT_HINT'
    batchSize?: number
  }
}

export interface ConstraintClauseAST {
  type: 'CREATE_CONSTRAINT'
  label: string
  property: string
}

/** WITH clause: WITH expr1 AS alias1, expr2 AS alias2 [WHERE condition] [ORDER BY ...] [LIMIT n] */
export interface WithClauseAST {
  type: 'WITH'
  columns: ColumnAST[]
  where?: WhereClauseAST | null
  orderBy?: OrderByAST | null
  limit?: number | undefined
  skip?: number | undefined
  aggregate?: AggregateClause
  aggregates?: AggregateClause[]
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

export interface RemoveClauseAST {
  type: 'REMOVE'
  items: RemoveItemAST[]
}

export interface RemoveItemAST {
  type: 'REMOVE_PROP' | 'REMOVE_LABEL'
  property?: string
  name?: string
  ref?: string
  label?: string
}

export interface MergeClauseAST {
  type: 'MERGE'
  patterns: CreateNodeItemAST[]
  onCreate?: SetClauseAST
  onMatch?: SetClauseAST
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
  labelExpr: {
    type: 'LABEL_EXPR'
    items: Array<{ exclude: boolean; name: string }>
  } | null
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
  | { type: 'NOT'; expr: ExpressionAST }
  | { type: 'OR'; left: ExpressionAST; right: ExpressionAST | ExpressionAST[] }
  | { type: 'AND'; left: ExpressionAST; right: ExpressionAST | ExpressionAST[] }
  | { type: 'COMPARISON'; operator: string; left: PrimaryAST; right: PrimaryAST }
  | { type: 'NULL_PREDICATE'; expr: PrimaryAST; not: boolean }
  | PrimaryAST

export type PrimaryAST =
  | { type: 'NOT' } // placeholder - not matched as Primary
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
  type: 'count' | 'sum' | 'avg' | 'max' | 'min' | 'collect'
  field?: string  // 如 n.age
  alias?: string  // AS alias
  distinct?: boolean  // DISTINCT modifier (for COLLECT, COUNT)
}

// ── Query Plan ─────────────────────────────────────────────────

export interface QueryPlan {
  /** 操作类型 */
  type?: 'QUERY' | 'CREATE' | 'DELETE' | 'SET' | 'MERGE' | 'CALL' | 'USE' | 'CREATE_CONSTRAINT' | 'BEGIN' | 'COMMIT' | 'ROLLBACK'
  /** USE 的图名称（用于 multi-graph 命名空间切换） */
  useGraph?: string
  /** CATALOG 操作（多图命名空间） */
  catalogOp?: 'CREATE_DATABASE' | 'DROP_DATABASE' | 'SHOW_DATABASES'
  /** EXPLAIN: 展示执行计划但不执行 */
  explain?: boolean
  /** PROFILE: 执行并收集每步统计Info */
  profile?: boolean
  /** INDEX 操作：'CREATE' 或 'DROP' */
  indexOp?: 'CREATE' | 'DROP'
  /** INDEX 目标标签 */
  indexLabel?: string
  /** INDEX 目标属性 */
  indexProperty?: string
  /** 起始节点标签扫描（如果 MATCH 节点指定了 label） */
  scanLabel: string | null
  /** 标签表达式（如 Person|Animal, !Person 等） */
  labelExpr: {
    type: 'LABEL_EXPR'
    items: Array<{ exclude: boolean; name: string }>
  } | null
  /** 遍历步骤 */
  steps: TraverseStep[]
  /** WHERE 过滤器 */
  filters: FilterClause[]
  /** WHERE 子句原始文本（用于表达式引擎后处理） */
  whereBody?: string
  /** RETURN 列 */
  returnColumns: string[]
  /** Top-level DISTINCT modifier (`RETURN DISTINCT ...`) — deduplicate result rows. */
  distinct?: boolean
  /** returnColumn 到原始表达式的映射（用于 DML 结果构造：RETURN n.name AS p → {p: "n.name"}） */
  returnAliasMap?: Record<string, string>
  /** 计算列（字符串拼接、表达式等，运行时求值） */
  expressionColumns?: Array<{
    expression: any
    alias: string
  }>
  /** 编译期常数列（纯字面量表达式折叠后的值） */
  constColumns?: Array<{
    alias: string
    value: unknown
  }>
  /** ORDER BY */
  orderBy: Array<{ property: string; direction: 'ASC' | 'DESC' }>
  /** LIMIT */
  limit: number | undefined
  /** SKIP */
  skip: number | undefined
  /** 是否来自 MATCH 扫描（用于区分无标签 MATCH 和纯 WITH/UNWIND） */
  hasMatch?: boolean
  /** 聚合子句（如 count, sum, avg, max, min） */
  aggregate?: AggregateClause
  /** All aggregate clauses (supports multiple aggregates in a single RETURN,
   *  e.g. `RETURN agg1(...), agg2(...)`).  Consistent with `aggregate`: for a
   *  single aggregate both are equivalent; for several, `aggregate` holds the first. */
  aggregates?: AggregateClause[]
  /** GROUP BY 列 */
  groupBy?: string[]
  /** HAVING 过滤器 */
  having?: HavingClause[]
  /** OPTIONAL MATCH 步骤（如果匹配不到返回 null 绑定） */
  optionalMatchSteps?: Array<{
    scanLabel: string | null
    steps: TraverseStep[]
    filters: FilterClause[]
    variableName?: string
  }>
  /** WITH 子句：管道中间投影 */
  with?: {
    columns: Array<{
      expression: string
      alias: string | null
    }>
    filters: FilterClause[]
    orderBy: Array<{ property: string; direction: 'ASC' | 'DESC' }>
    limit: number | undefined
    skip: number | undefined
    aggregate?: AggregateClause
    /** All aggregate clauses in this WITH projection (supports several
     *  aggregates, e.g. `WITH count(DISTINCT r1) AS H1, count(DISTINCT r2) AS H2`).
     *  `aggregate` holds the first for backwards compatibility. */
    aggregates?: AggregateClause[]
  }
  /** 多 WITH 管道：按出现顺序保留的每个 WITH 子句（含 WITH chain） */
  withChain?: Array<{
    columns: Array<{
      expression: string
      alias: string | null
    }>
    filters: FilterClause[]
    orderBy: Array<{ property: string; direction: 'ASC' | 'DESC' }>
    limit: number | undefined
    skip: number | undefined
    aggregate?: AggregateClause
    aggregates?: AggregateClause[]
  }>
  /** 集合运算类型 */
  unionType?: 'union' | 'union_all' | 'intersect' | 'subtract'
  /** 集合运算右半部分 */
  rightPlan?: QueryPlan
  /** UNWIND 子句 */
  unwind?: {
    list: any[]
    name: string
    var?: string  // 变量名引用（如 UNWIND list AS x 中 list 是变量名）
  }
  /** 第二个 UNWIND（UNWIND 链：UNWIND a AS x UNWIND b AS y） */
  secondUnwind?: {
    list: any[]
    name: string
    var?: string
  }
  /** 多级 UNWIND 数组（支持 N 级，由 ast-to-plan-v2.ts 收集） */
  unwinds?: Array<{ list: any[]; name: string }>
  /** CASE 表达式列（需要运行时求值的复杂表达式） */
  caseColumns?: Array<{
    expression: any  // CASE AST 节点
    alias: string   // 该列名（与 returnColumns 对应）
  }>
  /** Pattern Comprehension 列（在 RETURN 中出现的模式推导） */
  comprehensionColumns?: Array<{
    expression: any  // PATTERN_COMPREHENSION AST 节点
    alias: string   // 该列名
  }>
  /** EXISTS 子查询过滤器 */
  existsFilters?: Array<{
    source: string
    edgeLabel: string | null
    direction: 'out' | 'in' | 'any'
    target: string
  }>
  /** 列表表达式列（LIST / SUBSCRIPT / SLICE / ADD 等需要运行时求值的表达式） */
  listColumns?: Array<{
    expression: any
    alias: string
  }>
  /** CALL 子查询 */
  callQuery?: QueryPlan
  /** CALL 子查询的 IN TRANSACTIONS 标志：分批提交 */
  inTransactions?: boolean
  /** IN TRANSACTIONS OF N ROWS 的自定义批次大小 */
  inTransactionsBatchSize?: number
  /** CALL 过程调用 */
  callProcedure?: {
    name: string
    args: any[]
    yieldItems?: Array<{ name: string; alias: string | null }>
  }
  /** FOREACH 子句：列表迭代执行子查询 */
  forEach?: ForEachClause
  /** REDUCE 表达式：列表累积归约 */
  reduce?: {
    accumulator: string
    initial: unknown
    variable: string
    list: unknown[]
    isVarRef: boolean
    expression: string
  }
  /** LOAD CSV 子句 */
  loadCsv?: {
    url: string
    rowVariable: string
    hasHeaders: boolean
    delimiter: string
  }
  /** SHOW 元数据查询 */
  show?: string
  /** SEARCH 向量搜索子句（ANN / approximate最近邻） */
  search?: {
    /** 搜索的目标属性（如 'n.embedding'） */
    targetProperty: string
    /** 查询向量（数组形式） */
    queryVector: number[]
    /** 返回的最近邻数量 TOP K */
    topK: number
  }
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
    sourceIdx?: number
    targetIdx?: number
    label: string | null
    direction: 'out' | 'in' | 'any'
  }>
  /** DELETE 目标 */
  deleteTargets?: string[]
  /** DETACH DELETE 标志：删除节点前先删除所有关联边 */
  detachDelete?: boolean
  /** SET 子句 */
  setClauses?: SetClause[]
  /** REMOVE 子句 */
  removeClauses?: Array<{
    type: 'REMOVE_PROP' | 'REMOVE_LABEL'
    property?: string
    ref?: string
    label?: string
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
  /** MERGE ON CREATE 子句 */
  mergeOnCreate?: Array<{
    property: string
    value: unknown
  }>
  /** MERGE ON MATCH 子句 */
  mergeOnMatch?: Array<{
    property: string
    value: unknown
  }>
  /** USING INDEX n:Label(prop) 查询提示 — 指定使用哪个索引加速 */
  _indexHint?: { var: string; label: string; property: string }
  /** USING PERIODIC COMMIT 提示 — 分批提交批次大小 */
  periodicCommit?: {
    batchSize?: number
  }
  /** CREATE CONSTRAINT 约束Info */
  constraint?: {
    label: string
    property: string
  }
  /** 运行时注解（由执行引擎填充，用于缓存验证、标签过滤等） */
  _annotations?: {
    scanLabel?: string
    nodeCount?: number
    edgeCount?: number
    cacheKey?: string
  }
  /** 标签过滤器条目（list label filter） */
  labelFilterItems?: Array<{
    variable: string
    label: string
    exclude: boolean
  }>
  /** CALL 裸参数字典（当 CALL 子句使用参数化调用时） */
  _bareCallParams?: Record<string, unknown>
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
  operator: 'EQ' | 'NEQ' | 'GT' | 'GTE' | 'LT' | 'LTE' | 'IN' | 'STARTS_WITH' | 'ENDS_WITH' | 'CONTAINS' | 'IS_NULL' | 'IS_NOT_NULL'
  value: unknown
  /** NOT 否定标记 */
  negated?: boolean
  /** 复合表达式（算术/函数）左侧，如 `n.num % 2`。存在时 source/property 为空，执行层用 _evaluateExpression 求值。 */
  expression?: string
}

// ── HAVING 子句（查询引擎内联聚合过滤） ─────────────────────

export interface HavingClause {
  aggregate: string
  operator: string
  value: unknown
}

export type { ForEachClause }

// ── DML 子句类型 ────────────────────────────────────────────

/** SET 子句：property=value 赋值，Optional alias 指定目标变量 */
export interface SetClause {
  property: string
  value: unknown
  /** 目标变量名（如 SET n.name='x' → alias='n'） */
  alias?: string
  /** 表达式字符串（原始 AST 文本） */
  expression?: string
}

/** 内部节点：包含 _label、__edges 等运行时标记 */
export interface InternalNode extends Record<string, unknown> {
  _label: string
  _alias?: string
  __edges?: Array<{
    dstIdx: number
    srcIdx: number
    label: string
    props?: Record<string, unknown>
  }>
  /** 运行时标签全名（如 'Person' 而不是 GE 的短 ID） */
  __fullLabel?: string
}
