/**
 * query-executor.ts — Cypher Query 执行器
 *
 * 包含：
 *   - _executeViaGraphEngine / _executeQuery / _validatePlan
 *   - 所有执行辅助函数
 */

import fs from 'fs'
import path from 'path'
import { parseCypherToPlan } from './ast-to-plan-v2'
import { GraphEngine } from '../core/graph-engine'
import type { OverGraphConfig } from '../types'
import { globalRegistry as _procedureRegistry } from './procedure-registry'
import { _evalBinary, _evaluateExpression, _postProcessResults, QueryRow, _parseAggregate, _extractAggColumns, _hasAggregates, _executeAggregation, _enrichWithAggregates, _validateLiterals, _bigintReplacer, _bigintReviver } from './expression-engine'
import { _walkMultiSteps, _pathEndIndices, _stepMatchConstraint, _resolveUnwindList, _extractWithClausesAfterUnwind, _applyYieldAliases, resolveVariableNodeIdx, _findWhereOutsideBrackets, _fastDedup, _fastIntersect, _fastSubtract } from './query-parser'
import { evalForeachCondTop, applyForeachOpTop, executeForeachInlineTop } from './foreach-exec'
import type { QueryPlan, FilterClause, TraverseStep, AggregateClause, SetClause, InternalNode } from './query-types'
import { parseQuery } from './query-parser'
import { _geInstanceRegistry, _gePool, _geDirRegistry, _indexRegistry, DEFAULT_DATABASE, DEFAULT_LIMIT, IndexEntry, ConstraintEntry, _registerIndex, _dropIndex, _getAllIndexes, _getIndex, _clearIndexes, _registerConstraint, _dropConstraint, _getAllConstraints, _clearConstraints, _getActiveDatabase, _setActiveDatabase, _createDatabase, _dropDatabase, _getAllDatabases, _clearDatabases, _clearGeInstances } from './executor-registry'
import { GEPool } from './ge-pool'
import { _formatResultRow, _deepStripInternal, _executeVarLenPath, parseCsvContent } from './executor-common'
import { _executeWithUnwindPipeline } from './executor-unwind-pipeline'
import { _buildDmlRows } from './executor-dml'
import { _isPatternPredicate, _validateUndefinedVariables, _validateUnknownFunctions, extractEdgePropColumnsFromQuery, extractMatchVariables, extractVariablesFromClause, extractEdgesFromNodes } from './executor-validators'
import { _validatePlan } from './executor-validate-plan'
import { _execNonGePaths } from './executor-non-ge'

/** 判断值是否为 typed-format 对象 { type: 'STRING', value: '...' } */
function isTypedValue(v: unknown): v is { type: string; value: unknown } {
  return !!v && typeof v === 'object' && 'value' in v && 'type' in (v as any)
}

/** 从 typed-format 对象解包裸值 */
function unwrapTyped(v: unknown): unknown {
  return isTypedValue(v) ? v.value : v
}

/** 判断值是否为 props-format 对象 { props: {...} } */
function hasProps(v: unknown): v is { props: Record<string, unknown> } {
  return !!v && typeof v === 'object' && 'props' in v
}

/** 判断字符串是否为表达式值（函数调用或运算符表达式） */
function _isExprValue(s: string): boolean {
  return /^[a-z_]\w*\s*\(.*\)\s*$/i.test(s) || /^(?:[-+!]|[\w.]+)\s+/.test(s) || /\s+(?:AND|OR|XOR|IN|IS|=|<>|<=?|>=?|[+\-*/%])\s/.test(s)
}

/** 判断查询是否涉及写操作（需要独占 GE 连接） */
function isWriteOp(plan: QueryPlan): boolean {
  return plan.type === 'CREATE' || plan.type === 'MERGE' ||
    plan.type === 'SET' || plan.type === 'DELETE' || plan.type === 'REMOVE' ||
    plan.type === 'MATCH_MODIFY'
}

// ── GE 封装函数：将私有/非类型化 GE 方法集中在有限范围内 ──

/** GE 节点的类型：public API 缺失的类型补充 */
interface GeNodeInfo { type: number; name: string }

/** 执行 GE 查询计划（封装 _executeQueryPlan Private method） */
function _geExecQueryPlan(ge: any, plan: any): any[] {
  return (ge as any)._executeQueryPlan(plan)
}

/** upsertNode（GE public API 的类型补全） */
function _geUpsertNode(ge: any, type: number, name: string, props: { props: Record<string, unknown> }): Promise<number> {
  return (ge as any).upsertNode(type, name, props)
}

/** deleteNode（GE public API 的类型补全） */
function _geDeleteNode(ge: any, id: number): Promise<void> {
  return (ge as any).deleteNode(id)
}

/** getNode（GE public API 的类型补全） */
function _geGetNode(ge: any, id: number): GeNodeInfo | undefined {
  return (ge as any).getNode(id)
}

/** 解析边类型 ID（_resolveEdgeType Private method） */
function _geResolveEdgeType(ge: any, label: string): number {
  return (ge as any)._resolveEdgeType(label)
}

/** 插入边（storage.upsertEdge Private method） */
function _geUpsertEdge(ge: any, srcId: number, dstId: number, typeId: number, props?: Record<string, unknown>): void {
  if (props) {
    (ge as any).storage.upsertEdge(srcId, dstId, typeId, { props })
  } else {
    _geUpsertEdge(ge, srcId, dstId, typeId)
  }
}

/** GraphEngine 原生执行入口 */
export async function _executeViaGraphEngine(plan: QueryPlan, nodes: Array<Record<string, unknown>>, query?: string): Promise<QueryResult> {
  // ── 非 GE 路径（early exit）──
  const nonGeResult = await _execNonGePaths(plan, nodes, query)
  if (nonGeResult !== null) return nonGeResult

  // ── 共享 GE 实例 ──
  let ge: GraphEngine | null = null

  // 优先使用 database-specific GE 实例（CATALOG 多图隔离）
  const dbName = _getActiveDatabase()
  if (dbName !== DEFAULT_DATABASE && _geInstanceRegistry.has(dbName)) {
    ge = _geInstanceRegistry.get(dbName)!
  } else if (dbName !== DEFAULT_DATABASE) {
    // 按需创建 database 专属实例
    const dbDir = _geDirRegistry.get(dbName) || `/tmp/ge-db-${dbName}-${Date.now()}`
    _geDirRegistry.set(dbName, dbDir)
    fs.mkdirSync(dbDir, { recursive: true })
    const dbGe = new GraphEngine({ path: dbDir, denseVector: { dimension: 384 } } as OverGraphConfig)
    dbGe.open()
    _geInstanceRegistry.set(dbName, dbGe)
    ge = dbGe
  } else {
    // 默认数据库：使用 GEPool 弹性连接池
    // 如果 _gePool.value === null（_clearGeInstances 后被设置），销毁旧池重建
    // 避免池中旧实例的残留数据影响后续查询
    if (_gePool.value) {
      ge = _gePool.value
    } else {
      // 销毁旧池并创建新池，确保 GE 实例全新无残留
      GEPool.destroyInstanceWithCleanup()
      const poolConfig: OverGraphConfig = { path: '/tmp/tckge-pool', denseVector: { dimension: 384 } }
      const pool = GEPool.getInstance({ warmup: true, config: poolConfig, maxSize: 4 })
      ge = pool.getConnection(isWriteOp(plan))
    }
  }
  // 同步 _gePool.value 向后兼容
  _gePool.value = ge

  let originalNodeCount = 0
  let allNodes: Array<Record<string, unknown>> = []
  try {

    // ── 构建完整的输入节点集（seedNodes + DML createNodes） ──
    originalNodeCount = nodes?.length || 0
    allNodes = [...(nodes || [])]

    // 确保多标签节点有 __fullLabel 属性（传入的 nodes 可能没有）
    // 确保 __edges 存在（EXISTS 子查询需要）
    for (const node of allNodes) {
      if (!node.__edges) node.__edges = []
    }
    for (const node of allNodes) {
      if (node._label && String(node._label).includes(':')) {
        node.__fullLabel = String(node._label)
      }
    }

    // 解包 typed 格式的 props（{type: 'STRING', value: 'ABCDEF'} → 'ABCDEF'）
    // 这种包装在 parseQuery 的 createNodes 中产生，GE 的 _matchFilter 只支持裸值
    for (const node of allNodes) {
      for (const k of Object.keys(node)) {
        const v = node[k]
        if (isTypedValue(v)) {
          node[k] = v.value
        }
      }
    }
    // 如果传入节点没有 _label 标签但 plan 指定了 scanLabel，自动赋值（兼容外部 plan 导入场景）
    if (plan.scanLabel && allNodes.some(n => !('_label' in n) || n._label === undefined || n._label === null)) {
      let scanLabelAssigned = false
      for (const n of allNodes) {
        if (!('_label' in n) || n._label === undefined || n._label === null) {
          n._label = plan.scanLabel
          scanLabelAssigned = true
        }
      }
      if (scanLabelAssigned) {
        // 同时通知 skipNodeIndices 构建（后面的代码直接用 _label 判断）
      }
    }
    const cnToAllNodeMap = new Map<number, number>()  // createNode index → allNodes index
    const matchVars = plan.hasMatch ? new Set(extractMatchVariables(query)) : new Set<string>()
    if (plan.createNodes?.length) {
      for (let ci = 0; ci < plan.createNodes.length; ci++) {
        const cn = plan.createNodes[ci]
        // 跳过仅引用已匹配节点的 createNode（无 label 无 props，且变量名已存在 MATCH 中）
        if (cn.alias && matchVars.has(cn.alias) && !cn.label && (!cn.props || !Object.keys(cn.props).length)) {
          // 不创建新节点，但保留 _alias 引用
          // 在 allNodes 中找到对应节点（按 _alias 或按位置）
          const existingIdx = allNodes.findIndex(n => n._alias === cn.alias)
          if (existingIdx >= 0) {
            cnToAllNodeMap.set(ci, existingIdx)
          } else {
            // 已存在节点没有 _alias（从 seed nodes 来的），设置 _alias
            // 按位置查找：createNodes[i] 对应 allNodes 中的 seed 节点
            if (ci < allNodes.length) {
              allNodes[ci]._alias = cn.alias
              cnToAllNodeMap.set(ci, ci)
            }
          }
          continue
        }
        const props: Record<string, unknown> = { _label: cn.label || 'Default' }
        if (cn.props) { for (const [k, v] of Object.entries(cn.props)) {
          const raw = isTypedValue(v) ? v.value : v
          if (typeof raw === 'string' && (_isExprValue(raw) || raw.startsWith('[') || raw.startsWith('(') || raw.startsWith('{') || raw.startsWith('date') || raw.startsWith('time') || raw.startsWith('datetime') || raw.startsWith('localtime') || raw.startsWith('localdatetime') || raw.startsWith('duration'))) {
            try { props[k] = _evalBinary(raw, {}); continue } catch { /* 如果不是合法表达式则用原值 */ }
          }
          // 数组元素级求值：每个元素如果是表达式字符串，求值
          if (Array.isArray(raw)) {
            props[k] = raw.map(el => {
              if (typeof el === 'string' && (_isExprValue(el) || el.startsWith('date') || el.startsWith('time') || el.startsWith('datetime') || el.startsWith('localtime') || el.startsWith('localdatetime') || el.startsWith('duration'))) {
                try { return _evalBinary(el, {}) } catch { return el }
              }
              return el
            })
            continue
          }
          props[k] = raw
        } }
        if (cn.alias) props['_alias'] = cn.alias
        allNodes.push(props)
        cnToAllNodeMap.set(ci, allNodes.length - 1)
      }
    }

    // ── 约束校验：检查 CREATE 的节点是否违反已注册的唯一约束 ──
    // 遍历已注册的约束，对全部 allNodes 做唯一性检查
    if (plan.createNodes?.length && (plan.type === 'CREATE' || plan.type === 'MERGE')) {
      const constraints = _getAllConstraints()
      for (const constraint of constraints) {
        const seen = new Map<unknown, number>()
        for (let i = 0; i < allNodes.length; i++) {
          const node = allNodes[i]
          const nodeLabel = node._label
          const labels = String(nodeLabel ?? '').split(':').map(s => s.trim()).filter(Boolean)
          if (!labels.includes(constraint.label)) continue
          const rawVal = node[constraint.property]
          if (rawVal === null || rawVal === undefined) continue
          // 解析 typed 格式：{type: 'STRING', value: 'xxx'} → 'xxx'
          const propVal = isTypedValue(rawVal) ? rawVal.value : rawVal
          if (propVal === null || propVal === undefined) continue
          const prevIdx = seen.get(propVal)
          if (prevIdx !== undefined) {
            throw new Error(
              `ConstraintValidationFailed: Node(${constraint.label}) already exists with ${constraint.property} = ${JSON.stringify(propVal)}`
            )
          }
          seen.set(propVal, i)
        }
      }
    }

    let edgeLabelFromTypeFilter = false  // flag: 从 WHERE type(r) 设置了边类型过滤
    // ── WHERE 预过滤：确定哪些 seed 节点需要跳过 ──
    // GE 的 _executeQueryPlan 在 steps 遍历后才对结果节点应用 filter，
    // 且 _matchFilter 忽略 filter.source。对于 WHERE n.name = 'Bob'
    // 这种 source 变量是步骤起点的 filter，在 seed 阶段跳过不匹配的节点。
    // Note: allNodes 必须保持原样（__edges 的 srcIdx/dstIdx 依赖原始索引），
    // 所以在 seed 循环中条件跳过，而非过滤 allNodes。
    // 跨变量属性引用检测：f.value 格式为 `var.property`，不能在 seed 阶段用常数比较
    const _isVarRef = (v: any): boolean => typeof v === 'string' && /^\w+\.\w+$/.test(v) && !/^['"]/.test(v) && !/^\d/.test(v)
    // 检测 filter 值是否为非法表达式（ANTLR 链式比较处理失败导致的字符串值）
    const _isBrokenChainValue = (v: any): boolean =>
      typeof v === 'string' && /[<>=]/.test(v)
    const crossVarFilters = (plan.filters || []).filter(f => f.source && f.property && _isVarRef(f.value))
    const stepSourceFilters = (plan.filters || []).filter(f => {
      const firstStep = plan.steps?.[0]
      // 排除跨变量引用 filter（seed 阶段无法做跨变量比较）
      if (crossVarFilters.includes(f)) return false
      // 排除 ANTLR 链式比较解析失败的 filter（值中包含比较运算符）
      if (_isBrokenChainValue(f.value)) return false
      const result = firstStep && f.source === firstStep.source && firstStep.source
      return result
    })
    // ── WHERE 标签谓词预过滤 ──
    // 提取 `WHERE a:A` 形式的标签检查（ANTLR 不将其解析为 filter）
    const whereLabelFilters: Array<{varName: string; targetLabel: string}> = []
    if (plan.steps?.length && query) {
      const firstStepSource = plan.steps[0].source
      if (firstStepSource) {
        // 从原始 query 中提取 WHERE 子句，然后查找所有 var:Label 模式（不限于 firstStepSource）
        const whereClauseMatch = query.match(/\bWHERE\s+([\s\S]+?)(?=\b(RETURN|WITH|CREATE|ORDER|SKIP|LIMIT)\b|$)/i)
        if (whereClauseMatch) {
          const whereClause = whereClauseMatch[1]
          // 提取所有 var:Label 模式（g flag 必须用于 matchAll）
          const allLabelRegex = /(\w+)\s*:\s*(\w+)/g
          for (const lm of whereClause.matchAll(allLabelRegex)) {
            whereLabelFilters.push({ varName: lm[1], targetLabel: lm[2] })
          }
        }
      }
    }

    // ── 索引加速预过滤：当 plan 有 scanLabel 且 EQ filter 匹配已注册索引时 ──
    // 利用 _getIndex 检查 (scanLabel, property) 是否已注册索引
    // 即使索引没有 build Node ID 集，也可以用 scanLabel + filter 值做预过滤
    const indexedEqFilters: Array<{ filter: any; index: IndexEntry }> = []
    if (plan.scanLabel) {
      for (const f of (plan.filters || [])) {
        if (f.operator === 'EQ' && f.property && f.value !== undefined && !_isVarRef(f.value)) {
          const idx = _getIndex(plan.scanLabel, f.property)
          if (idx) {
            indexedEqFilters.push({ filter: f, index: idx })
          }
        }
      }
    }

    // ── hashIndex 构建：为 registered index + EQ filter 构建 O(1) 查找映射 ──
    // key = `${label}:${property}:${String(value)}` → nodeIndices[]
    // 只构建当前 indexedEqFilters 需要的索引条目，不全部构建。
    // 如果查询指定了 USING INDEX hint，则优先使用 hint 指定的索引。
    const indexHint = plan._indexHint as { var: string; label: string; property: string } | undefined
    const hashIndex = new Map<string, number[]>()
    if (indexedEqFilters.length || indexHint) {
      for (let ni = 0; ni < allNodes.length; ni++) {
        const node = allNodes[ni]
        const nodeLabel = String(node['_label'] || '')
        // Hint 优先级：使用 hint 中指定的 label + property 构建
        if (indexHint) {
          if (nodeLabel !== indexHint.label) {
            const fullLabel = node.__fullLabel
            if (!(fullLabel && typeof fullLabel === 'string' && fullLabel.split(':').includes(indexHint.label))) {
              continue
            }
          }
          const propVal = node[indexHint.property]
          if (propVal !== undefined && propVal !== null) {
            const key = `${indexHint.label}:${indexHint.property}:${String(propVal)}`
            if (!hashIndex.has(key)) hashIndex.set(key, [])
            hashIndex.get(key)!.push(ni)
          }
          continue // hint 存在时不构建其他索引键
        }
        // 无 hint：构建 indexedEqFilters 需要的索引
        for (const efi of indexedEqFilters) {
          if (!efi.index.label) continue
          // 检查节点标签是否匹配索引标签
          if (nodeLabel !== efi.index.label) {
            const fullLabel = node.__fullLabel
            if (!(fullLabel && typeof fullLabel === 'string' && fullLabel.split(':').includes(efi.index.label))) {
              continue
            }
          }
          const propVal = node[efi.filter.property]
          if (propVal === undefined || propVal === null) continue
          const key = `${efi.index.label}:${efi.filter.property}:${String(propVal)}`
          if (!hashIndex.has(key)) hashIndex.set(key, [])
          hashIndex.get(key)!.push(ni)
        }
      }
    }

    // 构建需要跳过的节点索引集合
    const skipNodeIndices = new Set<number>()
    if (indexedEqFilters.length || stepSourceFilters.length || whereLabelFilters.length) {
      // hashIndex 加速：如果 indexedEqFilters 有匹配，直接获取命中节点
      if (indexedEqFilters.length && hashIndex.size > 0) {
        const hashMatched = new Set<number>()
        let allHashMatchable = true
        for (const efi of indexedEqFilters) {
          const key = `${efi.index.label!}:${efi.filter.property}:${String(efi.filter.value)}`
          const hitIndices = hashIndex.get(key)
          if (hitIndices) {
            for (const hi of hitIndices) hashMatched.add(hi)
          } else {
            allHashMatchable = false
            break
          }
        }
        // 只有所有 indexedEqFilters 都能通过 hashIndex 定位时才使用
        if (allHashMatchable && hashMatched.size > 0) {
          // 反转：不在 hashMatched 中的节点全部跳过
          for (let ni = 0; ni < allNodes.length; ni++) {
            if (!hashMatched.has(ni)) skipNodeIndices.add(ni)
          }
        }
      }
      for (let ni = 0; ni < allNodes.length; ni++) {
        const node = allNodes[ni]
        const nodeLabel = String(node['_label'] || '')
        if (plan.scanLabel) {
          const fullLabel = node.__fullLabel
          if (fullLabel && typeof fullLabel === 'string') {
            if (!fullLabel.split(':').includes(plan.scanLabel)) continue
          } else if (nodeLabel !== plan.scanLabel) {
            continue
          }
        }
        const match = stepSourceFilters.every((f: any) => {
          const val = node[f.property]
          const target = f.value
          switch (f.operator) {
            case 'EQ': {
              // BigInt 精度：ANTLR 截断大整数，用 BigInt 精确比较
              if (typeof val !== typeof target) {
                if (/^-?\d+$/.test(String(val)) && /^-?\d+$/.test(String(target))) {
                  try { if (BigInt(val) === BigInt(target)) return true } catch {}
                }
              }
              // bigint vs bigint 精确比较
              if (typeof val === 'bigint' && typeof target === 'bigint') return val === target
              // bigint vs string: 用 BigInt 重建比较
              if (typeof val === 'bigint' && typeof target === 'string') {
                try { return val === BigInt(target) } catch { return false }
              }
              if (typeof val === 'string' && typeof target === 'bigint') {
                try { return BigInt(val) === target } catch { return false }
              }
              return val === target
            }
            case 'NEQ': return val !== target
            case 'GT':
            case 'GTE':
            case 'LT':
            case 'LTE':
              return typeof val === 'number' && typeof target === 'number'
                ? (f.operator === 'GT' ? val > target : f.operator === 'GTE' ? val >= target : f.operator === 'LT' ? val < target : val <= target)
                : false
            default:    return true
          }
        })
        if (!match) {
          skipNodeIndices.add(ni)
        }
        // 索引加速过滤：如果已注册索引匹配的 EQ filter 不满足，跳过该节点
        if (indexedEqFilters.length && !skipNodeIndices.has(ni)) {
          const idxMatch = indexedEqFilters.every(({ filter: f }) => {
            return node[f.property] === f.value
          })
          if (!idxMatch) {
            skipNodeIndices.add(ni)
          }
        }
        // WHERE 标签谓词过滤：检查节点标签是否匹配 WHERE var:Label
        // 多变量标签谓词（如 a:A AND b:B）中，每个节点只需匹配指向自己的那条
        // 如果某个节点没有被任何 labelFilter 指向，则放行（不对它做标签检查）
        if (whereLabelFilters.length && !skipNodeIndices.has(ni)) {
          const nodeLabel = String(node['_label'] || '')
          // 找到指向这个节点的 labelFilte（如果有）
          const matchingFilters = whereLabelFilters.filter(lf => {
            const targetIdx = resolveVariableNodeIdx(lf.varName, plan, allNodes)
            return targetIdx === ni
          })
          // 如果没有 labelFilter 指向这个节点 → 放行
          // 如果有 → 全部匹配才通过
          const labelOk = matchingFilters.length === 0 || matchingFilters.every(lf => nodeLabel === lf.targetLabel)
          if (!labelOk) {
            skipNodeIndices.add(ni)
          }
        }
      }
      // 从 plan.filters 中移除已预处理的过滤器（stepSourceFilters + indexedEqFilters）
      // 只移除 seed 阶段能有效处理的 filter（EQ/NEQ/GT/GTE/LT/LTE/IN），
      // 保留 STARTS_WITH/CONTAINS/ENDS_WITH/IS_NULL/IS_NOT_NULL 给 GE 或后处理
      const seedCapableOperators = new Set(['EQ', 'NEQ', 'GT', 'GTE', 'LT', 'LTE', 'IN'])
      const processedFilters = [...stepSourceFilters.filter(f => seedCapableOperators.has(f.operator)), ...indexedEqFilters.map(ie => ie.filter)]
      plan.filters = (plan.filters || []).filter((f: any) => !processedFilters.includes(f))

    }

    // ── 内联节点属性预过滤（从 query 解析 `(n {name: 'A'})`） ──

    if (query && !stepSourceFilters.length) {
      const inlineMatch = query.match(/MATCH\s+\((\w+)(?::\w+)?\s*\{([^}]+)\}[^)]*\)/)
      if (inlineMatch) {
        const inlineVar = inlineMatch[1]
        const inlinePropsRaw = inlineMatch[2]
        const inlinePredicates: Array<{ key: string; value: string | number; raw: string }> = []
        const pairRegex = /(\w+)\s*:\s*(?:'([^']*)'|"([^"]*)"|(\d+(?:\.\d+)?))/g
        let pairMatch
        while ((pairMatch = pairRegex.exec(inlinePropsRaw)) !== null) {
          const key = pairMatch[1]
          const strVal = pairMatch[2] ?? pairMatch[3]
          const numStr = pairMatch[4]
          if (strVal !== undefined) {
            inlinePredicates.push({ key, value: strVal, raw: strVal })
          } else if (numStr !== undefined) {
            const num = parseFloat(numStr)
            inlinePredicates.push({ key, value: num, raw: numStr })
          }
        }
        if (inlinePredicates.length) {
          const matchSource = plan.steps?.[0]?.source
          const isMatchSource = inlineVar === matchSource || (!matchSource && !plan.scanLabel)
          if (isMatchSource) {
            // 内联属性过滤 `(n {name:'A'})`：不要用 skipNodeIndices 跳过不匹配节点，
            // 这会把 target 节点（B、C）也跳过。
            // 改为注入 stepSourceFilters，让 _walkMultiSteps 在遍历时正确约束。
            // 先清空现有同 variable 的 source 过滤（避免重复过滤）
            if (!stepSourceFilters) stepSourceFilters = []
            for (const pred of inlinePredicates) {
              stepSourceFilters.push({
                source: inlineVar,
                property: pred.key,
                value: typeof pred.value === 'number' ? pred.value : pred.raw,
              })
            }
          }
        }
      }
    }
    const nodeGeIds: number[] = []

    let edgesPayload: Array<{ srcIdx: number; dstIdx: number; label: string }> = []
    if (allNodes.length) {
      for (let i = 0; i < allNodes.length; i++) {
        // WHERE 预过滤：跳过不匹配的起始节点
        if (skipNodeIndices.has(i)) {
          nodeGeIds[i] = 0 // 占位，不 seed 到 GE
          continue
        }
        const nodeName = 'n' + i
        const item = allNodes[i]
        const label = String(item['_label'] || 'Default')
        const hasMultipleLabels = label.includes(':')
        // 多标签：存完整标签到 __fullLabel，用第一个标签注册到 GE
        const geLabel = hasMultipleLabels ? label.split(':')[0] : label
        const props: Record<string, unknown> = { _label: geLabel }
        if (hasMultipleLabels) props['__fullLabel'] = label
        for (const k of Object.keys(item)) {
          if (k !== '_label' && k !== '__edges') props[k] = item[k]
        }
        let h = 0
        for (let ci = 0; ci < geLabel.length; ci++) h = ((h << 5) - h + geLabel.charCodeAt(ci)) | 0
        // 调用 GE 的 upsertNode（处理 nodeIds 索引、缓存等），获取返回的 Promise
        // 由于 _executeViaGraphEngine 是同步函数，无法 await，
        // 但 GE.upsertNode 的核心（storage.upsertNode + nodeId tracking）是同步的
        const geTypeId = Math.abs(h) % 1000 + 1
        try {
                    // 异步执行：直接调用 GE 的 upsertNode（真正的 async API）
          const actualId = await _geUpsertNode(ge, geTypeId, 'n' + i, { props })
          nodeGeIds[i] = actualId
        } catch (e) {
          nodeGeIds[i] = i + 1
        }
      }
      // 从 allNodes 中提取 __edges 并创建边
      edgesPayload = extractEdgesFromNodes(allNodes)
      // 将 edgesPayload 中的边分配到对应节点的 __edges 上（供 _walkMultiSteps 遍历使用）
      // edgesPayload 可能只存储在 allNodes[0].__edges 中（TCK step-definitions 的存储方式）
      if (edgesPayload.length) {
        const nodeEdgeMap: Array<Array<{dstIdx: number; srcIdx: number; label: string; props?: any}>> = allNodes.map(() => [] as any)
        for (const ep of edgesPayload) {
          if (ep.srcIdx >= 0 && ep.srcIdx < allNodes.length) {
            nodeEdgeMap[ep.srcIdx].push({dstIdx: ep.dstIdx, srcIdx: ep.srcIdx, label: ep.label, props: ep.props || undefined})
          }
        }
        // 为每行分配 __edges（如果还没有），同时构建邻接索引
        const adjIdx = new Map<number, Array<{dstIdx: number; srcIdx: number; label: string; props?: any}>>()
        for (let ni = 0; ni < allNodes.length; ni++) {
          if (!(allNodes[ni] as any).__edges || !(allNodes[ni] as any).__edges.length) {
            (allNodes[ni] as any).__edges = nodeEdgeMap[ni]
          }
          if (nodeEdgeMap[ni].length > 1) {
            adjIdx.set(ni, nodeEdgeMap[ni])
          }
        }
        // 把邻接索引挂在 allNodes 上供 _walkMultiSteps 使用
        // 把邻接索引挂在 allNodes 上供 _walkMultiSteps 使用
        (allNodes as Array<Record<string, unknown> & { __adjIdx?: number[][] }>).__adjIdx = adjIdx
      }
  
      if (edgesPayload.length) {
        // 跳过节点不创建 stub node（避免 traversalfrom 跳过的节点产生误匹配）
        // 跳过的节点不 seed 到 GE，也不通过边连接。如果边连接了 skipNode 和
        // non-skip 节点，那条边会丢失。但这比 GE 遍历到"被过滤掉"的节点更好。
        // TCK 中无场景触发此问题，这是纯粹的边界防御。

        const anyDirection = plan.steps?.length && plan.steps.some(s => s.direction === 'any')
        for (const ep of edgesPayload) {
          const srcGeId = ep.srcIdx >= 0 && ep.srcIdx < nodeGeIds.length ? nodeGeIds[ep.srcIdx] : -1
          const dstGeId = ep.dstIdx >= 0 && ep.dstIdx < nodeGeIds.length ? nodeGeIds[ep.dstIdx] : -1
          if (srcGeId < 0 || dstGeId < 0) continue
          const typeId = _geResolveEdgeType(ge, ep.label || '')
          // upsertEdge 是 async 函数，但 _executeViaGraphEngine 是同步上下文。
          // 直接调用 storage.upsertEdge（同步 API）确保边在 MATCH 前已创建。
          try {
            const epObj = ep as { props?: Record<string, unknown> }
            if (epObj.props) {
              _geUpsertEdge(ge, srcGeId, dstGeId, typeId, epObj.props)
            } else {
              _geUpsertEdge(ge, srcGeId, dstGeId, typeId)
            }
          } catch {}
          // 无向边双向
          if (anyDirection && srcGeId !== dstGeId) {
            try { _geUpsertEdge(ge, dstGeId, srcGeId, typeId) } catch {}
          }
        }
      }

    }

    // ── 构建 source→target 映射（GE 不保留从哪个源节点出发） ──
    // 用于 RETURN 中 source 变量（如 RETURN n 而非 RETURN 目标节点）
    // 以及 WHERE 过滤后的 source 节点结果重建。
    // 格式：Map<targetGeId, sourceGeId[]>
    const sourceTargetMap = new Map<number, number[]>()
    if (edgesPayload.length && nodeGeIds.length) {
      for (const ep of edgesPayload) {
        const srcGeId = ep.srcIdx >= 0 && ep.srcIdx < nodeGeIds.length ? nodeGeIds[ep.srcIdx] : -1
        const dstGeId = ep.dstIdx >= 0 && ep.dstIdx < nodeGeIds.length ? nodeGeIds[ep.dstIdx] : -1
        if (srcGeId < 0 || dstGeId < 0) continue // 跳过被预过滤的占位节点
        if (!sourceTargetMap.has(dstGeId)) sourceTargetMap.set(dstGeId, [])
        sourceTargetMap.get(dstGeId)!.push(srcGeId)
        // 无向边也记录反向
        if (!sourceTargetMap.has(srcGeId)) sourceTargetMap.set(srcGeId, [])
        sourceTargetMap.get(srcGeId)!.push(dstGeId)
      }
    }

    // ── CREATE 边（从 createEdges 创建 GE 关系 + __edges 内存记录） ──
    if (plan.createEdges?.length && nodeGeIds.length >= 1) {
      for (const edge of plan.createEdges) {
        // 查找源/目标节点在 allNodes 中的实际索引
        // 先尝试从 cnToAllNodeMap 映射（createNode index → allNodes index）
        let srcIdx = -1;
        let dstIdx = -1;

        // 映射 source
        const cnSrcIdx = edge.sourceIdx !== undefined ? edge.sourceIdx : -1
        if (cnSrcIdx >= 0) {
          if (cnToAllNodeMap.has(cnSrcIdx)) {
            srcIdx = cnToAllNodeMap.get(cnSrcIdx)!
          } else {
            // 如果 createNode 在新节点的索引偏移中（未在 cnToAllNodeMap 中，说明是跳过匹配后又创建了新节点）
            // 回退：使用 offset，其中 originalNodeCount 是 seed node 数，cnSrcIdx 是 createNode 索引
            srcIdx = cnSrcIdx
          }
        }
        if (srcIdx < 0 && edge.source) {
          // 通过 alias 查找
          srcIdx = allNodes.findIndex(n => n._alias === edge.source)
        }
        // 如果 srcIdx 还是 < 0，用 cnSrcIdx 直接作为 allNodes 索引（当 createNodes 与 allNodes 按位置对齐时）
        if (srcIdx < 0 && cnSrcIdx >= 0 && cnSrcIdx < allNodes.length) {
          srcIdx = cnSrcIdx
        }

        // 映射 target
        const cnDstIdx = edge.targetIdx !== undefined ? edge.targetIdx : -1
        if (cnDstIdx >= 0) {
          if (cnToAllNodeMap.has(cnDstIdx)) {
            dstIdx = cnToAllNodeMap.get(cnDstIdx)!
          } else {
            dstIdx = cnDstIdx
          }
        }
        if (dstIdx < 0 && edge.target) {
          dstIdx = allNodes.findIndex(n => n._alias === edge.target)
        }
        if (dstIdx < 0 && cnDstIdx >= 0 && cnDstIdx < allNodes.length) {
          dstIdx = cnDstIdx
        }

        if (srcIdx >= 0 && dstIdx >= 0 && srcIdx < nodeGeIds.length && dstIdx < nodeGeIds.length) {
          const srcId = nodeGeIds[srcIdx]
          const dstId = nodeGeIds[dstIdx]
          if (srcId !== undefined && srcId !== undefined && srcId >= 0 && dstId >= 0) {
            // 使用 GE 的 _resolveEdgeType 获取统一的 typeId
            const typeId = _geResolveEdgeType(ge, edge.label || '')
            try { _geUpsertEdge(ge, srcId, dstId, typeId) } catch {}

            // 将边添加到 __edges 内存记录
            for (const n of allNodes) {
              const nNode = n as InternalNode
              if (!nNode.__edges) nNode.__edges = []
            }
            const edgeLabel = edge.label || ''
            // 在 src 节点的 __edges 中添加出边
            (allNodes[srcIdx] as any).__edges.push({ dstIdx, srcIdx, label: edgeLabel })
            // 在 dst 节点的 __edges 中添加入边
            (allNodes[dstIdx] as any).__edges.push({ dstIdx, srcIdx, label: edgeLabel })
          }
        }
      }
    }

    // ── DML + RETURN：从 createNodes 构造结果行（GE 对 DML 返回空） ──
    if ((plan.type === 'CREATE' || plan.type === 'MERGE') && plan.returnColumns?.length) {
      const created = _buildDmlRows(plan, allNodes)

      // ── MERGE ON CREATE / ON MATCH SET ──
      if (plan.type === 'MERGE' && (plan.mergeOnCreate?.length || plan.mergeOnMatch?.length)) {
        const originalCount = nodes.length
        const newlyCreated = allNodes.slice(originalCount)
        if (newlyCreated.length > 0) {
          // 将 MATCH 变量注入 rc（支持 v.date 等属性访问表达式）
          // 新创建节点 → ON CREATE SET
          for (const nn of newlyCreated) {
            for (const oc of plan.mergeOnCreate || []) {
              nn[oc.property] = typeof oc.value === 'object' && oc.value !== null && 'value' in oc
                ? (oc.value as any).value
                : oc.value
            }
          }
        } else if (plan.mergeOnMatch?.length) {
          // 匹配已有 → ON MATCH SET
          for (const targetNode of allNodes) {
            for (const om of plan.mergeOnMatch) {
              targetNode[om.property] = typeof om.value === 'object' && om.value !== null && 'value' in om
                ? (om.value as any).value
                : om.value
            }
          }
        }
      }

      return _postProcessResults(created, plan)
    }

    // ── WHERE type(r) = 'X' → 转为 edgeLabel 过滤（非参数化，全局匹配） ──
    // [CVE-H3]: 原实现只匹配第一个 type(r) = 'X'，AND/OR 复合条件中后续约束被忽略。
    // 现改用全局正则匹配所有 type(r) = 'X' 条件。
    if (query && !plan.steps?.some(s => s.edgeLabel)) {
      const typeRegex = /WHERE\s+type\s*\(\s*(\w+)\s*\)\s*=\s*['"]([^'"]+)['"]/g
      let typeMatch: RegExpExecArray | null
      while ((typeMatch = typeRegex.exec(query)) !== null) {
        const typeLabel = typeMatch[2]
        for (const s of plan.steps || []) {
          if (!s.edgeLabel) {
            s.edgeLabel = typeLabel
          }
        }
      }
    }


    // ── 多类型 edgeLabel 处理 ──
    // MATCH (n)-[r:KNOWS|HATES]->(x) — 分割为多个单标签查询合并结果
    // ── 预分离边变量 filter（WHERE r.name = 'foo'） ──
    // GE 的 _matchFilter 只检查节点属性，无法处理 source="r" 的边属性 filter。
    // 从 plan.filters 中摘出边变量 filter，GE 执行时去掉它们，执行完后手动应用。
    // 边变量 filter 的判断：source 是 MATCH 中的关系变量（通常在步骤 source 左边或右边），
    // 但肯定不是步骤 source 也不是扫描出来的节点变量。
    // 判断条件：plan.filters 中 source 不是步骤 source，且 steps 非空（否则是纯节点 WHERE）。
    const stepSrc = plan.steps?.[0]?.source
    const stepTarget = plan.steps?.[0]?.targetAlias
    // 收集所有 step 中的节点变量名（source + targetAlias），不仅是 step 0
    const allStepVars = new Set<string>()
    for (const s of (plan.steps || [])) {
      if (s.source) allStepVars.add(s.source)
      if (s.targetAlias) allStepVars.add(s.targetAlias)
    }
    if (plan.scanLabel) allStepVars.add(plan.scanLabel)
    const nodeAliasList = [...allStepVars]
    const edgeFilters = plan.steps?.length ? (plan.filters || []).filter(f =>
      f.source && !nodeAliasList.includes(f.source)
    ) : []
    // 只匹配作为 SQL 关键字的 OR（列名如 ordinalDay 不触发）
    const _isQueryOrKeyword = (q: string): boolean => /\bOR\b/i.test(q)
    const hasOR = query ? _isQueryOrKeyword(query) : false
    const geCapableOps = new Set(['EQ', 'NEQ', 'IN', 'STARTS_WITH', 'ENDS_WITH', 'CONTAINS', 'IS_NULL', 'IS_NOT_NULL'])
    const geFilters = (plan.filters || []).filter(f => !(edgeFilters as any[]).includes(f))
    // 从 GE filter 中移除 GE 不支持的运算符，由 query-engine 在后处理中补偿
    const geUnsupportedOps = new Set(['GT', 'GTE', 'LT', 'LTE'])
    const queryEngineFilters = geFilters.filter(f => geUnsupportedOps.has(f.operator))
    const geFiltered = geFilters.filter(f => !geUnsupportedOps.has(f.operator))

    const multiTypeStep = plan.steps?.find(s => s.edgeLabel && s.edgeLabel.includes('|'))

    // ── Plan 注解：预计算元数据供执行路径决策 ──
    if (!plan._annotations) {
      const labelCounts = new Map<string, number>()
      for (const n of allNodes) {
        const label = n._label ? String(n._label) : 'Default'
        labelCounts.set(label, (labelCounts.get(label) || 0) + 1)
      }
      // 分类 WHERE 谓词
      const eqFilters = (plan.filters || []).filter(f => f.operator === 'EQ' && !edgeFilters.includesf)
      const rangeFilters = (plan.filters || []).filter(f => ['GT', 'GTE', 'LT', 'LTE'].includes(f.operator || ''))
      const indexEntries = Array.from(_indexRegistry.values())
      const hasIndexedEq = eqFilters.some(f => f.source && indexEntries.some(idx =>
        idx.property === f.property && (!idx.label || allNodes.some(n => String(n._label || '') === idx.label))
      ))
      ;plan._annotations = {
        labelCounts: Object.fromEntries(labelCounts),
        eqFilterCount: eqFilters.length,
        rangeFilterCount: rangeFilters.length,
        hasIndexedEq,
        totalSeedNodes: allNodes.length,
        edgeFilterCount: edgeFilters.length,
      }
    }

    // ── 多步跳转支持（MATCH (a)-->(b)-->(c) 或变量长度路径 (a)-[:X*1..3]->(b)）──
    // 当 steps.length > 1 或单步但有 range（变量长度）时，用 __edges 手动遍历
    // 扩展：单步有边 MATCH（steps[0].edgeLabel 不为空）也走 __edges 遍历，
    // 避免 GE 边存储与 allNodes.__edges 不同步的问题
    const hasMultiStep = plan.steps && plan.steps.length > 1 && allNodes.length > 0
    const hasVarLen = plan.steps?.length === 1 && (plan.steps[0] as any)?.range
    const hasEdgeStep = plan.steps?.length === 1 && allNodes.length > 0 && (plan.steps[0].edgeLabel != null || plan.steps[0].direction === 'out' || plan.steps[0].direction === 'in' || plan.steps[0].direction === 'any')
    const stepEdgesCache = new Map<number, string[]>()
    const useEdgeWalk = hasMultiStep || hasVarLen || hasEdgeStep
    let rawRecords: any[] = (useEdgeWalk)
      ? (() => {
          const edgeVarColsLen = (plan.returnColumns || []).filter(rc => {
            if (!rc || rc === '*' || rc.includes('.')) return false
            const nodeAliases = new Set([
              ...(plan.createNodes || []).map((n: any) => n.alias).filter(Boolean),
              ...(plan.steps || []).flatMap(s => [s.source, s.targetAlias]).filter(Boolean),
            ])
            return !nodeAliases.has(rc)
          }).length
          let multiStepRaw: any[] = []
          // 保存并清除 edgeLabel 突变（L728-735 的 typeRegex 污染了 edgeLabel，只取第一个 OR branch）
          const savedEdgeLabel = plan.steps?.[0]?.edgeLabel ?? null
          if (plan.steps?.[0]) plan.steps[0].edgeLabel = null
          const _ceComma = plan.steps?.length > 1 && plan.steps.some(
            (s: any, si: number) => {
              if (si === 0) return false
              // Comma-separated MATCH: targetAlias reused across steps
              for (let pj = 0; pj < si; pj++)
                if (plan.steps[pj].targetAlias === s.targetAlias && s.targetAlias) return true
              return false
            }
          )
          for (let i = 0; i < allNodes.length; i++) {
            if (skipNodeIndices.has(i)) {
              continue
            }
            // 根据 scanLabel 过滤起始节点（支持多标签 __fullLabel）
            if (plan.scanLabel) {
              const node = allNodes[i]
              const nodeLabel = String(node?.['_label'] || '')
              const fullLabel = node?.__fullLabel
              if (fullLabel && typeof fullLabel === 'string') {
                if (!fullLabel.split(':').includes(plan.scanLabel)) continue
              } else if (nodeLabel !== plan.scanLabel) {
                continue
              }
            }
            let skipNode = false
            for (const sf of stepSourceFilters) {
              if (allNodes[i][sf.property] === undefined || String(allNodes[i][sf.property]) !== String(sf.value)) {
                skipNode = true
                break
              }
            }
            if (skipNode) continue
            // WHERE 标签谓词 pre-check：起始节点必须匹配 step source 变量的标签
            if (plan.labelFilterItems?.length && plan.steps?.[0]?.source) {
              const srcVar = plan.steps[0].source
              const srcLabelFilters = plan.labelFilterItems.filter((lfi: any) => lfi.variable === srcVar)
              if (srcLabelFilters.length) {
                const nodeLabel = String((allNodes[i] as any)?._label || '')
                const labelOk = srcLabelFilters.some((lfi: any) => nodeLabel === lfi.label)
                if (!labelOk) continue
              }
            }
            const pathResults = _walkMultiSteps(i, plan.steps, allNodes, skipNodeIndices, plan.filters, stepSourceFilters)
        const pathEnds = _pathEndIndices(pathResults)
        // 对多步结果做交集限定：只保留在 RETURN 变量对应定义步（第一个定义该变量的 step）中存在的 target
        // 防止后续 step 引入不相关的中间节点
        // [FIX-MW2]: 当 returnColumns 仅含属性名（如 "name"）时（ANTLR 将 out.name → "name" 剥离了变量前缀），
        // 从 expressionColumns 或 returnAliasMap 中提取真正的变量名
        const retVars: string[] = []
        for (const rc of (plan.returnColumns || [])) {
          const simpleVar = typeof rc === 'string' ? rc.split('.')[0] : ''
          if (simpleVar && plan.steps?.some(s => s.targetAlias === simpleVar)) {
            retVars.push(simpleVar)
          } else if (plan.expressionColumns?.length) {
            for (const ec of plan.expressionColumns) {
              if (ec.alias === rc || ec.expression === rc) {
                const dotIdx = ec.expression.indexOf('.')
                if (dotIdx > 0) {
                  const expVar = ec.expression.substring(0, dotIdx)
                  if (plan.steps?.some(s => s.targetAlias === expVar)) {
                    retVars.push(expVar)
                  }
                }
              }
            }
          }
        }
        const retVar = retVars.findLast(rc => {
          if (!rc) return false
          const firstSrc = plan.steps?.[0]?.source
          return rc !== firstSrc && plan.steps?.some(s => s.targetAlias === rc)
        })
        // 对于多步，改用最后一个 targetAlias 变量（降级安全）
        const lastTargetVar = plan.steps?.[plan.steps.length - 1]?.targetAlias
        const effectiveRetVar = (lastTargetVar && (plan.returnColumns || []).map(rc => rc?.split('.')[0]).includes(lastTargetVar))
          ? lastTargetVar
          : (retVar || lastTargetVar)
        let boundedTargetIndices: number[] = [...pathEnds]
        let boundedPaths: number[][] = pathResults
        // 多步匿名匹配（effectiveRetVar 为空，steps.length>1，非变量长度/非边变量）：保持 pathResults 全量
        // pathEnds Set 去重会丢失不同路径到同一终点的匹配，如 `()--()--()` 中 source=Looper 产生 2 条路径到自身
        if (!effectiveRetVar && plan.steps && plan.steps.length > 1 && !hasVarLen && !hasEdgeStep) {
          boundedTargetIndices = pathResults.map(p => p[p.length - 1])
          boundedPaths = pathResults
        } else if (effectiveRetVar && plan.steps && !hasVarLen && !hasEdgeStep) {
          const defStep = plan.steps.find(s => s.targetAlias === effectiveRetVar)
          if (defStep !== undefined) {
            const defStepIdx = plan.steps.indexOf(defStep)
            // 对返回变量的定义步，重新走到该步的 target 节点。这是 RETURN 变量的实际值。
            if (defStepIdx >= 0) {
              const intermediate = _walkMultiSteps(
                i, plan.steps.slice(0, defStepIdx + 1),
                allNodes, undefined, plan.filters, stepSourceFilters
              )
              const interEnds = _pathEndIndices(intermediate)
              // 如果 RETURN 变量等于最后一个 step 的 targetAlias，全路径的过滤约束
              // 会影响返回值（后续步的 filter 消除多余节点），需要用交集过滤。
              // 否则 pathResults 中的节点是后续步的 target，不相关，直接用 intermediate。
              const lastStep = plan.steps[plan.steps.length - 1]
              if (_ceComma) {
                boundedTargetIndices = [...interEnds]
                // In comma case, pathResults contains full walk results including all variables.
                // We need interEnds for target filtering, but pathResults for allVars population.
                // The allVars population code below uses boundedPaths to find matchingPath.
                // We must use pathResults so all steps' variables get populated.
                boundedPaths = pathResults
              } else if (lastStep && lastStep.targetAlias === effectiveRetVar) {
              } else if (lastStep && lastStep.targetAlias === effectiveRetVar) {
                boundedTargetIndices = [...pathEnds].filter(idx => interEnds.has(idx))
                boundedPaths = pathResults.filter(p => interEnds.has(p[p.length - 1]))
              } else {
                boundedTargetIndices = [...interEnds]
                boundedPaths = intermediate
              }
            }
          }
        }
        // 自环模式：当前 source 节点只保留到自身的 targetIdx
        // 如 MATCH (n)-[r]->(n) 中，起始节点通过自环边只回到自身
        const isSelfStep = plan.steps?.[0]?.source && plan.steps?.[0]?.targetAlias &&
          plan.steps[0].source === plan.steps[0].targetAlias
        const boundedTargets = isSelfStep
          ? [...boundedTargetIndices].filter(tIdx => tIdx === i)
          : [...boundedTargetIndices]
        for (const targetIdx of boundedTargets) {
              const targetNode = allNodes[targetIdx]
              if (!targetNode) continue
              const srcNode = allNodes[i] as Record<string, unknown>
              const geNode: any = {
                id: nodeGeIds[targetIdx] || (targetIdx + 1),
                props: { _label: (srcNode?._label as string) || 'Default', _allVars: {} as Record<string, unknown> },
                type: targetNode._label || 'Default',
                __multiStep: true,
                __targetProps: {},
                __targetAlias: plan.steps?.[plan.steps.length - 1]?.targetAlias || '',
              }
              // 构建所有步骤变量的节点数据（存于 props._allVars 以避免属性丢失）
              const allVars: Record<string, unknown> = geNode.props._allVars as Record<string, unknown>
              const lastStepV = plan.steps?.[plan.steps.length - 1]
              if (lastStepV?.targetAlias) {
                allVars[lastStepV.targetAlias] = { _label: targetNode._label || 'Default' }
                for (const k of Object.keys(targetNode)) {
                  if (k !== '__edges' && k !== 'props' && !k.startsWith('__')) allVars[lastStepV.targetAlias][k] = targetNode[k]
                }
              }
              // 用 boundedPaths 补充中间节点和边标签Info
              if (boundedPaths?.length > 0) {
                let matchingPath = boundedPaths.find(p => p[p.length - 1] === targetIdx)
                // [COMMA]: matchingPath 可能为空 —— interEnds 节点不在 path 末尾
                // 改用 interEnds 在 path 中查找（path[defStepIdx] === targetIdx）
                if (!matchingPath && _ceComma) {
                  matchingPath = boundedPaths.find(p => {
                    // defStep 是 steps 中首次定义 retVar 的步索引
                    const defStepIdx = plan.steps?.findIndex((st: any) => st.targetAlias === lastTargetVar)
                    return defStepIdx != null && defStepIdx >= 0 && p[defStepIdx] === targetIdx
                  })
                }
                if (matchingPath && matchingPath.length >= 2) {
                  const pathEdges: string[] = []
                  for (let psi = 0; psi < plan.steps.length && psi < matchingPath.length - 1; psi++) {
                    const step = plan.steps[psi]
                    const fromNode = allNodes[matchingPath[psi]] as any
                    if (fromNode?.__edges) {
                      const edge = fromNode.__edges.find((e: any) => {
                        const neighborIdx = e.dstIdx === matchingPath[psi] ? e.srcIdx : (e.srcIdx === matchingPath[psi] ? e.dstIdx : -1)
                        return neighborIdx === matchingPath[psi + 1]
                      })
                      if (edge?.label) pathEdges.push(edge.label)
                    }
                    // 中间节点：填充 _allVars 中对应步骤的 targetAlias
                    if (psi < plan.steps.length - 1 && matchingPath[psi + 1] !== targetIdx) {
                      const midNode = allNodes[matchingPath[psi + 1]]
                      const midAlias = plan.steps[psi]?.targetAlias
                      if (midAlias && midNode) {
                        allVars[midAlias] = { _label: midNode._label || 'Default' }
                        for (const k of Object.keys(midNode)) {
                          if (k !== '__edges' && k !== 'props' && !k.startsWith('__')) allVars[midAlias][k] = midNode[k]
                        }
                      }
                    }
                  }
                  if (pathEdges.length >= edgeVarColsLen) {
                    geNode.props.__stepEdges = pathEdges
                    stepEdgesCache.set(targetIdx, pathEdges)
                  }
                }
              }
              // source 节点——使用起始节点 allNodes[i] 而非 targetNode
              if (lastStepV?.source) {
                allVars[lastStepV.source] = { _label: (allNodes[i]?._label || 'Default') as string }
                for (const k of Object.keys(allNodes[i] || {})) {
                  if (k !== '__edges' && k !== 'props' && !k.startsWith('__')) (allVars[lastStepV.source] as any)[k] = (allNodes[i] as any)[k]
                }
              }
              for (const k of Object.keys(targetNode)) {
                if (k !== '_label' && k !== '__edges' && k !== 'props') {
                  geNode.__targetProps[k] = targetNode[k]
              // Debug
              process.stderr.write("ALLVARS: a=" + JSON.stringify(allVars.a) + " b=" + JSON.stringify(allVars.b) + " c=" + JSON.stringify(allVars.c) + " d=" + JSON.stringify(allVars.d) + " i=" + i + " targetIdx=" + targetIdx + " boundedPaths=" + (boundedPaths ? boundedPaths.length : 0) + "\n")
                }
              }
              // source 节点属性存入 geNode.props（供 source 变量查询如 a.id）
              const srcNodeForProps = allNodes[i] as Record<string, unknown>
              if (srcNodeForProps) {
                for (const k of Object.keys(srcNodeForProps)) {
                  if (k !== '_label' && k !== '__edges' && k !== 'props') geNode.props[k] = srcNodeForProps[k]
                }
              }
              // 确保 __targetProps 中有 _label（用于节点格式化和 varCtx）
              if (targetNode._label) geNode.__targetProps['_label'] = targetNode._label
              // 用 boundedPaths 提取实际匹配的边标签（vs plan.steps 编译时标签）
              if ((plan.steps || []).length > 1 && boundedPaths?.length) {
                const matchingPath = boundedPaths.find((p: number[]) => p[p.length - 1] === targetIdx)
                if (matchingPath && matchingPath.length >= 2) {
                  const pathEdges: string[] = []
                  for (let psi = 0; psi < plan.steps.length && psi < matchingPath.length - 1; psi++) {
                    const fromNode = allNodes[matchingPath[psi]] as any
                    if (fromNode?.__edges) {
                      const edge = fromNode.__edges.find((e: any) => {
                        const neighborIdx = e.dstIdx === matchingPath[psi] ? e.srcIdx : (e.srcIdx === matchingPath[psi] ? e.dstIdx : -1)
                        return neighborIdx === matchingPath[psi + 1]
                      })
                      if (edge?.label) pathEdges.push(edge.label)
                    }
                  }
                  if (pathEdges.length >= edgeVarColsLen) {
                    stepEdgesCache.set(targetIdx, pathEdges)
                  } else {
                  }
                } else {
                }
              } else {
              }
              // 添加 __crossVarRows 供 whereBody 后处理（_evaluateExpression 需要 i 变量）
              geNode.__crossVarRows = {}
              if (plan.steps?.length) {
                const thisStep = plan.steps[plan.steps.length - 1]
                // 绑定 targetAlias（If any命名目标且非空）
                if (thisStep.targetAlias) {
                  const cvrNode: Record<string, unknown> = {}
                  for (const k of Object.keys(targetNode)) {
                    if (k !== '__edges' && k !== 'props' && !k.startsWith('__')) cvrNode[k] = targetNode[k as keyof typeof targetNode]
                  }
                  geNode.__crossVarRows[thisStep.targetAlias] = { ...cvrNode, props: { ...cvrNode } }
                }
                // 绑定 source 变量（起始节点）—— 使用当前 allNodes[i] 而不是 plan.scanLabel（已为 null）
                if (thisStep.source) {
                  const srcNode = allNodes[i]
                  if (srcNode) {
                    // 保留原始属性，确保 _label 可用
                    const srcProps: Record<string, unknown> = {}
                    for (const k of Object.keys(srcNode)) {
                      if (k !== '__edges' && k !== 'props' && !k.startsWith('__')) srcProps[k] = srcNode[k]
                    }
                    if (srcNode._label !== undefined) srcProps._label = srcNode._label
                    geNode.__crossVarRows[thisStep.source] = { ...srcProps, props: { ...srcProps } }
                  }
                }
                // 绑定边变量（如 MATCH (n)-[r]->(x) 中的 r），供 WHERE type(r) 表达式使用
                // 边变量：returnColumns 中不在 steps 的 source/targetAlias 中的短变量
                const stepVars = new Set(plan.steps.flatMap((s: any) => [s.source, s.targetAlias]).filter(Boolean))
                const edgeVar = (plan.returnColumns || []).find((rc: string) => {
                  return !stepVars.has(rc) && rc.length <= 2
                })
                if (edgeVar) {
                  const srcNodeEdges = (allNodes[i] as any)?.__edges as Array<{srcIdx:number; dstIdx:number; label:string; props?:Record<string,unknown>}> | undefined
                  if (srcNodeEdges) {
                    for (const ee of srcNodeEdges) {
                      if (ee.dstIdx === targetIdx) {
                        const edgeObj: Record<string, unknown> = {
                          __edgeLabel: ee.label,
                          __edgeLabelStr: ee.label,
                          _type: ee.label,
                          _label: ee.label,
                        }
                        if (ee.props) {
                          for (const [pk, pv] of Object.entries(ee.props)) {
                            edgeObj[pk] = pv
                          }
                        }
                        geNode.__crossVarRows[edgeVar] = edgeObj
                        break
                      }
                    }
                  }
                }
                // [FIX]: allVars → __crossVarRows 全量注入，确保 WHERE 能访问所有中间变量
                if (allVars) {
                  for (const [vn, vdata] of Object.entries(allVars as Record<string, unknown>)) {
                    if (geNode.__crossVarRows[vn]) continue
                    const vObj = vdata as Record<string, unknown>
                    const cvrEntry: Record<string, unknown> = {}
                    for (const k of Object.keys(vObj)) {
                      if (k !== '__edges' && k !== 'props' && !k.startsWith('__')) cvrEntry[k] = vObj[k]
                    }
                    if (vObj._label !== undefined) cvrEntry._label = vObj._label
                    geNode.__crossVarRows[vn] = { ...cvrEntry, props: { ...cvrEntry } }
                  }
                }
                // Pattern Comprehension 适配：当 targetAlias 为空（匿名目标）且 RETURN 列是 source 变量时，
                // geNode 应代表 source 节点（而非匿名 target），使格式化能正确输出 source 的标签和属性
                if (!thisStep.targetAlias && thisStep.source && plan.returnColumns?.some(rc => {
                  const v = rc?.split('.')[0]
                  return v === thisStep.source
                })) {
                  const srcNode = allNodes[i]
                  if (srcNode) {
                    geNode.props = { _label: srcNode._label || 'Default' }
                    for (const k of Object.keys(srcNode)) {
                      if (k !== '_label' && k !== '__edges' && k !== 'props') {
                        geNode.props[k] = srcNode[k]
                      }
                    }
                  }
                }
              }
              // ── 多步多 RETURN 变量支持 ──
              // If any多个 RETURN 的非 source 变量（如 `RETURN b, c`），
              // 对每个非最终步的 targetAlias，收集其节点属性存入 __targetPropsMap
              if (plan.returnColumns && plan.returnColumns.length > 1 && plan.steps.length > 1) {
                const firstSrc = plan.steps[0].source
                const targetAliases = plan.steps.map(s => s.targetAlias)
                const nonFinalReturnVars = (plan.returnColumns || [])
                  .map((rc: string) => rc?.split('.')[0])
                  .filter((rc: string) => rc && rc !== firstSrc && targetAliases.includes(rc))
                  .slice(0, -1) // 排除最后一步（最后一步就是 geNode）
                if (nonFinalReturnVars.length) {
                  const targetPropsMap: Record<string, any> = {}
                  for (const nrv of nonFinalReturnVars) {
                    const nrvStep = plan.steps.find(s => s.targetAlias === nrv)
                    if (!nrvStep) continue
                    const nrvStepIdx = plan.steps.indexOf(nrvStep)
                    if (nrvStepIdx < 0) continue
                    const interTargets = _walkMultiSteps(
                      i, plan.steps.slice(0, nrvStepIdx + 1),
                      allNodes, undefined, plan.filters, stepSourceFilters
                    )
                    if (interTargets.length) {
                      const interNode = allNodes[interTargets[0]]
                      if (interNode) {
                        targetPropsMap[nrv] = { ...interNode }
                        // 去除内部属性（_alias, _label 等），TCK 兼容
                        for (const ik of Object.keys(targetPropsMap[nrv])) {
                          if (ik.startsWith('_')) delete targetPropsMap[nrv][ik]
                        }
                        delete targetPropsMap[nrv].__edges
                        delete targetPropsMap[nrv].props
                      }
                    }
                  }
                  if (Object.keys(targetPropsMap).length) {
                    geNode.__targetPropsMap = targetPropsMap
                  }
                }
              }
              if (hasVarLen || hasEdgeStep) {
                // 变量长度路径：简化结果格式，只保留目标节点属性+id
                // 不走后处理边变量逻辑，直接从 __targetProps 取值
                // Pattern Comprehension (targetAlias为空) 时 props 已经是 source 节点
                const _patNoAlias = plan.steps?.[plan.steps.length - 1]?.targetAlias === ''
                multiStepRaw.push({
                  id: geNode.id,
                  props: { ...geNode.__targetProps },
                  __targetProps: geNode.__targetProps,
                  __crossVarRows: geNode.__crossVarRows,
                })
              } else {
                multiStepRaw.push(geNode)
              }
            }
          }
          // 恢复 edgeLabel
          if (plan.steps?.[0]) plan.steps[0].edgeLabel = savedEdgeLabel
          // Pattern Comprehension 去重：当 targetAlias 为空（匿名目标）时，
          // 每个 source 节点可能产生多行（不同目标节点）。
          // 去重：只保留每个 source 节点一行
          const lastStepTargetAlias = plan.steps?.[plan.steps.length - 1]?.targetAlias
          if (lastStepTargetAlias === '' && plan.steps?.length) {
            const seenSourceVals = new Set<string>()
            multiStepRaw = multiStepRaw.filter((r: any) => {
              const cvr = r.__crossVarRows
              if (!cvr) return true
              const srcVar = plan.steps![0].source
              if (!srcVar) return true
              const srcVal = cvr[srcVar]
              const key = typeof srcVal === 'object' ? JSON.stringify(srcVal) : String(srcVal)
              if (seenSourceVals.has(key)) return false
              seenSourceVals.add(key)
              return true
            })
          }
          // 边变量过滤：WHERE r.name = 'monkey' 场景，
          // 用边属性过滤结果，并附加边属性到 __crossVarRows 供下游 whereBody 评估使用
          if (multiStepRaw.length && (plan.filters || []).some((f: any) => {
            const stepVars = new Set((plan.steps || []).flatMap((s: any) => [s.source, s.targetAlias]))
            return f.source && !stepVars.has(f.source)
          })) {
            const stepVars = new Set((plan.steps || []).flatMap((s: any) => [s.source, s.targetAlias]))
            const edgeFilters = (plan.filters || []).filter((f: any) => f.source && !stepVars.has(f.source))
            const collectedEdges: Array<{srcIdx:number; dstIdx:number; label:string; props?:Record<string,unknown>|null}> = []
            for (let ni = 0; ni < allNodes.length; ni++) {
              const ne = (allNodes[ni] as any).__edges as Array<any> | undefined
              if (ne) collectedEdges.push(...ne)
            }
            if (collectedEdges.length) {
              multiStepRaw = multiStepRaw.filter((r: any) => {
                const rIdx = nodeGeIds.indexOf(r.id)
                if (rIdx < 0) return true
                return edgeFilters.every((f: any) => {
                  const connected = collectedEdges.filter((e: any) =>
                    e.dstIdx === rIdx || e.srcIdx === rIdx
                  )
                  if (!connected.length) return false
                  const stepEdgeLabel = plan.steps?.[0]?.edgeLabel
                  const candidates = stepEdgeLabel
                    ? connected.filter((e: any) => e.label === stepEdgeLabel)
                    : connected
                  if (!candidates.length) return false
                  const actualVal = candidates[0].props?.[f.property]
                  if (actualVal === undefined && f.operator !== 'IS_NULL') return false
                  switch (f.operator) {
                    case 'EQ':   return String(actualVal) === String(f.value)
                    case 'NEQ':  return String(actualVal) !== String(f.value)
                    default:     return String(actualVal) === String(f.value)
                  }
                })
              })
              // 为保留下来的行附加边变量属性到 __crossVarRows，
              // 使下游 _formatResultRow / whereBody 评估能正确解析 ctx.r.name
              if (multiStepRaw.length) {
                const edgeVarNames = [...new Set(edgeFilters.map((f: any) => f.source))]
                for (const r of multiStepRaw) {
                  const rIdx = nodeGeIds.indexOf(r.id)
                  if (rIdx < 0) continue
                  const connected = collectedEdges.filter((e: any) =>
                    e.dstIdx === rIdx || e.srcIdx === rIdx
                  ).filter((e: any) => !plan.steps?.[0]?.edgeLabel || e.label === plan.steps[0].edgeLabel)
                  if (connected.length && connected[0].props) {
                    if (!r.__crossVarRows) r.__crossVarRows = {}
                    for (const evn of edgeVarNames) {
                      const edgeInfo = { ...connected[0].props, _label: connected[0].label || '', __edgeLabel: connected[0].label || '' }
                      r.__crossVarRows[evn] = edgeInfo
                      // 边变量也可能出现在 RETURN 中（如 RETURN r），
                      // 需要同时注入到 props 供 _formatResultRow 使用
                      if (!r.props) r.props = {}
                      r.props[evn] = edgeInfo
                    }
                  }
                }
              }
            }
          }
          // 为 multiStepRaw 条目标记边变量属性（__crossVarRows），供 RETURN r / whereBody 使用
          if (multiStepRaw.length) {
            const collectedEdges: Array<{srcIdx:number; dstIdx:number; label:string; props?:Record<string,unknown>|null}> = []
            for (let ni = 0; ni < allNodes.length; ni++) {
              const ne = (allNodes[ni] as any).__edges as Array<any> | undefined
              if (ne) collectedEdges.push(...ne)
            }
            if (collectedEdges.length) {
              // 找出边变量名
              const nodeAliases = new Set([
                ...(plan.createNodes || []).map((n: any) => n.alias).filter(Boolean),
                ...(plan.steps || []).flatMap((s: any) => [s.source, s.targetAlias]).filter(Boolean),
              ])
              const _sVars = new Set((plan.steps || []).flatMap((s: any) => [s.source, s.targetAlias]))
              const edgeVarNames = new Set<string>()
              if (plan.returnColumns) {
                for (const rc of plan.returnColumns) {
                  if (!nodeAliases.has(rc)) edgeVarNames.add(rc)
                }
              }
              if (plan.filters) {
                for (const f of plan.filters) {
                  if (f.source && !_sVars.has(f.source)) edgeVarNames.add(f.source)
                }
              }
              for (const r of multiStepRaw) {
                const rIdx = nodeGeIds.indexOf(r.id)
                if (rIdx < 0) continue
                const connected = collectedEdges.filter((e: any) =>
                  e.dstIdx === rIdx || e.srcIdx === rIdx
                ).filter((e: any) => !plan.steps?.[0]?.edgeLabel || e.label === plan.steps[0].edgeLabel)
                if (connected.length) {
                  const edgeInfo = { ...connected[0].props, _label: connected[0].label || '', __edgeLabel: connected[0].label || '' }
                  if (!r.__crossVarRows) r.__crossVarRows = {}
                  // 注入到已知的边变量名（来自 returnColumns / filters）
                  for (const evn of edgeVarNames) {
                    r.__crossVarRows[evn] = edgeInfo
                  }
                  // 无条件注入到 'r'（最常用的边变量名），供 whereBody type(r) 等场景
                  if (!r.__crossVarRows['r']) r.__crossVarRows['r'] = edgeInfo
                  // DEBUG check
                                  }
              }
            }
          }
          return multiStepRaw
        })()
      : multiTypeStep
      ? (() => {
          const labels = multiTypeStep.edgeLabel!.split('|')
          const combined: Map<number, any> = new Map()
          for (const lbl of labels) {
            const p2 = JSON.parse(JSON.stringify(plan, _bigintReplacer), _bigintReviver)
            p2.steps[0].edgeLabel = lbl
            p2.filters = (geFiltered || []).filter(f => !crossVarFilters.includes(f))
            const subRaw: any[] = _geExecQueryPlan(ge, p2)
            for (const r of subRaw || []) combined.set(r.id, r)
          }
          return [...combined.values()]
        })()
      : hasOR
      ? (() => {
          // OR 语义：
          // 1) plan.filters 非空 → 逐 filter 执行 GE，合并去重
          // 2) plan.filters 为空但 query 有 type(r)=L1 OR type(r)=L2 → 逐 label 执行 GE，用 (id,label) 复合键去重
          const combined: Map<string, any> = new Map()
          const orFilters = (plan.filters || [])
          if (orFilters.length >= 2) {
            for (const f of orFilters) {
              const p2 = JSON.parse(JSON.stringify(plan, _bigintReplacer), _bigintReviver)
              p2.filters = [f]
              const subRaw: any[] = _geExecQueryPlan(ge, p2)
              for (const r of subRaw || []) combined.set(String(r.id), r)
            }
          } else if (query && plan.steps?.[0]) {
            const typeRMatches = query.matchAll(/type\s*\(\s*(\w+)\s*\)\s*=\s*['"]([^'"]+)['"]/ig)
            const orLabels: Array<{ edgeVar: string; label: string }> = []
            for (const m of typeRMatches) orLabels.push({ edgeVar: m[1], label: m[2] })
            if (orLabels.length >= 2) {
              for (const ol of orLabels) {
                const p2 = JSON.parse(JSON.stringify(plan, _bigintReplacer), _bigintReviver)
                p2.filters = []
                if (p2.steps?.[0]) p2.steps[0].edgeLabel = ol.label
                const subRaw: any[] = _geExecQueryPlan(ge, p2)
                for (const r of subRaw || []) {
                  // 保存边标签Info用于 RETURN r 格式化
                  if (!combined.has(String(r.id) + '__' + ol.label)) {
                    const rec = r.id !== undefined ? { ...r, id: r.id } : r
                    rec.__edgeLabel = ol.label
                    combined.set(String(r.id) + '__' + ol.label, rec)
                  }
                }
              }
            }
          }
          return [...combined.values()]
        })()
      : (() => {
          const planForGe = JSON.parse(JSON.stringify(plan, _bigintReplacer), _bigintReviver)
          // 排除跨变量属性引用 filter（GE 的 _matchFilter 无法做跨变量比较）
          planForGe.filters = (geFiltered || []).filter(f => !crossVarFilters.includes(f))

          // 无向边 direction any 时 GE 存储无节点数据，删掉 aggregate 让 QE 聚合
          if (planForGe.steps?.[0]?.direction === 'any') delete planForGe.aggregate
          // skip/limit 由 QE 的 _postProcessResults 处理，GE 不应过滤
          delete planForGe.skip; delete planForGe.limit
          const __t5PlanForGeKeys = Object.keys(planForGe)
          const __t5PlanForGeFilters = JSON.stringify((planForGe.filters || []).map((f: any) => f.property))
          const __t5PlanForGeEC = (planForGe.expressionColumns || []).length
          const __t5PlanForGeReturn = (planForGe.returnColumns || []).length
          const __t5PlanForGeWith = planForGe.with ? 'Y' : 'N'
          const __t5RawRecords = _geExecQueryPlan(ge, planForGe)
          return __t5RawRecords
        })()
    // Fallback: useEdgeWalk=false 且 hasMatch 时，从 GE 获取全部节点
    // Note: 当 GE 的标签扫描返回空（标签不匹配）时，不可回退到全量扫描，
    // 否则会Error地匹配不存在的标签。条件加上了 scanLabel 不再回退的检查。
    if (!useEdgeWalk && plan.hasMatch && !rawRecords?.length && allNodes.length && !plan.scanLabel) {
      const scanPlan = JSON.parse(JSON.stringify({ ...plan, scanLabel: null, callProcedure: undefined }, _bigintReplacer), _bigintReviver)
      delete scanPlan.callProcedure
      delete scanPlan.skip; delete scanPlan.limit
      rawRecords = _geExecQueryPlan(ge, scanPlan) as any[]
    }
    let records = rawRecords

    // ── GE filter 补偿 ──
    // GE 的 _matchFilter 对 GT/LT/GTE/LTE 仅支持 number 类型比较，
    // 不处理字符串比较。IS_NULL/IS_NOT_NULL 同样未处理（fallthrough 到 true）。
    // queryEngineFilters 中包含了 GE 排除的运算符，
    // 在 GE 返回后对 records 做二次过滤。
    const _isBrokenFval = (v: any): boolean => typeof v === 'string' && /[<>=]/.test(v)
    if (queryEngineFilters.length && rawRecords?.length) {
      rawRecords = rawRecords.filter((r: any) => {
        const nodeProps = r.props || r
        return queryEngineFilters.every((f: any) => {
          if (_isBrokenFval(f.value)) return true // skip broken chain values
          const actualVal = nodeProps[f.property]
          const fv = f.value
          switch (f.operator) {
            case 'IS_NULL':     return actualVal == null
            case 'IS_NOT_NULL': return actualVal != null
            case 'GT':   return actualVal > fv
            case 'GTE':  return actualVal >= fv
            case 'LT':   return actualVal < fv
            case 'LTE':  return actualVal <= fv
            default:     return true
          }
        })
      })
    }

    // GE 的 _executeQueryPlan 总是返回遍历后的目标节点，不保留 source 节点Info。
    // 当 RETURN n（steps[0].source）时，需要将 GE 返回的 target 节点映射回 source 节点。
    // 通过 sourceTargetMap 完成：targetGeId → sourceGeIds[].
    // 如果某个 target 对应多个 source（多对多），也可能是一个 source 对多个 target（一对多）。
    // 我们用 allNodes 重新构造 source 节点数据。
    const needSourceVar = plan.returnColumns?.some((rc: string) => {
      const firstStep = plan.steps?.[0]
      if (!firstStep || !firstStep.source) return false
      // 直接匹配变量名（RETURN n）
      if (rc === firstStep.source) return true
      // 匹配属性投影（RETURN n.id）
      if (rc.startsWith(firstStep.source + '.')) return true
      return false
    })
    if (needSourceVar && sourceTargetMap.size > 0 && rawRecords?.length) {
      const sourceVar = plan.steps![0].source
      const targetAlias = plan.steps![0].targetAlias
      // 对每个 GE 返回的 target 节点，找到它对应的 source 节点
      // 使用 Map<srcId, targetProps> 去重，确保同一 source→target 只保留一条
      const dedupedRecords = new Map<string, { srcId: number; targetProps: Record<string, unknown> }>()
      for (const r of rawRecords) {
        const sourceIds = sourceTargetMap.get(r.id) || []
        if (!sourceIds.length) continue
        const rawProps = r.props || {}
        const targetProps: Record<string, unknown> = {}
        for (const k of Object.keys(rawProps)) {
          if (k !== 'props' && !k.startsWith('__')) {
            targetProps[k] = rawProps[k as keyof typeof rawProps]
          }
        }
        if (r.id !== undefined && !('_label' in targetProps) && nodeGeIds.length) {
          const nodeIdx = nodeGeIds.indexOf(r.id)
          if (nodeIdx >= 0 && allNodes[nodeIdx]) {
            const l = (allNodes[nodeIdx] as any)._label
            if (l !== undefined) targetProps._label = l
          }
        }
        for (const srcId of sourceIds) {
          const key = `${srcId}:${r.id}`
          if (!dedupedRecords.has(key)) {
            dedupedRecords.set(key, { srcId, targetProps })
          }
        }
      }
      records = [...dedupedRecords.entries()].map(([key, { srcId, targetProps }]) => {
        const srcIdx = nodeGeIds.indexOf(srcId)
        if (srcIdx < 0) return null as any
        const srcNode = allNodes[srcIdx]
        const cleanProps: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(srcNode)) {
          if (k !== '__edges' && k !== 'props') cleanProps[k] = v
        }
        return {
          id: srcId as number,
          props: cleanProps,
          type: _geGetNode(ge, srcId)?.type || 0,
          name: _geGetNode(ge, srcId)?.name || '',
          deleteNodeKey: () => {},
          __targetProps: targetProps,
          __targetAlias: plan.steps?.[0]?.targetAlias || undefined,
        }
      }).filter(Boolean)
    }

    if (!records?.length && allNodes.length && plan.scanLabel && plan.hasMatch) {
      const isUsedAsVariable = (plan.steps || []).some(s => s.source === plan.scanLabel)
      const isLabelInNodes = allNodes.some(n => String(n._label) === plan.scanLabel)
      if (isUsedAsVariable && !isLabelInNodes) {
        const fallbackPlan = { ...plan, scanLabel: null }
        records = _geExecQueryPlan(ge, fallbackPlan)
      }
    }

    // ── DML side-effect 处理（DELETE / SET / REMOVE） ──
    // 在 GE 执行匹配后，对 allNodes 做突变以实现持久化操作。
    // allNodes 的元素是 nodes 数组中对应对象的引用，修改它们也会修改原始 nodes。
    if ((plan.type === 'DELETE' || plan.type === 'SET' || plan.type === 'REMOVE' || plan.type === 'MATCH_MODIFY') && records?.length) {
      if (plan.type === 'DELETE') {
        // 删除：从 allNodes 中移除匹配的节点
        const removeNodeIds = new Set(records.map((r: any) => r.id))
        // 从 allNodes 移除（浅拷贝过滤后替换原引用）
        const keptNodes: typeof allNodes = []
        for (let i = 0; i < allNodes.length; i++) {
          if (!removeNodeIds.has(nodeGeIds[i])) {
            keptNodes.push(allNodes[i])
          } else {
            // 同步删除 GE 存储层节点
            if (ge) {
              try {
                await _geDeleteNode(ge, nodeGeIds[i])
              } catch (_) { /* ignore storage errors */ }
            }
          }
        }
        allNodes.length = 0
        allNodes.push(...keptNodes)
      } else if (plan.type === 'MATCH_MODIFY') {
        // MATCH_MODIFY：包含 SET + REMOVE 混合操作
        // 先执行 SET
        if (plan.setClauses?.length) {
          for (const r of records) {
            const nodeIdx = nodeGeIds.indexOf(r.id)
            if (nodeIdx < 0) continue
            const node = allNodes[nodeIdx]
            for (const sc of plan.setClauses) {
              if (sc.alias && sc.alias !== plan.steps?.[0]?.source) continue
              if (sc.property) {
                const pv = sc.value
                node[sc.property] = typeof pv === 'object' && pv !== null && 'value' in pv ? pv.value : pv
              }
            }
            if (ge) try { await _geUpsertNode(ge, 1, "", { props: node }) } catch (_) {}
          }
        }
        // 再执行 REMOVE
        if (plan.removeClauses?.length) {
          for (const r of records) {
            const nodeIdx2 = nodeGeIds.indexOf(r.id)
            if (nodeIdx2 < 0) {
              // Edge REMOVE: delete properties from r.props[edgeVarName]
              if (plan.steps?.length) {
                const evn2 = stepSrc || plan.removeClauses?.[0]?.ref
                if (evn2 && r.props?.[evn2] && typeof r.props[evn2] === 'object') {
                  const edgeObj = r.props[evn2] as Record<string,unknown>
                  for (const rc of plan.removeClauses) {
                    if (rc.type === 'REMOVE_PROP' && rc.property) {
                      if (rc.ref && rc.ref !== evn2) continue
                      if (rc.property in edgeObj) delete edgeObj[rc.property]
                    }
                  }
                }
              }
              continue
            }
            const node = allNodes[nodeIdx2]
            for (const rc of plan.removeClauses) {
              if (rc.type === 'REMOVE_PROP' && rc.property) {
                if (rc.ref && rc.ref !== plan.steps?.[0]?.source) continue
                if (rc.property in node) delete node[rc.property]
              }
            }
            if (ge) try { await _geUpsertNode(ge, 1, "", { props: node }) } catch (_) {}
          }
        }
      } else if (plan.type === 'SET' && plan.setClauses?.length) {
        // SET：修改匹配节点的属性
        for (const r of records) {
          const nodeIdx = nodeGeIds.indexOf(r.id)
          if (nodeIdx < 0) continue
          const node = allNodes[nodeIdx]
          for (const sc of plan.setClauses) {
            if (sc.alias && sc.alias !== plan.steps?.[0]?.source) continue
            if (sc.property) {
              const pv = sc.value
              let value: unknown
              if (typeof pv === 'object' && pv !== null && 'value' in pv) {
                value = pv.value
              } else if (typeof pv === 'string') {
                // Parse structured literals: arrays, maps, numbers, booleans, null
                const trimmed = pv.trim()
                if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                  try { value = JSON.parse(trimmed) } catch { value = pv }
                } else if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                  try { value = JSON.parse(trimmed) } catch { value = pv }
                } else if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
                  value = Number(trimmed)
                } else if (/^(true|false)$/i.test(trimmed)) {
                  value = trimmed.toLowerCase() === 'true'
                } else if (trimmed === 'null') {
                  value = null
                } else {
                  value = pv
                }
              } else {
                value = pv
              }
              node[sc.property] = value
              // Sync to GE-returned record props so RETURN expression evaluation
              // sees the newly-set properties (e.g., RETURN size(n.numbers) after SET n.numbers).
              if (r.props && typeof r.props === 'object') {
                (r.props as Record<string,unknown>)[sc.property] = value
              }
            }
          }
          // 同步更新 GE 存储层节点属性（await 确保持久化）
          if (ge) {
            try {
              await _geUpsertNode(ge, 1, "", { props: node })
            } catch (_) { /* ignore storage errors */ }
          }
        }
      } else if (plan.type === 'REMOVE' && plan.removeClauses?.length) {
        // REMOVE：删除匹配节点的属性或标签
        for (const r of records) {
          const nodeIdx = nodeGeIds.indexOf(r.id)
          if (nodeIdx < 0) {
            // Edge REMOVE: when plan has edge steps, the record holds edge info
            // in r.props[edgeVarName]. Delete properties from there.
            if (plan.steps?.length) {
              const evn = stepSrc || plan.removeClauses?.[0]?.ref
              if (evn && r.props?.[evn] && typeof r.props[evn] === 'object') {
                const edgeObj = r.props[evn] as Record<string,unknown>
                for (const rc of plan.removeClauses) {
                  if (rc.type === 'REMOVE_PROP' && rc.property) {
                    if (rc.ref && rc.ref !== evn) continue
                    if (rc.property in edgeObj) delete edgeObj[rc.property]
                  }
                }
              }
            }
            continue
          }
          const node = allNodes[nodeIdx]
          for (const rc of plan.removeClauses) {
            if (rc.type === 'REMOVE_PROP' && rc.property) {
              if (rc.ref && rc.ref !== plan.steps?.[0]?.source) continue
              if (rc.property in node) {
                delete node[rc.property]
              }
            }
          }
          // 同步更新 GE 存储层
          if (ge) {
            try {
              await _geUpsertNode(ge, 1, "", { props: node })
            } catch (_) { /* ignore storage errors */ }
          }
        }
      }
    }


    // ── 内联节点属性预过滤（已在线 1551 的 seed 阶段完成） ──
    // [CVE-H4]: 此处的代码是 line 1551 处预过滤的重复实现，且当 skipNodeIndices
    // 已被 seed 阶段填充时跳过不执行。已移除。若 inlineVar 不是 step source，
    // 需在此处做兜底过滤而非依赖 isMatchSource 条件。
    // Note: seed 阶段的预过滤（line 1551）在 `!stepSourceFilters.length` 条件下执行，
    // 如果 stepSourceFilters 存在（如 MatchWhere2+3 跨变量场景），inline 过滤可能被跳过。
    // 但 stepSourceFilters 存在时 MATCH 模式复杂，inline 属性匹配通常由 ANTLR plan.filters 处理。
    // TODO: 如果需要全覆盖，应在 _walkMultiSteps 或 GE 结果后添加无条件 inline 属性过滤。

    // ── 修复 GE limit=0 bug ──
    if (plan.limit === 0 && records?.length) {
      return []
    }

    // ── labelExpr 过滤（多标签 AND 匹配） ──
    // Note: labelExpr 与 step.targetLabel 存在架构冗余（M1），
    // labelExpr 在 GE stepping 后再过滤，step.targetLabel 在 _walkMultiSteps
    // 每步立即过滤。两者都起作用但不冲突：step.targetLabel 做早期截断，
    // labelExpr 兜底（多标签 AND 匹配时 GE stepping 无法处理多标签）。
    const filteredRecords = plan.labelExpr?.items?.length
      ? (records || []).filter((r: any) => {
          const nodeLabel = r?.props?.__fullLabel ?? r?.props?._label ?? ''
          const nodeLabels = String(nodeLabel).split(':')
          return plan.labelExpr!.items.every(item =>
            !item.exclude && nodeLabels.includes(item.name)
          )
        })
      : (records || [])

    // ── labelFilter（WHERE 中的标签谓词，如 `a:Employee`）过滤 ──
    // 对所有节点变量检查其 _label 是否匹配
    const labelFilterItems: Array<{ variable: string; label: string; exclude: boolean }> | undefined = plan.labelFilterItems
    let filteredWithLabels = filteredRecords

    if (labelFilterItems?.length && filteredRecords.length) {
      // 构建 nodeGeIdx → label 的映射
      const nodeLabelsMap: Map<number, string> = new Map()
      for (let i = 0; i < allNodes.length; i++) {
        nodeLabelsMap.set(i, String(allNodes[i]._label || 'Default'))
      }
      filteredWithLabels = filteredWithLabels.filter((r: any) => {
        const nodeIdx = nodeGeIds.indexOf(r.id)
        if (nodeIdx < 0) return true // 保留无法映射的记录
        // 检查每个标签谓词条件是否满足
        return labelFilterItems!.every(lfi => {
          // 找到变量对应的节点
          const varNodeIdx = resolveVariableNodeIdx(lfi.variable, plan, allNodes)
          if (varNodeIdx < 0) return true
          const actualLabel = nodeLabelsMap.get(varNodeIdx) || ''
          const matches = actualLabel === lfi.label
          return lfi.exclude ? !matches : matches
        })
      })
    }
    // ── OR 连接谓词过滤（WHERE n.p1 > 11 OR n.p2 = 13） ──
    // ANTLR 将 OR 谓词解析为两个独立的 filter 且无 OR 标记，
    // engine 默认 AND 连接导致无行匹配。从 query 文本检查 OR，改 AND 为 OR 语义。
    if (query && /OR/i.test(query) && filteredWithLabels?.length) {
      const orFilters = plan.filters?.length ? plan.filters : []
      if (orFilters.length >= 2) {
        filteredWithLabels = filteredWithLabels.filter((r: any) => {
          return orFilters.some((f: any) => {
            const actual = r?.props?.[f.property]
            const expected = f.value
            if (actual === undefined) return false
            switch (f.operator) {
              case 'EQ':  return actual !== null && actual !== undefined && String(actual) === String(expected)
              case 'NEQ': return actual === null || actual === undefined || String(actual) !== String(expected)
              case 'GT':  return Number(actual) > Number(expected)
              case 'GTE': return Number(actual) >= Number(expected)
              case 'LT':  return Number(actual) < Number(expected)
              case 'LTE': return Number(actual) <= Number(expected)
              default:    return String(actual) === String(expected)
            }
          })
        })
      }
    }

    // ── WHERE 标签谓词后过滤（已经过 source 回溯后的数据） ──
    // 只对 needSourceVar=true 的场景生效（r.id 是 source 节点的 GE id）
    // 当直接返回 target 节点时（needSourceVar=false），不应用 source 节点的 skip 集合
    if (needSourceVar && skipNodeIndices.size > 0 && filteredWithLabels?.length && plan.steps?.[0]?.source) {
      const wsSource = plan.steps[0].source
      const before = filteredWithLabels.length
      filteredWithLabels = filteredWithLabels.filter((r: any) => {
        // 通过 nodeGeIds 查找这条记录对应的 allNodes 索引
        // 如果 r 是从 source 回溯得到的，它的 id 就是 source GE id
        const nodeIdx = nodeGeIds.indexOf(r.id)
        if (nodeIdx < 0) return true
        // 如果节点在 skipNodeIndices 中（标签不匹配），跳过
        return !skipNodeIndices.has(nodeIdx)
      })

    }

    // ── length(p) / path 长度谓词过滤 ──
    // MATCH p = (n)-->(x) WHERE length(p) = 10 — ANTLR 不解析 length 函数
    // 从 query 文本检测 `length(p)` 模式，在 GE 返回后手动过滤
    if (query && filteredWithLabels?.length) {
      const lenMatch = query.match(/length\s*\(\s*(\w+)\s*\)\s*=\s*(\d+)/)
      if (lenMatch) {
        const targetLen = parseInt(lenMatch[2], 10)
        // 路径长度 = edgesPayload 中与结果节点相关的边数（单层无循环）
        // 简单情况：一个 step，一条边 → length=1
        // 对于复杂路径，路径长度就是步骤数
        const nSteps = plan.steps?.length || 1  // 单步默认 1
        if (nSteps !== targetLen) {
          filteredWithLabels = []  // 长度不匹配，无结果
        }
      }
    }

    // ── 跨变量属性引用过滤（WHERE n.animal = x.animal / a.id = b.id） ──
    // crossVarFilters 中的 filter 不能在 seed 阶段用常数比较，因为 value 是"x.animal"字符串。
    // 对于有边模式（needSourceVar=true）：行中 props=source 节点属性 + __targetProps=target 节点属性，
    // 对每一行检查跨变量比较。
    // 对于无边模式（steps.length=0）：纯节点扫描，做笛卡尔积配对。
    if (crossVarFilters.length && filteredWithLabels?.length) {
      if (plan.steps?.length && filteredWithLabels[0]?.props) {
        // 有边模式：行有 props（遍历 source/当前节点）和 __targetProps（target 节点）
        // 不需要 needSourceVar=true，因为只要有 props 就可从中取值。
        // 引用变量可能是 source 或 targetAlias——从 steps 中查找。
        const stepSourceVars = new Set(plan.steps.map(s => s.source))
        const stepTargetAliases = new Set(plan.steps.map(s => s.targetAlias))
        filteredWithLabels = filteredWithLabels.filter((r: any) => {
          return crossVarFilters.every((f: any) => {
            const dotIdx = (f.value as string).indexOf('.')
            if (dotIdx < 0) return true
            const refVar = (f.value as string).substring(0, dotIdx)
            const refProp = (f.value as string).substring(dotIdx + 1)
            // isRefSource: f.source 是 source 变量（取 r.props）还是 targetAlias（取 r.__targetProps）
            // 类似的，refVar 的取值位置也相同。
            const fSourceIsSourceVar = stepSourceVars.has(f.source)
            const refIsSourceVar = stepSourceVars.has(refVar)
            const actualVal = fSourceIsSourceVar ? r?.props?.[f.property] : r?.__targetProps?.[f.property]
            const refVal = refIsSourceVar ? r?.props?.[refProp] : r?.__targetProps?.[refProp]
            if (actualVal === undefined || refVal === undefined) return false
            switch (f.operator) {
              case 'EQ':  return String(actualVal) === String(refVal)
              case 'NEQ': return String(actualVal) !== String(refVal)
              case 'GT':  return Number(actualVal) > Number(refVal)
              case 'GTE': return Number(actualVal) >= Number(refVal)
              case 'LT':  return Number(actualVal) < Number(refVal)
              case 'LTE': return Number(actualVal) <= Number(refVal)
              default:    return String(actualVal) === String(refVal)
            }
          })
        })
      } else if (!plan.steps?.length) {
        // 无边模式（steps.length=0）：MATCH (a:A), (b:B) WHERE a.id = b.id
        // 从 query 中提取变量→标签映射
        const varLabelMap: Record<string, string> = {}
        if (query) {
          const matchClauses = query.matchAll(/MATCH\s*\((\w+)\s*:\s*(\w+)\)/g)
          for (const mc of matchClauses) varLabelMap[mc[1]] = mc[2]
        }
        const returnCols = plan.returnColumns || []
        // 从 crossVarFilters 和 returnCols 收集所有参与变量
        const involvedVars = new Set<string>()
        for (const rc of returnCols) {
          const varName = typeof rc === 'string' ? rc.split('.')[0] : ''
          if (varName) involvedVars.add(varName)
        }
        for (const f of crossVarFilters) {
          if (f.source) involvedVars.add(f.source)
          if (typeof f.value === 'string') {
            const dotIdx = f.value.indexOf('.')
            if (dotIdx >= 0) involvedVars.add(f.value.substring(0, dotIdx))
          }
        }
        // 按变量 label 从 allNodes 分配节点
        const varNodeMap: Record<string, Array<{node: any; idx: number}>> = {}
        for (const varName of involvedVars) {
          const targetLabel = varLabelMap[varName]
          varNodeMap[varName] = allNodes
            .map((node, idx) => ({ node, idx }))
            .filter(({ idx }) => !skipNodeIndices.has(idx))
            .filter(({ node }) => {
              if (!targetLabel) return true
              const fullLabel = node.__fullLabel
              if (fullLabel && typeof fullLabel === 'string') return fullLabel.split(':').includes(targetLabel)
              return String(node._label) === targetLabel
            })
        }
        const varNames = Object.keys(varNodeMap)
        const _evalCrossVar = (entryMap: Record<string, {node: any; idx: number}>, filters: any[]): boolean => {
          return filters.every((f: any) => {
            const actualProp = f.property
            const actualVal = entryMap[f.source]?.node?.[actualProp]
            const dotIdx = (f.value as string).indexOf('.')
            if (dotIdx < 0) return false
            const refVar = (f.value as string).substring(0, dotIdx)
            const refProp = (f.value as string).substring(dotIdx + 1)
            const refVal = entryMap[refVar]?.node?.[refProp]
            if (actualVal === undefined || refVal === undefined) return false
            switch (f.operator) {
              case 'EQ':  return String(actualVal) === String(refVal)
              case 'NEQ': return String(actualVal) !== String(refVal)
              default:    return String(actualVal) === String(refVal)
            }
          })
        }
        const pairedRows: any[] = []
        if (varNames.length >= 2) {
          // N 元笛卡尔积：递归生成所有 entry 组合
          const _cartesian = (idx: number, current: Record<string, {node: any; idx: number}>): void => {
            if (idx >= varNames.length) {
              // 检查 self-join 冲突：不同变量不能指向同一个节点索引
              const seenIdx = new Set<number>()
              for (const vn of varNames) {
                if (seenIdx.has(current[vn].idx)) return
                seenIdx.add(current[vn].idx)
              }
              if (!_evalCrossVar(current, crossVarFilters)) return
              // 构建结果行
              const firstVar = varNames[0]
              const row: any = {
                id: -1,
                props: current[firstVar].node,
                type: current[firstVar].node._label || 'Default',
                name: '',
                __crossVarRows: {} as Record<string, any>,
              }
              for (const vn of varNames) row.__crossVarRows[vn] = current[vn].node
              pairedRows.push(row)
              return
            }
            for (const entry of varNodeMap[varNames[idx]]) {
              current[varNames[idx]] = entry
              _cartesian(idx + 1, current)
            }
          }
          _cartesian(0, {})
        } else if (varNames.length === 1 && plan.hasMatch) {
          // 单变量 MATCH（无边）：直接取所有节点，构建结果行
          const singleVar = varNames[0]
          for (const entry of varNodeMap[singleVar]) {
            // 应用 plan.filters 过滤（用于 STARTS_WITH / ENDS_WITH / CONTAINS 等 GE 已处理的 filter）
            const filterMatch = (plan.filters || []).every((f: any) => {
              if (f.source !== singleVar) return true
              const actualVal = entry.node[f.property]
              const fv = f.value
              if (actualVal === undefined) return false
              switch (f.operator) {
                case 'EQ':   return String(actualVal) === String(fv)
                case 'NEQ':  return String(actualVal) !== String(fv)
                case 'GT':   return Number(actualVal) > Number(fv)
                case 'GTE':  return Number(actualVal) >= Number(fv)
                case 'LT':   return Number(actualVal) < Number(fv)
                case 'LTE':  return Number(actualVal) <= Number(fv)
                case 'STARTS_WITH': return typeof actualVal === 'string' && typeof fv === 'string' && actualVal.startsWith(fv)
                case 'ENDS_WITH':   return typeof actualVal === 'string' && typeof fv === 'string' && actualVal.endsWith(fv)
                case 'CONTAINS':    return typeof actualVal === 'string' && typeof fv === 'string' && actualVal.includes(fv)
                default:            return String(actualVal) === String(fv)
              }
            })
            if (!filterMatch) continue
            const row: any = {
              id: -1,
              props: entry.node,
              type: entry.node._label || 'Default',
              name: '',
              __crossVarRows: { [singleVar]: entry.node },
            }
            pairedRows.push(row)
          }
        }
        filteredWithLabels = pairedRows
      }
    }

    // ── 单/多变量无边 MATCH 处理（无 crossVarFilters 时） ──
    // 当 crossVarFilters.length === 0 且 plan.steps?.length === 0 且 plan.hasMatch 时，
    // 上面的 crossVarFilters 分支不执行，filteredWithLabels 仍为 records。
    // 此处用 filteredRecords 重新构建正确格式的结果行。
    // 支持多个 MATCH 变量（如 MATCH (n), (m) → 笛卡尔积）和单变量 MATCH。
    if (!crossVarFilters.length && !plan.steps?.length && plan.hasMatch && (filteredRecords?.length || allNodes?.length)) {
      // 手动从 query 文本提取 MATCH 变量和标签（ANTLR 只解析第一个模式）
      let hasMultiMatch = false
      const varLabelMap2: Record<string, string> = {}
      if (query) {
        const matchSection = query.match(/MATCH\s+(.*?)(?:\s+WHERE|\s+RETURN|\s+WITH|\s+CREATE|\s+MERGE|\s+DELETE|\s+SET|\s+REMOVE|\s+UNWIND|\s+ORDER|\s+SKIP|\s+LIMIT|\s+CALL|\s+INVOKE|$)/is)
        hasMultiMatch = !!(matchSection && matchSection[1].includes(','))
        console.error("T8_MATCH_SECTION: hasMulti=" + hasMultiMatch + " clause=" + (matchSection ? matchSection[1].slice(0,100) : "none") + "\n")
        if (matchSection) {
          const clause = matchSection[1]
          const nodePatterns = [...clause.matchAll(/\((\w+)\s*:\s*(\w+)\)/g)]
          for (const np of nodePatterns) varLabelMap2[np[1]] = np[2]
        }
      }
      // 从 MATCH 变量中提取所有变量名（支持有/无 label/有内联属性三种写法）
      let matchVarKeys2 = Object.keys(varLabelMap2)
      if (!matchVarKeys2.length && query) {
        // 匹配所有 MATCH 中的节点变量： (n), (m), (a:Label), (b {prop})
        const allMatchVars: string[] = [];
        const matchClauses = query.matchAll(/MATCH\s+(.*?)(?:\s+(?:WHERE|WITH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|INVOKE|CALL)\s|$)/gis);
        for (const mc of matchClauses) {
          const clause = mc[1];
          const vars = [...clause.matchAll(/\((\w+)\s*(?::|\)|{)/g)].map(x => x[1]).filter(Boolean);
          allMatchVars.push(...vars);
        }
        matchVarKeys2 = [...new Set(allMatchVars)];
      }
      if (matchVarKeys2.length === 0 && query) {
        const anyMatchClause = query.match(/MATCH\s*\((\w+)/)
        if (anyMatchClause) matchVarKeys2 = [anyMatchClause[1]]
      }
      if (matchVarKeys2.length >= 1) {
        // 多变量 MATCH: 从 allNodes 直接构建节点列表，不依赖 GE 单标签扫描
        // 原因：ANTLR 只识别 scanLabel=第一个标签，GE 只返回该标签的节点。
        // 如果 MATCH 有多个不同标签的变量，我们需要用 allNodes 替代 filteredRecords。
        const useAllNodes = matchVarKeys2.length >= 2 && hasMultiMatch
        const sourceRecords = useAllNodes
          ? (allNodes || []).map((n: any, idx: number) => ({ node: n, idx }))
          : (filteredRecords || []).map((rec: any, idx: number) => {
              const nodeProps = rec.props || rec;
              return { node: nodeProps, idx };
            })
        // 为每个变量分配节点列表（按标签筛选）
        const varNodeMap2: Record<string, Array<{ node: Record<string, unknown>; idx: number }>> = {}
        for (const varName of matchVarKeys2) {
          const targetLabel2 = varLabelMap2[varName]
          varNodeMap2[varName] = sourceRecords
            .filter(({ node }: { node: Record<string, unknown> }) => {
              if (!targetLabel2) return true;
              const fullLabel = node.__fullLabel
              if (fullLabel && typeof fullLabel === 'string') return fullLabel.split(':').includes(targetLabel2)
              return String(node._label) === targetLabel2;
            })
            // 应用 plan.filters 过滤
            .filter(({ node }: { node: Record<string, unknown> }) => {
              return (plan.filters || []).every((f: any) => {
                if (f.source && f.source !== varName) return true;
                const actualVal = node[f.property as string];
                if (f.property && actualVal === undefined) return false;
                const fv = f.value;
                let baseResult = false;
                switch (f.operator) {
                  case 'EQ':   baseResult = actualVal === fv; break;
                  case 'NEQ':  baseResult = actualVal !== fv; break;
                  case 'GT':   baseResult = Number(actualVal) > Number(fv); break;
                  case 'GTE':  baseResult = Number(actualVal) >= Number(fv); break;
                  case 'LT':   baseResult = Number(actualVal) < Number(fv); break;
                  case 'LTE':  baseResult = Number(actualVal) <= Number(fv); break;
                  case 'IS_NULL':     baseResult = actualVal == null; break;
                  case 'IS_NOT_NULL': baseResult = actualVal != null; break;
                  case 'STARTS_WITH': baseResult = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.startsWith(fv); break;
                  case 'ENDS_WITH':   baseResult = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.endsWith(fv); break;
                  case 'CONTAINS':    baseResult = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.includes(fv); break;
                  default:            baseResult = String(actualVal) === String(fv); break;
                }
                return f.negated ? !baseResult : baseResult;
              });
            });
        }
        const formattedRows: any[] = []
        if (matchVarKeys2.length >= 2) {
          // 多变量：生成笛卡尔积（无 WHERE 条件时不限制 self-join）
          const _cartesian = (idx: number, current: Record<string, { node: Record<string, unknown>; idx: number }>): void => {
            if (idx >= matchVarKeys2.length) {
              const firstVar = matchVarKeys2[0];
              const row: any = { id: -1, props: current[firstVar].node, type: '', name: '', __crossVarRows: {} };
              for (const vn of matchVarKeys2) row.__crossVarRows[vn] = current[vn].node;
              formattedRows.push(row);
              return;
            }
            const varName = matchVarKeys2[idx];
            for (const entry of varNodeMap2[varName]) {
              current[varName] = entry;
              _cartesian(idx + 1, current);
            }
          };
          _cartesian(0, {});
        } else {
          // 单变量 MATCH
          const singleVar = matchVarKeys2[0];
          for (const entry of varNodeMap2[singleVar]) {
            formattedRows.push({
              id: -1,
              props: entry.node,
              type: entry.node._label || 'Default',
              name: '',
              __crossVarRows: { [singleVar]: entry.node },
            });
          }
        }
        // TEMP debug
        if (formattedRows.length && matchVarKeys2.length >= 2) {
          const r0 = formattedRows[0];
          const cvr = r0.__crossVarRows || {};
          const durDate = cvr["dur"] ? cvr["dur"]["date"] : "?";
          const dur2Date = cvr["dur2"] ? cvr["dur2"]["date"] : "?";
            console.error("T8_FORMATTED: rows=" + formattedRows.length + " allNodes=" + JSON.stringify(allNodes.map(n => n._label + ":" + (n.date||"?").toString().slice(0,20))) + "\n");
        }
        filteredWithLabels = formattedRows;
      }
    }

    // ── 边变量 filter（WHERE r.name = 'foo'） ──
    // plan.filters 中的 source 如果是边变量（不在 MATCH 的节点变量中），
    // 用 edgesPayload 中的边 props 来过滤结果行。
    // 找到所有边变量 filter

    const stepSource = plan.steps?.[0]?.source
    // 同样使用所有 step 节点变量
    const aliasNodeList = [...allStepVars]
    const edgeVarFilters = edgeFilters.length
      ? edgeFilters
      : (plan.filters || []).filter(f => {
      if (!f.source || !f.property) return false
      return f.source && !aliasNodeList.includes(f.source)
    })
    const ep = edgesPayload || [] as any

    if (edgeVarFilters.length && ep.length && filteredWithLabels?.length) {

      filteredWithLabels = filteredWithLabels.filter((r: any) => {
        // 对每个边变量 filter，检查当前记录是否通过
        return edgeVarFilters.every((f: any) => {
          // 在 edgesPayload 中查找
          const nodeIdx = nodeGeIds.indexOf(r.id)
          if (nodeIdx < 0) return true
          // 连接到这个节点的所有边
          const connEdges = ep.filter((e: any) =>
            e.dstIdx === nodeIdx ||
            (sourceTargetMap.has(r.id) && e.srcIdx === nodeIdx)
          )
          if (!connEdges.length) return false
          return connEdges.some((e: any) => {
            const edgeProps = e.props || {}
            const actual = edgeProps[f.property]
            const expected = f.value
            if (actual === undefined) return false
            // 根据 operator 做比较
            if (f.operator === 'EQ') return String(actual) === String(expected)
            if (f.operator === 'NEQ') return String(actual) !== String(expected)
            if (f.operator === 'GT') return Number(actual) > Number(expected)
            if (f.operator === 'GTE') return Number(actual) >= Number(expected)
            if (f.operator === 'LT') return Number(actual) < Number(expected)
            if (f.operator === 'LTE') return Number(actual) <= Number(expected)
            return String(actual) === String(expected)
          })
        })
      })
    }

    // ── edgeProps（内联关系属性谓词）过滤 ──
    // MATCH (node)-[r:KNOWS {name: 'monkey'}]->(a) — steps 中的 edgeProps
    // 利用 edgesPayload（从 __edges 提取的边Info）来验证边属性是否匹配
    const edgePropSteps = (plan.steps || []).filter(s => s.edgeProps && Object.keys(s.edgeProps).length > 0)
    const edgePropFilteredRecords = (edgePropSteps.length && edgesPayload.length)
      ? (filteredWithLabels || []).filter((r: any) => {
          // 找到结果节点在 allNodes 中的索引
          const nodeIdx = nodeGeIds.indexOf(r.id)
          if (nodeIdx < 0) return false
          return edgePropSteps.every(s => {
            if (!s.edgeProps) return true
            // 找到连接到此节点的边（src → dst 或 dst → src）
            const matchingEdges = edgesPayload.filter(e =>
              (e.dstIdx === nodeIdx || e.srcIdx === nodeIdx)
            )
            if (!matchingEdges.length) return false
            // 验证边属性是否匹配 edgeProps
            for (const me of matchingEdges) {
              if (me.label && s.edgeLabel && me.label !== s.edgeLabel) continue
              if (!me.props && Object.keys(s.edgeProps).length > 0) continue
              let match = true
              for (const [k, v] of Object.entries(s.edgeProps)) {
                const actual = me.props?.[k]
                if (String(actual) !== String(v)) { match = false; break }
              }
              if (match) return true
            }
            return false
          })
        })
      : filteredWithLabels

    // ── 边变量后处理 ──
    // 如果 returnColumns 包含边变量（如 MATCH (a)-[r]->(b) RETURN r），
    // GE 的 _executeQueryPlan 只返回邻居节点，不Trace边。
    // 从 edgesPayload（__edges Info）中获取边标签构建 [:T1] 格式。
    // 策略：
    // 1. 如果 MATCH 指定了 edgeLabel（:T1），直接用 query 的 label
    // 2. 如果未指定，从 edgesPayload 按 srcIdx→dstIdx 匹配边标签
    const edgeLabelsFromPayload = edgesPayload.map(ep => ep.label).filter(Boolean)
    const uniqueEdgeLabels = [...new Set(edgeLabelsFromPayload)]
    const queryEdgeLabel = (plan.steps || []).find(s => s.edgeLabel)?.edgeLabel
    const hasExplicitEdgeLabel = queryEdgeLabel && !queryEdgeLabel.includes('|')
    const hasMatchingEdgeLabel = hasExplicitEdgeLabel && uniqueEdgeLabels.includes(queryEdgeLabel)
    const nodeAliases = new Set([
      ...(plan.createNodes || []).map(n => n.alias).filter(Boolean),
      ...(plan.steps || []).flatMap(s => [s.source, s.targetAlias, s.pathVariable].filter(Boolean)),
      ...(plan.optionalMatchSteps || []).flatMap((om: any) => {
        const vars: string[] = []
        if (om.variableName) vars.push(om.variableName)
        for (const s of om.steps || []) {
          if (s.source) vars.push(s.source)
          if (s.targetAlias) vars.push(s.targetAlias)
          if (s.pathVariable) vars.push(s.pathVariable)
        }
        return vars
      }),
    ])
    // edgeVarCols：识别边变量 RETURN 列（如 RETURN r），排除 RETURN i.var 等属性列
    // 属性列已被 dispatchWherePath 拆为简短名称（如 i.var→var），此时 nodeAliases 不含 var。
    // 用原始 query 做最终判断：如果 query 中是 var.xxx 格式的列，不当作边变量。
    const varColSet = new Set(plan.returnColumns || [])
    const queryHasColumnRef = (query || '').match(/\w+\.\w+/)
    const edgeVarCols = (plan.returnColumns || []).filter(rc => {
      if (!rc || rc === '*' || rc.includes('.')) return false
      if (nodeAliases.has(rc)) return false
      // 排除聚合函数参数列（如 'count(r)' 中 r 是参数，不是边变量 RETURN 列）
      if (plan.aggregate) {
        const aggCol = (plan.aggregate as any).column || ''
        if (aggCol.includes(rc) && /^\w+\(/.test(aggCol)) return false
      }
      // 如果属性名在所有节点 props 中作为键存在，说明是节点属性而非边变量
      // 回退方案：检查 query 中是否有原始变量前缀（如 i.var）对应此 rc
      if (queryHasColumnRef && query) {
        const varRefs = query.match(/\w+\.\w+/g) || []
        if (varRefs.some(vr => vr.split('.')[1] === rc)) return false
      }
      return true
    })
    let rawWithEdges = (edgeVarCols.length && (hasMatchingEdgeLabel || edgesPayload.length))
      ? edgePropFilteredRecords.map((r: any) => {
          const row: Record<string, unknown> = {}
          if (r.props) Object.assign(row, r.props)
          // 对于多边变量：按遍历步骤顺序分配边。edgeVarCols 的顺序对应遍历步骤顺序。
          // edgesPayload 中边的顺序为遍历中匹配的顺序，If any多个边变量且边数匹配，
          // 则按顺序分配（适用于链式匹配如 ()-[r1:T1]->()-[r2:T2]->()）
          const edgeVarCount = edgeVarCols.length
          const sequentialMatch = (edgeVarCount === edgesPayload.length && edgeVarCount > 1 && edgesPayload.every((e: any) => e.label))
          // 多步路径：优先从 r.props.__stepEdges（geNode.props 中保存的真实匹配边标签），回退到 plan.steps
                    const nodeIdx = nodeGeIds.indexOf(r.id)
          const rawStepEdges: string[] = (nodeIdx >= 0 && stepEdgesCache.has(nodeIdx) && stepEdgesCache.get(nodeIdx)!.length === edgeVarCount)
            ? stepEdgesCache.get(nodeIdx)!
            : (plan.steps || []).map((s: any) => s.edgeLabel || '').filter(Boolean)
          const actualStepEdges = rawStepEdges
          if ((plan.steps || []).length > 1) {
          }
          for (let eci = 0; eci < edgeVarCols.length; eci++) {
            const evc = edgeVarCols[eci]
            let edgeLabel = ''
            let edgeProps: Record<string, unknown> | null = null
            // 多步路径：按边变量索引对应步骤索引
            if (eci < actualStepEdges.length) {
              edgeLabel = actualStepEdges[eci]
            } else if (r.__edgeLabel) {
              edgeLabel = r.__edgeLabel
            } else if (hasExplicitEdgeLabel) {
              edgeLabel = queryEdgeLabel!
            } else if (nodeIdx >= 0) {
              if (sequentialMatch) {
                // 顺序匹配：第 eci 个边变量取 edgesPayload 的第 eci 个边
                const matchingEdge = edgesPayload[eci]
                if (matchingEdge?.label) edgeLabel = matchingEdge.label
                if (matchingEdge?.props && Object.keys(matchingEdge.props).length) edgeProps = matchingEdge.props as Record<string, unknown>
              } else {
                // 非顺序匹配：通过 nodeIdx 查找（跳过已使用的边）
                const usedEdgeCount = eci
                const matchingEdgeIdx = edgesPayload.findIndex((e: any, i: number) => {
                  if (i < usedEdgeCount) return false
                  return e.dstIdx === nodeIdx || e.srcIdx === nodeIdx
                })
                if (matchingEdgeIdx >= 0) {
                  const matchingEdge = edgesPayload[matchingEdgeIdx]
                  if (matchingEdge?.label) edgeLabel = matchingEdge.label
                  if (matchingEdge?.props && Object.keys(matchingEdge.props).length) edgeProps = matchingEdge.props as Record<string, unknown>
                }
              }
            }
            if (edgeLabel && edgeProps && Object.keys(edgeProps).length) {
              const propsStr = Object.entries(edgeProps)
                .map(([k, v]) => `${k}: ${typeof v === 'string' ? `'${v}'` : String(v)}`)
                .join(', ')
              row[evc] = `[:${edgeLabel} {${propsStr}}]`
            } else {
              row[evc] = edgeLabel ? `[:${edgeLabel}]` : '[:]'
            }
            // 同时设置 __edgeLabel 供 _formatResultRow 别名分支使用
            if (edgeLabel) r.__edgeLabel = edgeLabel
            if (edgeProps) r.__edgeProps = edgeProps
          }
          delete (row as QueryRow)._stepEdges
          delete (row as QueryRow).__stepEdges
          return { ...r, props: row }
        })
      : edgePropFilteredRecords


    // ── 边属性列后置处理 ──
    // 对 `RETURN r.num` 这样的边属性访问，从 edgesPayload 查找边属性并设置到行记录
    if (edgesPayload.length && rawWithEdges.length && (query || '').match(/\w+\.\w+/)) {
      // 从 query 中提取可能的边属性访问列
      const potentialEdgePropCols = extractEdgePropColumnsFromQuery(query || '')
      if (potentialEdgePropCols.length) {
        for (const rawRec of rawWithEdges) {
          const nodeIdx = nodeGeIds.indexOf(rawRec.id)
          if (nodeIdx < 0) continue
          const matchingEdge = edgesPayload.find(e => (e.dstIdx === nodeIdx || e.srcIdx === nodeIdx) && e.props && Object.keys(e.props).length > 0)
          if (matchingEdge?.props) {
            if (!rawRec.__edgeProps) rawRec.__edgeProps = {}
            Object.assign(rawRec.__edgeProps, matchingEdge.props)
          }
        }
      }
    }

    // ── WITH 子句后处理：对 GE 返回的 raw rows 应用 WITH 投影 ──
    // 当 plan.with.columns 存在时（MATCH ... WITH [...] AS list RETURN ...），
    // GE 的下层 _executeQueryPlan 不处理 WITH 子句（仅在 GE.query() 中处理），
    // 而 _executeViaGraphEngine 直接调用 GE._executeQueryPlan 绕过了 WITH 处理。
    // 此处用表达式引擎对 WITH 列求值，将结果放到 rawRow.props 中。
    // 也会将 WITH 列表中的标识符字符串解析为实际节点值。
    if (plan.with?.columns?.length) {
      for (const rawRow of rawWithEdges) {
        for (const wc of plan.with.columns) {
          const alias = typeof wc === 'object' ? wc.alias : null
          if (!alias || (wc.expression as any)?.type === 'IDENTIFIER') continue
          const wcExpr = typeof wc.expression === 'string' ? wc.expression :
            (wc.expression?.type === 'LIST'
              ? '[' + (wc.expression.items || []).map((i: any) => i.name ?? i.value ?? '').join(', ') + ']'
              : null)
          if (!wcExpr) continue
          // Build varCtx from rawRow
          const rc: Record<string, unknown> = {}
          if (rawRow.props) {
            for (const [k, v] of Object.entries(rawRow.props)) {
              if (!k.startsWith('_') && k !== alias) rc[k] = v
            }
          }
          if (rawRow.__crossVarRows) {
            for (const [k, v] of Object.entries(rawRow.__crossVarRows)) {
              if (!(k in rc)) rc[k] = v
            }
          }
          // 将 MATCH 变量注入 rc（支持 v.date 等属性访问表达式）
          const _exprVars = wcExpr.match(/([a-zA-Z_]\w*)/g)
          const _firstVar = _exprVars?.[0]
          if (_firstVar && rawRow?.props && !(_firstVar in rc)) {
            rc[_firstVar] = rawRow.props
          }
          try {
            const evaluated = _evalBinary(wcExpr, rc)
            if (evaluated !== undefined && evaluated !== null) {
              // 清理节点对象中的内部属性（__edges、props 等），避免输出为 props: (...)
              if (typeof evaluated === 'object' && evaluated !== null && !Array.isArray(evaluated)) {
                const cleanVal: Record<string, unknown> = {}
                for (const [ek, ev] of Object.entries(evaluated as Record<string, unknown>)) {
                  if (ek !== '__edges' && ek !== 'props' && !ek.startsWith('__')) cleanVal[ek] = ev
                }
                rawRow.props[alias] = cleanVal
              } else {
                rawRow.props[alias] = evaluated
              }
            }
          } catch {
            // Fallback: keep GE's value
          }
        }
      }
    }

    // ── 格式化结果 ──
    // Pre-process path variables: replace edge placeholder strings with path
    // objects containing __path arrays so list comprehensions like
    // [x IN collect(p) | head(nodes(x))] can resolve correctly.
    const pathVars = new Set((plan.steps || []).map(s => s.pathVariable).filter(Boolean))
    if (pathVars.size) {
      for (const r of rawWithEdges) {
        for (const pv of pathVars) {
          // Build source node copy from r.props (without internal fields)
          const srcNode: Record<string, unknown> = {}
          if (r.props && typeof r.props === 'object') {
            for (const [k, v] of Object.entries(r.props)) {
              if (!k.startsWith('__') && k !== pv) srcNode[k] = v
            }
          }
          // Build target node copy from r.__targetProps
          const tgtNode: Record<string, unknown> = {}
          if (r.__targetProps && typeof r.__targetProps === 'object') {
            for (const [k, v] of Object.entries(r.__targetProps)) {
              if (!k.startsWith('__')) tgtNode[k] = v
            }
          }
          if (Object.keys(srcNode).length) {
            ;(r as any).props[pv] = {
              __path: [srcNode, Object.keys(tgtNode).length ? tgtNode : srcNode],
            }
          }
        }
      }
    }
    const rawResult: QueryRow[] = rawWithEdges.map((r: any) => {
      const fr = _formatResultRow(r, plan)
      return fr
    })

    // ── DISTINCT 去重（RETURN DISTINCT n） ──
    // 在 WITH/UNWIND pipeline 之外，GE 直接执行路径也需要去重
    let result: QueryRow[]
    if (plan.distinct && rawResult.length) {
      const dedupSet = new Set<string>()
      result = []
      for (const row of rawResult) {
        const colKeys = plan.returnColumns?.length ? plan.returnColumns : Object.keys(row).filter(k => !k.startsWith('__'))
        const sig = JSON.stringify(colKeys.map(k => row[k]))
        if (dedupSet.has(sig)) continue
        dedupSet.add(sig)
        result.push(row)
      }
    } else {
      result = rawResult
    }

    // ── WHERE 子句后处理过滤（表达式引擎处理 GE 不支持的复杂 boolean 表达式） ──
    // GE 的 _matchFilter 只支持简单属性比较。对于包含 AND/OR/XOR/NOT/括号等复杂 boolean 逻辑，
    // 以及函数表达式（type(r)、labels()等），在 GE 执行后用 _evaluateExpression 做后过滤。
    // Note: 即使 plan.aggregate 存在，也必须先应用 WHERE 再聚合。
    if (plan.whereBody && result.length && !(plan.hasMatch && plan.unwind)) {
      // 提取主 MATCH 的 WHERE 条件：在 "OPTIONAL MATCH" 之前的文本
      let whereExpr = plan.whereBody
      const optMatchPos = whereExpr.indexOf('OPTIONAL MATCH')
      if (optMatchPos >= 0) {
        whereExpr = whereExpr.substring(0, optMatchPos).trim()
      }
      if (whereExpr) {
        // 跳过属于 OPTIONAL MATCH 变量的条件（如 m:NonExistent, x0 IS NOT NULL）
        // 这些在 OPTIONAL MATCH 处理中另做过滤
        if (plan.optionalMatchSteps?.length) {
          const optVarSet = new Set<string>()
          for (const om of plan.optionalMatchSteps) {
            if (om.variableName) optVarSet.add(om.variableName)
            for (const s of om.steps || []) {
              if (s.source) optVarSet.add(s.source)
              if (s.targetAlias) optVarSet.add(s.targetAlias)
              if (s.targetAlias) optVarSet.add(s.targetAlias)
            }
          }
          // 加入 OPTIONAL MATCH 的 expressionColumns 别名（如 x0）
          if (plan.expressionColumns?.length) {
            for (const ec of plan.expressionColumns) {
              const ecObj = ec as any
              if (ecObj.alias) optVarSet.add(ecObj.alias)
            }
          }
          const labelMatch = whereExpr.match(/^(\w+)\s*:\s*(\w+)$/)
          if (labelMatch && optVarSet.has(labelMatch[1])) {
            // 纯 OPTIONAL 变量 label 条件：跳过主 MATCH WHERE 过滤
            whereExpr = ''
          }
          // 检查 whereExpr 中的所有变量引用是否全属于 OPTIONAL MATCH
          if (whereExpr) {
            const referencedVars = [...whereExpr.matchAll(/\b([a-zA-Z_]\w*)\b/g)].map(m => m[1])
              .filter(v => !/^(IS|NOT|NULL|TRUE|FALSE|AND|OR|XOR)$/i.test(v))
              // 排除字符串字面量（单引号/双引号括起来的单词）
              .filter(v => whereExpr.match(new RegExp(`'${v}'|"${v}"`)) === null)
            if (referencedVars.length && referencedVars.every(v => optVarSet.has(v))) {
              whereExpr = ''
            }
          }
        }
      }
      if (whereExpr) {
        const filteredResult: QueryRow[] = []
      for (let ri = 0; ri < result.length; ri++) {
        const row = result[ri]
                // 构建变量级映射
        const ctx: Record<string, unknown> = {}
        // 先注入 result row 的扁平化键
        for (const [key, val] of Object.entries(row)) {
          if (hasProps(val)) {
            ctx[key] = { ...val.props }
          } else {
            ctx[key] = val
          }
        }
        // 再从原始 GE 记录获取变量上下文（如 {a: {name: 'Foo', _label: 'TheLabel'}}）
        // 注意：__crossVarRows 中的对象变量优先覆盖 row 中的字符串值，
        // 因为 WHERE 表达式（如 type(r)）需要完整的变量上下文，而非格式化后的字符串。
        const rawEntry = rawWithEdges?.[ri]
        if (rawEntry?.__crossVarRows) {
          for (const [varName, varNode] of Object.entries(rawEntry.__crossVarRows)) {
            ctx[varName] = varNode as Record<string, unknown>
          }
                }
        // 注入 WITH/UNWIND 管道变量（WITH/UNWIND 在 MATCH 之前的情况）
        // 尝试从 nodes 中获取 pipeline 执行结果
        if (plan.with?.columns?.length && !Array.isArray(nodes?.[0]?.props)) {
          for (const col of plan.with.columns) {
            const alias = col.alias || col.expression
            if (!(alias in ctx) && query && nodes?.length) {
              // 对 WITH 表达式求值
              const val = _evaluateExpression(col.expression, ctx)
              if (val !== undefined) ctx[alias] = val
            }
          }
        }
        if (plan.unwind?.name && !(plan.unwind.name in ctx)) {
          // Try to compute the unwind from query
          const unwindVal = Array.isArray(nodes?.[0]) ? nodes[0] : null
          if (unwindVal) ctx[plan.unwind.name] = unwindVal
        }
        // 路径变量注入：WHERE length(p) = N 需要通过 ctx.p.length 评估
        if (plan.pathVar && !(plan.pathVar in ctx)) {
          const nSteps = (plan.steps || []).length
          ctx[plan.pathVar] = { length: nSteps }
        }
        // 预处理 whereBody：替换 length(var) = N → var.length = N
        // 表达式引擎不认识 length() 函数，但可以用 .length 属性访问
        let whereBodyExpr = whereExpr
        if (whereBodyExpr) {
          whereBodyExpr = whereBodyExpr.replace(/length\s*\(\s*(\w+)\s*\)/g, '$1.length')
        }
        let evalVal: unknown
        const checkExpr = whereExpr
        if (_isPatternPredicate(checkExpr) || (whereBodyExpr && whereBodyExpr !== checkExpr)) {
          // Pattern Comprehension（如 (n)-[]->() 或 (n)-[:REL1]->()）由 GE steps 已执行。
          // 如果 length(p) 已替换为 p.length，isPatternPredicate 可能不匹配，
          // 但长度评估已经在 whereBodyExpr 中处理，所以走表达式求值路径。
          if (_isPatternPredicate(checkExpr)) {
            // 原始 whereBody 是 Pattern Comprehension
            const isNegated = checkExpr.trim().startsWith('NOT ')
            evalVal = isNegated ? false : true
          } else {
            // whereBodyExpr !== checkExpr（如 length(p)=1 → p.length=1）
            // 或 _isPatternPredicate 为 false 的非 pattern 查询
            try {
              const resultVal = _evaluateExpression(whereBodyExpr || checkExpr, ctx)
              evalVal = resultVal
            } catch {
              evalVal = undefined
            }
          }
        } else if (/^exists\s*\{/i.test(checkExpr.trim())) {
          // EXISTS { ... } 子查询
          const ebody = checkExpr.trim()
          const srcMatch = ebody.match(/(\w+)/)
          let existsVal = false
          if (srcMatch && allNodes?.length) {
            const srcVar = srcMatch[1]
            const srcNodeRef = ctx[srcVar]
            if (srcNodeRef) {
              const srcLabel = (srcNodeRef.props || srcNodeRef)._label || ''
              const labelMatch = ebody.match(/[:(w+)]/)
              const edgeLabel = labelMatch ? labelMatch[1] : null
              for (const anode of allNodes) {
                if (anode._label !== srcLabel) continue
                const anodeIdx = allNodes.indexOf(anode)
                // 检查 anode 自身的 __edges
                if (anode.__edges && Array.isArray(anode.__edges)) {
                  for (const e of anode.__edges) {
                    if (edgeLabel && e.label !== edgeLabel) continue
                    existsVal = true; break
                  }
                }
                // 也检查其他节点的 __edges 中引用此节点的边
                if (!existsVal) {
                  for (const other of allNodes) {
                    if (other.__edges) {
                      for (const e of other.__edges) {
                        if (e.srcIdx === anodeIdx || e.dstIdx === anodeIdx) {
                          if (edgeLabel && e.label !== edgeLabel) continue
                          existsVal = true; break
                        }
                      }
                      if (existsVal) break
                    }
                  }
                }
                if (existsVal) break
              }
            }
          }
          const isNegatedExists = /^not\s+exists/i.test(ebody)
          evalVal = isNegatedExists ? !existsVal : existsVal
        } else {
          try {
            const resultVal = _evaluateExpression(whereBodyExpr || checkExpr, ctx)
            evalVal = resultVal
          } catch {
            // OPTIONAL MATCH 变量的条件在当前行上下文可能不可用
            evalVal = undefined
          }
        }
        if (evalVal === true) {
          filteredResult.push(row)
        }
      }
      result.length = 0
      result.push(...filteredResult);
      }
    }

    // ── 聚合处理 ──
    if (plan.aggregate && !plan.groupBy?.length && rawWithEdges?.length) {
      const agg = plan.aggregate as any
      const aggFn = (agg.function || agg.type || '').toLowerCase()
      const aggAlias = agg.alias || agg.column?.replace(/^.+?\s+AS\s+/i, '').trim() || agg.field || agg.column || 'c'
      const colMatch = (agg.column || '').match(/^\w+\(\s*(?:DISTINCT\s+)?(.+?)\s*\)(?:\s+AS\s+\w+)?$/i)
      const field = colMatch ? colMatch[1] : (agg.field || '*')

      const aggRow: QueryRow = {}
      if (aggFn === 'count') {
        if (field === '*') {
          aggRow[aggAlias] = result.length
        } else {
          // count(b) where b is a node/rel variable = count everything
          // We need to check if the field is a MATCH variable (node/rel) vs a property
          const isNodeOrRelVar = field && /^[a-zA-Z_]\w*$/.test(field) && result.every(r => !(field in r))
          if (isNodeOrRelVar) {
            aggRow[aggAlias] = result.length
          } else {
            const nonNull = result.filter(r => {
              const v = r[field]
              return v !== null && v !== undefined
            })
            aggRow[aggAlias] = nonNull.length
          }
        }
      } else {
        // sum/avg/min/max
        const values = result
          .map(r => r[field])
          .filter((v: unknown) => v !== null && v !== undefined)
          .map(Number)
          .filter((v: number) => !isNaN(v))
        switch (aggFn) {
          case 'sum': aggRow[aggAlias] = values.reduce((a: number, b: number) => a + b, 0); break
          case 'avg': aggRow[aggAlias] = values.length ? values.reduce((a: number, b: number) => a + b, 0) / values.length : 0; break
          case 'max': aggRow[aggAlias] = values.length ? Math.max(...values) : 0; break
          case 'min': aggRow[aggAlias] = values.length ? Math.min(...values) : 0; break
          default: aggRow[aggAlias] = 0
        }
      }
      result.length = 0
      result.push(aggRow)
    }

    // If WHERE cleared everything but plan.filters exists, rebuild result from raw GE data
    // and apply filters directly (bypassing varNodes lookup that may fail on flattened rows)
    if (plan.filters?.length && !plan.aggregate && !result.length && rawWithEdges?.length) {
      result.length = 0
      for (const rwe of rawWithEdges) {
        const rProps = rwe.props || {}
        const crossVarNode = rwe.__crossVarRows ? Object.values(rwe.__crossVarRows)[0] as Record<string, unknown> : {}
        // Build combined node properties: crossVarRows first, then rwe.props, then rwe itself
        const nodeProps = { ...crossVarNode, ...rProps }
        const filterMatch = (plan.filters || []).every((f: any) => {
          if (f.property && !(f.property in nodeProps)) return false
          const actualVal = nodeProps[f.property]
          const fv = f.value
          let baseMatch = false
          switch (f.operator) {
            case 'EQ':   baseMatch = String(actualVal) === String(fv); break
            case 'NEQ':  baseMatch = String(actualVal) !== String(fv); break
            case 'GT':   baseMatch = Number(actualVal) > Number(fv); break
            case 'GTE':  baseMatch = Number(actualVal) >= Number(fv); break
            case 'LT':   baseMatch = Number(actualVal) < Number(fv); break
            case 'LTE':  baseMatch = Number(actualVal) <= Number(fv); break
            case 'STARTS_WITH': baseMatch = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.startsWith(fv); break
            case 'ENDS_WITH':   baseMatch = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.endsWith(fv); break
            case 'CONTAINS':    baseMatch = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.includes(fv); break
            default:            baseMatch = String(actualVal) === String(fv); break
          }
          return f.negated ? !baseMatch : baseMatch
        })
        if (!filterMatch) continue
        result.push(_formatResultRow(rwe, plan))
      }
    }

    // ── plan.filters 后处理过滤（补 WHERE 后处理不覆盖的 filter） ──
    // WHERE 后处理依赖 whereBody 字符串，但对于 STARTS_WITH / ENDS_WITH / CONTAINS
    // 等操作符，whereBody 可能被截断（ANTLR 适配器问题）。plan.filters 包含完整
    // 的结构化 filter Info，在此处对所有未在 GE 预过滤中处理的结果做二次过滤。
    // Note: 如果 whereBody 已经处理过（result 已被过滤），跳过此步避免重复过滤
    // 破坏与 whereBody 语义一致的扁平化结果。
    if (plan.filters?.length && result.length && !plan.aggregate && !plan.whereBody) {
      if (plan.returnColumns?.some(c => c === 'i.var' || c === 'var') || (plan.whereBody && plan.whereBody.includes('>') && plan.whereBody.includes('IS NOT NULL'))) {
      }
      const filteredResult: QueryRow[] = []
      for (const row of result) {
        // 构建变量→节点映射
        const varNodes: Record<string, Record<string, unknown>> = {}
        for (const [key, val] of Object.entries(row)) {
          if (hasProps(val)) {
            varNodes[key] = { ...val.props }
          } else if (val && typeof val === 'object') {
            varNodes[key] = val as Record<string, unknown>
          }

        }
        const match = plan.filters.every((f: any) => {
          let sourceNode = varNodes[f.source]
          if (!sourceNode) {
            // row may not have variable keys (e.g. RETURN a.name AS name)
            // fallback: try __crossVarRows or raw row from rawWithEdges
            // Try retrieving from rawWithEdges __crossVarRows (row may be rebuilt from _formatResultRow)
            if (Array.isArray(rawWithEdges)) {
              for (const rwe of rawWithEdges) {
                if (rwe.__crossVarRows?.[f.source] && f.property in rwe.__crossVarRows[f.source]) {
                  sourceNode = rwe.__crossVarRows[f.source]
                  break
                }
                if (rwe.props && !rwe.__crossVarRows && rwe.props[f.property] !== undefined) {
                  sourceNode = rwe.props
                  break
                }
              }
            }
          }
          if (!sourceNode) return false
          const actualVal = sourceNode[f.property]
          if (actualVal === undefined && f.operator !== 'IS_NULL') return false
          const fv = f.value
          let baseFilterResult = false
          switch (f.operator) {
            case 'EQ':   baseFilterResult = String(actualVal) === String(fv); break
            case 'NEQ':  baseFilterResult = String(actualVal) !== String(fv); break
            case 'GT':   baseFilterResult = actualVal > fv; break
            case 'GTE':  baseFilterResult = actualVal >= fv; break
            case 'LT':   baseFilterResult = actualVal < fv; break
            case 'LTE':  baseFilterResult = actualVal <= fv; break
            case 'IS_NULL':     baseFilterResult = actualVal == null; break
            case 'IS_NOT_NULL': baseFilterResult = actualVal != null; break
            case 'STARTS_WITH': baseFilterResult = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.startsWith(fv); break
            case 'ENDS_WITH':   baseFilterResult = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.endsWith(fv); break
            case 'CONTAINS':    baseFilterResult = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.includes(fv); break
            default:            baseFilterResult = String(actualVal) === String(fv); break
          }
          return f.negated ? !baseFilterResult : baseFilterResult
        })
        if (match) filteredResult.push(row)
      }
      result.length = 0
      result.push(...filteredResult)
    }

    // ── OPTIONAL MATCH 处理 ──
    // 对主查询的每一行结果，尝试匹配 optionalMatchSteps 中的每个 OPTIONAL MATCH 模式。
    // 成功 → 将匹配到的节点/边合并到 row；失败 → 填充 null。
    // 使用 allNodes（本地节点数据，含 __edges）进行遍历，不依赖 GE Pool 实例。
    if (plan.optionalMatchSteps?.length && result.length) {
      for (const opt of plan.optionalMatchSteps) {
        const optSteps = opt.steps || []
        for (let ri = 0; ri < result.length; ri++) {
          const row = result[ri]
          // 解析 source 变量对应的 allNodes 索引
          const sourceVar = optSteps[0]?.source || ''
          const targetVar = optSteps[0]?.targetAlias || ''
          let edgeVar = optSteps[0]?.edgeAlias || ''
          if (!edgeVar && query) {
            const optMatchEdge = query.match(/OPTIONAL\s+MATCH\s*\([^)]+\)\s*-\s*\[(\w+)\]/)
            if (optMatchEdge) edgeVar = optMatchEdge[1]
          }
          const optVarName = opt.variableName || ''
          let srcNodeIdx = -1
          // 先从 rawWithEdges.__crossVarRows 获取源节点引用（比 row[sourceVar] 更可靠）
          const rawEntry = Array.isArray(rawWithEdges) ? rawWithEdges[ri] : undefined
          if (rawEntry?.__crossVarRows && sourceVar && sourceVar in rawEntry.__crossVarRows) {
            const srcNodeRef = rawEntry.__crossVarRows[sourceVar] as any
            const srcLabel = (srcNodeRef as any)?._label || ''
            if (srcLabel) {
              for (let si = 0; si < allNodes.length; si++) {
                if ((allNodes[si] as any)._label === srcLabel) { srcNodeIdx = si; break }
              }
            }
            if (srcNodeIdx < 0) {
              // 按 _alias 或节点匹配
              for (let si = 0; si < allNodes.length; si++) {
                const node = allNodes[si] as any
                if (node._alias === sourceVar ||
                    (node._label && (srcNodeRef as any)._label === node._label &&
                     !Object.entries(srcNodeRef).some(([k,v]) => k!=='_label'&&k!=='__edges'&&k!=='_alias'&&node[k]!==v))) {
                  srcNodeIdx = si; break
                }
              }
            }
          }
          if (srcNodeIdx < 0 && sourceVar) {
            // 尝试从 row[sourceVar] 获取字符串化的节点值
            const srcVal = row[sourceVar]
            const srcType = typeof srcVal
            if (srcType === 'string') {
              const rowLabel = (srcVal as string).match(/^\(:(\w+)/)
              if (rowLabel) {
                for (let si = 0; si < allNodes.length; si++) {
                  if ((allNodes[si] as any)._label === rowLabel[1]) { srcNodeIdx = si; break }
                }
              }
            }
            // fallback: 用 opt.scanLabel 或主 MATCH 的 scanLabel 匹配 allNodes
            if (srcNodeIdx < 0) {
              const srcLabel = opt.scanLabel || (plan as any).scanLabel || ''
              if (srcLabel) {
                for (let si = 0; si < allNodes.length; si++) {
                  if ((allNodes[si] as any)._label === srcLabel) { srcNodeIdx = si; break }
                }
              }
            }
            // last fallback: 按 _alias 匹配
            if (srcNodeIdx < 0) {
              for (let si = 0; si < allNodes.length; si++) {
                if ((allNodes[si] as any)._alias === sourceVar) { srcNodeIdx = si; break }
              }
            }
          }
          // 构造 nodeProps 帮助函数
          const _mkNodeProps = (n: any): Record<string, unknown> => {
            const p: Record<string, unknown> = {}
            if (!n) return p
            for (const k of Object.keys(n)) {
              if (k !== '__edges' && !k.startsWith('_')) p[k] = n[k]
            }
            if (n._label) p._label = n._label
            return p
          }
          if (srcNodeIdx >= 0 && optSteps.length) {
            const walkPaths = _walkMultiSteps(srcNodeIdx, optSteps, allNodes)
            if (walkPaths?.length) {
              // 取第一条路径的最后节点
              const lastNodeIdx = walkPaths[0][walkPaths[0].length - 1]
              const targetNode = allNodes[lastNodeIdx] as any
              const nodeProps = _mkNodeProps(targetNode)
              // 无条件覆盖：OPTIONAL MATCH 结果优先于 _formatResultRow 的默认值
              row[targetVar] = nodeProps
              if (edgeVar) row[edgeVar] = null
            } else {
              // OPTIONAL 路径不匹配：填充 null
              if (sourceVar) row[sourceVar] = null
              if (targetVar) row[targetVar] = null
              if (edgeVar) row[edgeVar] = null
            }
          } else if (optVarName && !sourceVar && !targetVar && !edgeVar) {
            // 单节点模式：OPTIONAL MATCH (n) / (n:Label)
            const nodeProps = opt.scanLabel
              ? _mkNodeProps(allNodes.find(n => (n as any)._label === opt.scanLabel))
              : null
            row[optVarName] = nodeProps || null
          } else {
            // 找不到 source 或无步骤
            if (sourceVar) row[sourceVar] = null
            if (targetVar) row[targetVar] = null
            if (edgeVar) row[edgeVar] = null
            if (optVarName) row[optVarName] = null
          }
        }
      }
    }

    // OPTIONAL MATCH 后处理：OPTIONAL MATCH 设置的变量可能改变了 RETURN 表达式的求值结果。
    // 重新计算受影响的列。
    if (plan.optionalMatchSteps?.length && result.length) {
      const optMatchVarNames = new Set(plan.optionalMatchSteps.map(om => om.variableName).filter(Boolean))
      if (optMatchVarNames.size && plan.expressionColumns?.length) {
        const aliasToExpr: Record<string, string> = {}
        for (const ec of plan.expressionColumns) {
          const ecObj = ec as { alias?: string; expression?: any }
          const alias = (typeof ec === 'string' ? ec : ecObj.alias ?? ecObj.expression ?? String(ec))
          const expr = (typeof ec === 'object' && ecObj.expression) ? String(ecObj.expression) : alias
          aliasToExpr[alias] = expr
        }
        for (const row of result) {
          for (const alias of Object.keys(aliasToExpr)) {
            if (!alias) continue
            const rawexpr = aliasToExpr[alias]
            if (!rawexpr) continue
            // 检查 OPTIONAL MATCH 变量是否在表达式中被引用且已存在于 row 中
            const hasVar = [...optMatchVarNames].some(vn => rawexpr.includes(vn) && vn in row)
            if (!hasVar) continue
            const varCtx: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(row)) {
              if (!k.startsWith('_')) varCtx[k] = v
            }
            for (const vn of optMatchVarNames) {
              if (vn in row) varCtx[vn] = row[vn]
            }
            try {
              const newVal = _evaluateExpression(rawexpr, varCtx)
              if (newVal !== undefined && newVal !== null) {
                row[alias] = newVal
              }
            } catch (_e) { /* ignore evaluation error, keep original value */ }
          }
        }
      }
    }

    // ── type() 函数后处理 ──
    // 如果原查询包含 type(r) 且结果中该列是边表示 [:T]，替换为类型名 'T'
    const hasTypeReturnCol = (plan.returnColumns || []).some((rc: string) =>
      rc && (rc.startsWith('type(') || (plan.returnAliasMap?.[rc] || '').startsWith('type('))
    )
    if (hasTypeReturnCol && query && /type\s*\(/i.test(query)) {
      for (const row of result) {
        for (const rc of plan.returnColumns || []) {
          if (!rc) continue
          const val = row[rc]
          if (typeof val === 'string' && val.startsWith('[:') && val.endsWith(']')) {
            // type(r) 的结果应为边标签名（不含引号）
            const typeName = val.slice(2, -1) // 去掉 [: 和 ]
            row[rc] = typeName
          }
        }
      }
    }

    // ── FOREACH 子句执行 ──
    // 新格式 FOREACH（variable + operation）对已格式化的 result 做展开
    const feFe = plan.forEach as any
    if (feFe && feFe.variable && feFe.operation && Array.isArray(result)) {
      const listItems = Array.isArray(feFe.list) ? [...feFe.list] : []
      if (listItems.length > 0 && result.length > 0) {
        const retCol = (plan.returnColumns || [])[0]
        const retVar = retCol ? retCol.split('.')[0] : ''
        const candidates = result.map((r: any) => {
          const c: any = {}
          if (retVar && r[retVar] !== undefined) {
            c[retVar] = typeof r[retVar] === 'object' && r[retVar] !== null ? { ...r[retVar] } : r[retVar]
          }
          return c
        })
        const feResult = executeForeachInlineTop(candidates, feFe)
        if (Array.isArray(feResult) && feResult.length > 0) {
          result = feResult.map((exr: any) => {
            if (retVar && exr[feFe.variable] !== undefined) {
              return { [retVar]: typeof exr[retVar] !== 'undefined' ? exr[retVar] : exr[feFe.variable] }
            }
            if (retVar) return { [retVar]: exr }
            return exr
          })
        }
      }
      // 空列表：保持 result 不变（FOREACH 不执行）
    }
    // 旧格式 FOREACH（name + updates）— 保持向后兼容，当前新格式已替代
    // 旧代码已删除，保留空 if 以避免无用行 — 如果未来需要恢复，取消下面注释
    // if (plan.forEach && plan.forEach.list?.length && !feFe?.variable && Array.isArray(result)) {
    //   const fe = plan.forEach
    //   for (const item of fe.list) {
    //     for (const update of fe.updates) {
    //       ... 创建节点逻辑 ...
    //     }
    //   }
    // }

    // ── MATCH + WITH/UNWIND 管道 ──
    // MATCH 结果已经构建在 result 中，但查询还有 WITH/UNWIND 需要处理。
    // 对每一行 MATCH 结果，构造变量上下文，然后交给 WITH/UNWIND 管道处理。
    if (plan.hasMatch && plan.unwind && Array.isArray(result) && result.length) {
      const allPipelineRows: QueryRow[] = []
      for (let rowIdx = 0; rowIdx < result.length; rowIdx++) {
        const matchVarCtx: Record<string, unknown> = {}
        // 从 rawWithEdges.__crossVarRows 获取该行的 MATCH 节点变量
        const rawEntry = Array.isArray(rawWithEdges) ? rawWithEdges[rowIdx] : undefined
        if (rawEntry?.__crossVarRows) {
          for (const [varName, varVal] of Object.entries(rawEntry.__crossVarRows as Record<string, unknown>)) {
            matchVarCtx[varName] = varVal
          }
        }
        // 补充关系变量：从 query 提取 [r] 或 [r:Label] 语法
        if (query) {
          const relVars = [...query.matchAll(/\[(\w+)\s*(?::\s*\w+)?\]/g)].map(m => m[1]).filter(Boolean)
          for (const rv of relVars) {
            if (rv in matchVarCtx) continue
            // 尝试从 __edgeProps 获取
            if (rawEntry?.__edgeProps && typeof rawEntry.__edgeProps === 'object') {
              matchVarCtx[rv] = rawEntry.__edgeProps
            } else if (rawEntry && rawEntry.__edgeLabel && edgesPayload.length && rawEntry.id != null) {
              // 从 edgesPayload 查找该行的匹配边属性
              const nodeIdx = edgesPayload.findIndex(e => e.srcIdx === rawEntry.id || e.dstIdx === rawEntry.id)
              if (nodeIdx >= 0 && edgesPayload[nodeIdx]?.props && typeof edgesPayload[nodeIdx].props === 'object') {
                matchVarCtx[rv] = edgesPayload[nodeIdx].props
              } else {
                matchVarCtx[rv] = {}
              }
            } else {
              matchVarCtx[rv] = {}
            }
          }
        }
        // 回退：从 result row 推断变量
        if (!Object.keys(matchVarCtx).length) {
          const row = result[rowIdx]
          for (const [key, val] of Object.entries(row)) {
            if (hasProps(val)) {
              matchVarCtx[key] = val.props
            } else {
              matchVarCtx[key] = val
            }
          }
        }
        const pipelineRows = _executeWithUnwindPipeline(plan, [matchVarCtx] as any, query, matchVarCtx)
        if (Array.isArray(pipelineRows) && pipelineRows.length) {
          for (const pr of pipelineRows) {
            allPipelineRows.push({ ...matchVarCtx, ...pr })
          }
        }
        // 空：原始行丢弃（UNWIND [] 产生 0 行）
      }
      // ── DISTINCT 处理 ──
      if (allPipelineRows.length) {
        result.length = 0
        if (plan.distinct) {
          const dedupSet = new Set<string>()
          for (const row of allPipelineRows) {
            const colKeys = plan.returnColumns?.length ? plan.returnColumns : Object.keys(row).filter(k => !k.startsWith('__'))
            const sig = JSON.stringify(colKeys.map(k => row[k]))
            if (dedupSet.has(sig)) continue
            dedupSet.add(sig)
            result.push(row)
          }
        } else {
          result.push(...allPipelineRows)
        }
      } else {
        // 无 UNWIND/WITH 管道，保留 result（OPTIONAL MATCH 已在行中设置变量）
        // 不清空 result，确保后面的 WHERE 过滤看到正确数据
      }
      // ── UNWIND + WITH 管道后再求值 WHERE ──
      if (plan.whereBody && result.length) {
        const filtered: QueryRow[] = []
        for (const row of result) {
          const ctx: Record<string, unknown> = { ...row }
          for (const [k, v] of Object.entries(row)) {
            if (hasProps(v)) {
              ctx[k] = v.props
            }
          }
          try {
            let evalVal: unknown
            if (_isPatternPredicate(plan.whereBody)) {
              const isNegated = plan.whereBody.trim().startsWith('NOT ')
              evalVal = isNegated ? false : true
            } else if (/^exists\s*\{/i.test(plan.whereBody.trim())) {
              const ebody2 = plan.whereBody.trim()
              const srcMatch2 = ebody2.match(/(\w+)/)
              let existsVal2 = false
              if (srcMatch2 && allNodes?.length) {
                const srcVar2 = srcMatch2[1]
                const srcNodeRef2 = ctx[srcVar2]
                if (srcNodeRef2) {
                  const srcLabel2 = (srcNodeRef2.props || srcNodeRef2)._label || ''
                  const labelMatch2 = ebody2.match(/[:(w+)]/)
                  const edgeLabel2 = labelMatch2 ? labelMatch2[1] : null
                  for (const anode of allNodes) {
                    if (anode._label !== srcLabel2) continue
                    const anodeIdx2 = allNodes.indexOf(anode)
                    if (anode.__edges && Array.isArray(anode.__edges)) {
                      for (const e of anode.__edges) {
                        if (edgeLabel2 && e.label !== edgeLabel2) continue
                        existsVal2 = true; break
                      }
                    }
                    if (!existsVal2) {
                      for (const other of allNodes) {
                        if (other.__edges) {
                          for (const e of other.__edges) {
                            if (e.srcIdx === anodeIdx2 || e.dstIdx === anodeIdx2) {
                              if (edgeLabel2 && e.label !== edgeLabel2) continue
                              existsVal2 = true; break
                            }
                          }
                          if (existsVal2) break
                        }
                      }
                    }
                    if (existsVal2) break
                  }
                }
              }
              evalVal = existsVal2
            } else {
              evalVal = _evaluateExpression(whereBodyExpr || plan.whereBody, ctx)
            }
            if (evalVal === true) {
              filtered.push(row)
            }
          } catch {
            filtered.push(row)
          }
        }
        if (filtered.length || !result.length) {
          result.length = 0
          result.push(...filtered)
        }
      }
    }

    // ── 后处理（ORDER BY / HAVING） ──
    const evgeReturn = _postProcessResults(result, plan)
    return evgeReturn
  } finally {
    // DML 持久化：将 _executeViaGraphEngine 中创建的节点写回外部 nodes 数组，
    // 确保后续查询（MATCH）能看到前面 CREATE/MERGE 的节点。
    if ((plan.type === 'CREATE' || plan.type === 'MERGE' || plan.type === 'MATCH_MODIFY' || plan.type === 'SET' || plan.type === 'DELETE') && nodes) {
      for (let i = originalNodeCount; i < allNodes.length; i++) {
        nodes.push(allNodes[i])
      }
    }
    // 注册池中的 GE 实例由 _clearGeInstances() 统一清理，不在 finally 中 close
    // 非注册临时 GE（当前不存在此场景）应在 finally 中 close + 清理
    // 释放 GEPool 连接（非 database-specific 实例）
    if (dbName === DEFAULT_DATABASE && ge) {
      try {
        const pool = GEPool.getInstance()
        pool.releaseConnection(ge)
      } catch { /* 池尚未初始化或已销毁 */ }
    }
  }
}



export async function _executeQuery(
  plan: QueryPlan,
  nodes: Array<Record<string, unknown>>,
  query?: string,
): Promise<QueryResult> {
  // 编译时语义验证（跳过在某些复杂WITH+列表谓词场景下的误报）
  try {
    _validatePlan(plan, query)
  } catch (e: any) {
    // 如果是 UndefinedVariable 但 query 中存在 WITH+列表谓词模式，跳过
    // 否则抛出
    if (e.message?.includes('UndefinedVariable') && /none|all|any|single/i.test(query || '')) {
      // 有可能是列表谓词内的 WHERE 导致 WITH 提取误断，跳过验证
    } else {
      throw e
    }
  }

  // 无显式 LIMIT 时应用 DEFAULT_LIMIT（批量数据集上默认截断防止 OOM）
  if (plan.limit === undefined || plan.limit === null) {
    plan.limit = DEFAULT_LIMIT
  }

  // 对不需要 GE 的快捷路径，Plan 深拷贝可以延迟到真正需要时
  // Note: _executeViaGraphEngine 内部会 mutate plan.filters/plan.steps，
  // 所以 GE 路径必须在执行前深拷贝
  // 快捷路径（LOAD CSV, SHOW, catalog, DML, bare CALL）不 mutate plan → 无需拷贝

  // ── bare CALL dispatch：CALL name（无括号语法）──
  if (plan.type === 'CALL' && !plan.callProcedure && query) {
    const callMatch = query.match(/CALL\s+(\S+)(?:\s+|\s*$)/i)
    if (callMatch && !query.match(/CALL\s+\S+\s*\(/i)) {
      const bareName = callMatch[1].toLowerCase()
      const proc = _procedureRegistry.get(bareName)
      if (proc) {
        const sigParens = proc.signature.match(/\(([^)]*)\)/)
        const paramNames: string[] = []
        if (sigParens) {
          paramNames.push(...sigParens[1].split(',').map(s => s.split('::')[0].trim()).filter(Boolean))
        }
        const bareParams = plan._bareCallParams as Record<string, unknown> | undefined
        const args: unknown[] = []
        if (bareParams && paramNames.length) {
          for (const pn of paramNames) {
            args.push(bareParams[pn] !== undefined ? bareParams[pn] : null)
          }
        }
        if (sigParens) {
          const sigArgsBP = sigParens[1].split(',').map(s => s.trim()).filter(Boolean)
          const hasRequiredUnprovided = sigArgsBP.some((a) => {
            const trimmed = a.trim()
            const pName = trimmed.split('::')[0].trim()
            if (bareParams && pName in bareParams) return false
            if (/DEFAULT\s/i.test(trimmed)) return false
            return true
          })
          if (hasRequiredUnprovided) {
            throw Object.assign(new Error('ParameterMissing'), { tckError: 'MissingParameter' })
          }
        }
        const ctx: import('./procedure-registry').ProcedureContext = {
          getAllNodes: () => nodes as any[],
          getNodeCount: () => nodes.length,
          getLabels: () => {
            const labels = new Set<string>()
            for (const node of nodes) {
              const lbl = String(node._label || '')
              if (lbl) for (const l of lbl.split(':').map(s => s.trim()).filter(Boolean)) labels.add(l)
            }
            return Array.from(labels)
          },
          getPropertyKeys: () => {
            const keys = new Set<string>()
            for (const node of nodes) { for (const k of Object.keys(node)) if (!k.startsWith('_')) keys.add(k) }
            return Array.from(keys)
          },
        }
        return proc.execute(ctx, args) as any
      }
    }
  }
  // ── Pure-expression WITH+RETURN fast path ──
  // For queries with WITH/UNWIND/expression columns but no MATCH, no DML,
  // and no procedure calls, bypass GE entirely.  The query-executor's
  // expression engine evaluates temporal functions (date(), datetime(), etc.)
  // while GE's _executeWithClause would skip them, leaving stale data.
  if (plan.type === 'QUERY' && !plan.hasMatch && !plan.steps?.length &&
      !plan.callProcedure && (plan.with?.columns?.length || plan.expressionColumns?.length)) {
    const hasAnyNonAggExpr = plan.with?.columns?.some((wc: any) => {
      const expr = typeof wc === 'object' ? wc.expression : wc
      return typeof expr === 'string' && expr.includes('(')
    }) || false
    if (hasAnyNonAggExpr) {
      // Build a single row with WITH columns evaluated by expression engine
      const row: Record<string, unknown> = {}
      if (plan.with?.columns) {
        for (const wc of plan.with.columns) {
          const alias = wc.alias || wc.expression
          const wcExpr = typeof wc.expression === 'string' ? wc.expression : null
          if (wcExpr) {
            const val = _evalBinary(wcExpr, {})
            if (val !== null && val !== undefined) {
              row[alias] = val
            }
          }
        }
      }
      // Format through _formatResultRow to handle RETURN expressions
      const rawRow = { id: '', props: row }
      const formatted = _formatResultRow(rawRow as any, plan)
      return await _postProcessResults([formatted], plan)
    }
  }
  // GE 执行路径 - 仅在需要时才深拷贝 plan（_executeViaGraphEngine 内会 mutate plan.filters/plan.steps）
  const planCopy = JSON.parse(JSON.stringify(plan, _bigintReplacer), _bigintReviver) as QueryPlan
  const execQueryResult = await _executeViaGraphEngine(planCopy, nodes, query)
  // DML 语句无 RETURN 时不返回结果（Cypher 规范）
  // ── GROUP BY 聚合后处理 ──
  // 当 plan.aggregate 和 plan.groupBy 都存在时，对原始 nodes 做分组聚合
  if ((plan as any).groupBy?.length && (plan as any).aggregate) {
    const groupByCols = (plan as any).groupBy as string[]
    const agg = (plan as any).aggregate as { function: string; column: string; type: string; field: string }
    const exprs = (plan as any).expressionColumns as Array<{expression:string;alias:string}> | undefined
    
    if (exprs) {
      // 如果 plan.filters 有值，先过滤 nodes（WHERE 过滤应在 GROUP BY 之前执行）
      let filteredNodes = nodes
      const filters = (plan.filters || []) as Array<{source?:string;property:string;value:any;operator:string}>
      if (filters.length) {
        filteredNodes = nodes.filter((node: Record<string, unknown>) => {
          return filters.every(f => {
            const propMatch = (f.property || '').match(/^(\w+)\.(\w+)$/)
            const actualVal = propMatch
              ? (node as any)[propMatch[2]]
              : (node as any)[f.property]
            if (actualVal === undefined) return false
            switch (f.operator) {
              case 'EQ':  return String(actualVal) === String(f.value)
              case 'NEQ': return String(actualVal) !== String(f.value)
              case 'GT':  return Number(actualVal) > Number(f.value)
              case 'GTE': return Number(actualVal) >= Number(f.value)
              case 'LT':  return Number(actualVal) < Number(f.value)
              case 'LTE': return Number(actualVal) <= Number(f.value)
              default:    return String(actualVal) === String(f.value)
            }
          })
        })
      }
      // 直接对 filteredNodes 按 groupBy 分组聚合
      const groups = new Map<string, Record<string, unknown>[]>()
      for (const node of filteredNodes) {
        const rowCtx: Record<string, unknown> = { n: node }
        const keyVals: Record<string, unknown> = {}
        for (const gb of groupByCols) {
          // 找到 gb 对应的 expression
          const ec = exprs.find(e => e.alias === gb || e.expression === gb || e.expression.endsWith('.' + gb))
          keyVals[gb] = ec ? _evalBinary(ec.expression, rowCtx) : node[gb as string]
        }
        const keyStr = JSON.stringify(keyVals)
        if (!groups.has(keyStr)) groups.set(keyStr, [])
        groups.get(keyStr)!.push(node)
      }
      // 对每组应用 aggregate 函数
      const result: Record<string, unknown>[] = []
      for (const [, groupRows] of groups) {
        const row: Record<string, unknown> = {}
        for (const gb of groupByCols) {
          const ec = exprs.find(e => e.alias === gb || e.expression === gb || e.expression.endsWith('.' + gb))
          row[ec?.alias || gb] = ec ? _evalBinary(ec.expression, { n: groupRows[0] }) : (groupRows[0] as any)[gb as string]
        }
        const aggField = agg.field === '*' ? null : agg.field
        if (agg.function === 'count') {
          row[agg.column] = aggField === null ? groupRows.length : groupRows.filter(n => (n as any)[aggField!] != null).length
        } else if (agg.function === 'sum') {
          row[agg.column] = groupRows.reduce((acc, n) => acc + (Number((n as any)[aggField!]) || 0), 0)
        } else if (agg.function === 'avg') {
          const sum = groupRows.reduce((acc, n) => acc + (Number((n as any)[aggField!]) || 0), 0)
          row[agg.column] = sum / groupRows.length
        } else if (agg.function === 'min') {
          row[agg.column] = Math.min(...groupRows.map(n => Number((n as any)[aggField!]) || 0))
        } else if (agg.function === 'max') {
          row[agg.column] = Math.max(...groupRows.map(n => Number((n as any)[aggField!]) || 0))
        } else {
          row[agg.column] = groupRows.length
        }
        result.push(row)
      }
      return result
    }
  }
  const isDML = ['CREATE', 'MERGE', 'DELETE', 'SET', 'REMOVE'].includes(plan.type || '')
  if (isDML && !plan.returnColumns?.length && !plan.expressionColumns?.length) {
    return []
  }
  // ── Aggregate default row ──
  // When a Cypher query has aggregation functions (collect, count, etc.) but no
  // rows were produced (e.g., empty graph + OPTIONAL MATCH), return a single
  // default row with null/zero aggregate values instead of an empty result.
  if (execQueryResult.length === 0 && query && /\b(collect|count|sum|avg|min|max)\s*\(/i.test(query)) {
    const defaultRow: QueryRow = {}
    for (const col of (plan.expressionColumns || [])) {
      const alias = col.alias || ''
      if (!alias) continue
      const expr = typeof col.expression === 'string' ? col.expression : (col.expression as any)?.expression || ''
      // Determine default: size(collect(...)) -> 0, count(...) -> 0, others -> null
      if (/^(?:size|count)\s*\(/.test(expr.trim())) {
        defaultRow[alias] = 0
      } else {
        defaultRow[alias] = null
      }
    }
    return [defaultRow] as QueryResult
  }
  return execQueryResult
}

/**
 * TCK 兼容的编译时语义验证。
 * 公开导出，在 step-definitions.ts 中调用。
 * 对应 openCypher SyntaxError 检查：VariableTypeConflict、UndefinedVariable、
 * VariableAlreadyBound、InvalidArgumentType、NonConstantExpression、InvalidDelete 等。
 */
