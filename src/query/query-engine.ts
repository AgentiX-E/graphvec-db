/**
 * query-engine.ts — 查询引擎统一入口（Facade）
 *
 * 此文件为所有查询引擎组件的公共入口。
 * 实际实现在：
 *   - query-types.ts       — 类型定义
 *   - query-parser.ts      — 解析器（parseQuery, execQuery）
 *   - query-executor.ts    — 执行器（_executeQuery, _validatePlan, 注册表等）
 *   - query-params.ts      — 参数化查询（ParameterizedQuery, cypher, compileCypher）
 *   - expression-engine.ts — 表达式引擎
 *   - ast-to-plan-v2.ts    — ANTLR 适配器
 *   - foreach-exec.ts      — FOREACH 执行
 *   - var-length-path.ts   — 变长路径
 *   - procedure-registry.ts— 过程注册表
 */

// ── 解析器 ──
export { parseQuery, execQuery } from './query-parser'
// ── 参数化查询 ──
export { ParameterizedQuery, cypher, compileCypher } from './query-params'
// ── 类型定义 ──
export type {
  QueryAST, ConstraintClauseAST, WithClauseAST, CreateClauseAST, CreateNodeItemAST,
  DeleteClauseAST, SetClauseAST, SetItemAST, RemoveClauseAST, RemoveItemAST,
  MergeClauseAST, PatternAST, NodePatternAST, EdgeStepAST, WhereClauseAST,
  ExpressionAST, PrimaryAST, ReturnClauseAST, ColumnAST, OrderByAST, OrderColumnAST,
  AggregateClause, QueryPlan, TraverseStep, FilterClause, HavingClause,
} from './query-types'
// ── 执行器 ──
export {
  _executeQuery, _validatePlan,
  _registerIndex, _dropIndex, _getAllIndexes, _getIndex, _clearIndexes,
  _registerConstraint, _dropConstraint, _getAllConstraints, _clearConstraints,
  _getActiveDatabase, _setActiveDatabase, _createDatabase, _dropDatabase,
  _getAllDatabases, _clearDatabases, _clearGeInstances, DEFAULT_LIMIT,
  IndexEntry, ConstraintEntry,
} from './query-executor'
