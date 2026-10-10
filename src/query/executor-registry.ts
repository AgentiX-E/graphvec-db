/**
 * query-executor.ts — Cypher Query 执行器
 *
 * 包含：
 *   - Index/Constraint/Database 注册表
 *   - GE 实例注册表
 *   - _executeViaGraphEngine / _executeQuery / _validatePlan
 *   - 所有执行辅助函数
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { parseCypherToPlan } from './ast-to-plan-v2'
import { GraphEngine } from '../core/graph-engine'
import type { OverGraphConfig } from '../types'
import { globalRegistry as _procedureRegistry } from './procedure-registry'
import { _evaluateExpression, _postProcessResults, QueryRow, _parseAggregate, _extractAggColumns, _hasAggregates, _executeAggregation, _enrichWithAggregates, _validateLiterals, _bigintReplacer, _bigintReviver } from './expression-engine'
import { executeVarLenPath } from './var-length-path'
import { _walkMultiSteps, _pathEndIndices, _stepMatchConstraint, _resolveUnwindList, _extractWithClausesAfterUnwind, _applyYieldAliases, resolveVariableNodeIdx, _findWhereOutsideBrackets } from './query-parser'
import { evalForeachCondTop, applyForeachOpTop, executeForeachInlineTop } from './foreach-exec'
import type { QueryPlan, FilterClause, TraverseStep, AggregateClause } from './query-types'
import { parseQuery } from './query-parser'
import { GEPool } from './ge-pool'

// ── 内存索引注册表（CREATE INDEX / DROP INDEX）━━━━━━━━━━━━━━━

// ── 持久化路径 ──
const _storePath = path.resolve('.opengraph/index-constraint-store.json')

// ── 内存索引注册表（CREATE INDEX / DROP INDEX） ──
export interface IndexEntry { label: string; property: string }
const _indexRegistry = new Map<string, IndexEntry>()
function _saveStore(): void {
  try {
    const dir = path.dirname(_storePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(_storePath, JSON.stringify({
      indexes: Array.from(_indexRegistry.values()),
      constraints: Array.from(_constraintRegistry.values()),
    }, null, 2), 'utf8')
  } catch { /* 非关键Error，静默处理 */ }
}
export function _registerIndex(label: string, property: string): void {
  _indexRegistry.set(`${label}:${property}`, { label, property }); _saveStore()
}
export function _dropIndex(label: string, property: string): void {
  _indexRegistry.delete(`${label}:${property}`); _saveStore()
}
export function _getAllIndexes(): IndexEntry[] {
  return Array.from(_indexRegistry.values())
}
export function _getIndex(label: string, property: string): IndexEntry | undefined {
  return _indexRegistry.get(`${label}:${property}`)
}
export function _clearIndexes(): void { _indexRegistry.clear(); _saveStore() }

// ── 约束注册表（唯一性约束） ──
export interface ConstraintEntry { name: string; label: string; property: string; type: 'UNIQUE' }
const _constraintRegistry = new Map<string, ConstraintEntry>()
export function _registerConstraint(name: string, label: string, property: string): void {
  _constraintRegistry.set(name, { name, label, property, type: 'UNIQUE' }); _saveStore()
}
export function _dropConstraint(name: string): void { _constraintRegistry.delete(name); _saveStore() }
export function _getAllConstraints(): ConstraintEntry[] {
  return Array.from(_constraintRegistry.values())
}
export function _clearConstraints(): void { _constraintRegistry.clear(); _saveStore() }

// ── 启动时自动加载持久化索引/约束 ──
/**
 * 从持久化 store 文件加载索引/约束到内存注册表。
 * 抽为可导出函数：既供模块顶层启动调用，也供测试直接验证加载分支，
 * 避免测试依赖 `vi.resetModules()` 重载模块（会 fork 出第二份单例注册表，
 * 破坏跨文件隔离并制造 flaky 失败）。
 */
export function _loadStoreFromDisk(): void {
  try {
    if (fs.existsSync(_storePath)) {
      const raw = fs.readFileSync(_storePath, 'utf8')
      const data = JSON.parse(raw)
      if (data.indexes) for (const idx of data.indexes) { _indexRegistry.set(idx.label+':'+idx.property, idx) }
      if (data.constraints) for (const c of data.constraints) { _constraintRegistry.set(c.name, c) }
    }
  } catch { /* 启动恢复失败不阻塞 */ }
}
_loadStoreFromDisk()

// ── 数据库注册表（CATALOG 多图命名空间） ──
// 默认数据库（neo4j）始终存在
export const DEFAULT_DATABASE = 'neo4j'
const _databaseRegistry = new Set<string>([DEFAULT_DATABASE])
let _activeDatabase = DEFAULT_DATABASE
export function _getActiveDatabase(): string { return _activeDatabase }
export function _setActiveDatabase(name: string): void {
  if (_databaseRegistry.has(name)) { _activeDatabase = name }
}
export function _createDatabase(name: string): void { _databaseRegistry.add(name) }
export function _dropDatabase(name: string): void {
  if (name !== DEFAULT_DATABASE) {
    _databaseRegistry.delete(name)
    if (_activeDatabase === name) _activeDatabase = DEFAULT_DATABASE
  }
}
export function _getAllDatabases(): string[] { return Array.from(_databaseRegistry) }
export function _clearDatabases(): void {
  _databaseRegistry.clear()
  _databaseRegistry.add(DEFAULT_DATABASE)
  _activeDatabase = DEFAULT_DATABASE
}

// ── GE 实例注册表（多数据库隔离） ──
const _geInstanceRegistry = new Map<string, GraphEngine>()

/**
 * 共享 GE 实例池 — 从单例 hack 到正式弹性连接池。
 *
 * 使用 GEPool class（src/query/ge-pool.ts）：
 * - 支持 maxSize（默认 4）和 idleTimeout（默认 60s）
 * - getConnection(isWrite) / releaseConnection(ge)
 * - 写操作独占实例，读操作复用最近最少使用的实例
 * - 空闲超时自动回收
 *
 * 向后兼容：_gePool.value 保持为快速引用（池中第一个实例或 null）
 */
const _gePool: { value: GraphEngine | null } = { value: null }

/** Trace GE 实例的 LMDB 目录路径，用于复用时 reopen 已有目录 */
const _geDirRegistry = new Map<string, string>()

export function _clearGeInstances(): void {
  // 关闭 database-specific GE 实例（CATALOG 多图隔离），但不删除其磁盘目录，
  // 以免与后续 ge.open() 产生 "No such file or directory (os error 2)" 竞态。
  for (const [, ge] of _geInstanceRegistry) {
    try { ge.close() } catch {}
  }
  _geInstanceRegistry.clear()
  _geDirRegistry.clear()
  // 清除 pool 中的 GE 实例引用
  _gePool.value = null
  // 关闭弹性连接池单例（GEPool）但不删除磁盘目录：清空 in-memory 实例即可。
  // 数据隔离由 query-executor.seed 前的 ge.clearAllData() 负责（见
  // _executeViaGraphEngine），删除 /tmp/tckge-pool 目录会与池重建的
  // mkdirSync+open 产生竞态，导致 count(*) 聚合返回陈旧的超额节点或
  // "I/O error: os error 2" 这类 flaky 失败。
  GEPool.destroyInstance()
}

export const DEFAULT_LIMIT = 1000


// ── 内部暴露（给 query-executor 使用） ──
export { _geInstanceRegistry, _gePool, _geDirRegistry, _indexRegistry }
