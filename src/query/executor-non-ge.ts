/**
 * executor-non-ge.ts — 非 GE 执行路径（early exit）
 *
 * 包含 LOAD CSV、DML、WITH/UNWIND、FOREACH、catalog、变量长度路径。
 * 这些路径不需要 GraphEngine 实例，可直接从 plan/nodes/query 推导。
 * 从 query-executor.ts _executeViaGraphEngine 提取。
 */

import fs from 'fs'
import path from 'path'
import type { QueryPlan, QueryRow, QueryResult } from './query-types'
import { _evaluateExpression, _postProcessResults } from './expression-engine'
import { parseCsvContent } from './executor-common'
import { _executeVarLenPath } from './executor-common'
import { _executeWithUnwindPipeline } from './executor-unwind-pipeline'
import { _fastDedup, _fastIntersect, _fastSubtract, _applyYieldAliases } from './query-parser'
import { _getActiveDatabase, _setActiveDatabase, _createDatabase, _dropDatabase, _getAllDatabases, _clearDatabases } from './executor-registry'
import { _registerIndex, _dropIndex, _getAllIndexes, _clearIndexes } from './executor-registry'
import { _registerConstraint, _dropConstraint, _getAllConstraints, _clearConstraints } from './executor-registry'
import { globalRegistry as _procedureRegistry } from './procedure-registry'
import { executeForeachInlineTop } from './foreach-exec'
import { evalForeachCondTop, applyForeachOpTop } from './foreach-exec'

/**
 * _execNonGePaths — 非 GE 执行路径
 * 如果 plan 不需要 GraphEngine 执行，返回结果。
 * 如果 plan 需要 GE 执行，返回 null。
 */
export async function _execNonGePaths(
  plan: QueryPlan,
  nodes: Array<Record<string, unknown>>,
  query?: string,
): Promise<QueryResult | null> {
  if (plan.loadCsv) {
    const csv = plan.loadCsv
    let filePath = csv.url
    if (filePath.startsWith('file://')) filePath = filePath.slice(7)
    if (!path.isAbsolute(filePath)) {
      filePath = path.resolve(process.cwd(), filePath)
    }
    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf-8')
    } catch (e: any) {
      throw new Error(`LOAD CSV error: cannot read file "${filePath}": ${e.message}`)
    }
    const rows = parseCsvContent(content, {
      headers: csv.hasHeaders,
      delimiter: csv.delimiter,
      as: csv.rowVariable,
    })
    return _postProcessResults(rows, plan)
  }

  // SHOW LABELS / INDEXES / CONSTRAINTS / PROCEDURES / FUNCTIONS / RELATIONSHIPTYPES
  if (plan.show) {
    const what = (plan.show as any).what
    if (what === 'LABELS') {
      const seen = new Set<string>()
      const labels: QueryRow[] = []
      for (const n of nodes) {
        const lbl = n['_label']
        if (lbl && !seen.has(String(lbl))) { seen.add(String(lbl)); labels.push({ label: lbl }) }
      }
      return labels
    }
    if (what === 'INDEXES') {
      const indexes = _getAllIndexes()
      return indexes.map(idx => ({
        name: `${idx.label}.${idx.property}`,
      }))
    }
    if (what === 'CONSTRAINTS') {
      const constraints = _getAllConstraints()
      return constraints.map(c => ({
        name: c.name,
      }))
    }
    if (what === 'PROCEDURES') {
      return [
        { name: 'db.labels', mode: 'READ', description: 'List all node labels' },
        { name: 'db.relationshipTypes', mode: 'READ', description: 'List all relationship types' },
        { name: 'db.indexes', mode: 'READ', description: 'List all indexes' },
        { name: 'db.constraints', mode: 'READ', description: 'List all constraints' },
      ]
    }
    if (what === 'FUNCTIONS') {
      return [
        { name: 'type', description: 'Returns the type of a relationship' },
        { name: 'properties', description: 'Returns a map containing all properties' },
        { name: 'toString', description: 'Converts a value to a string' },
        { name: 'toInteger', description: 'Converts a value to an integer' },
        { name: 'toFloat', description: 'Converts a value to a float' },
        { name: 'keys', description: 'Returns the keys of a map or node' },
        { name: 'labels', description: 'Returns the labels of a node' },
      ]
    }
    if (what === 'RELATIONSHIPTYPES') {
      const seen = new Set<string>()
      const types: QueryRow[] = []
      for (const n of nodes) {
        if (n.__edges && Array.isArray(n.__edges)) {
          for (const e of n.__edges) {
            const lbl = e.label || ''
            if (lbl && !seen.has(String(lbl))) { seen.add(String(lbl)); types.push({ relationshipType: lbl }) }
          }
        }
      }
      return types
    }
    return []
  }

  // 过程调用：CALL db.labels(), db.indexes(), db.constraints(), db.schema.visualization()
  if (plan.callProcedure) {
    const { name, args } = plan.callProcedure
    switch (name) {
      case 'db.labels': {
        // 返回所有节点标签（从 allNodes 收集）
        const labels = new Set<string>()
        for (const node of nodes) {
          const lbl = String(node._label || 'Default')
          for (const l of lbl.split(':').map(s => s.trim()).filter(Boolean)) labels.add(l)
        }
        if (args?.length) {
          // 如果 args 中包含字符串参数，可能要做筛选（但 Cypher 标准 db.labels() 无参数）
        }
        return Array.from(labels).map(l => ({ label: l })) as any
      }
      case 'db.indexes': {
        return _getAllIndexes().map(idx => ({
          id: `${idx.label}:${idx.property}`,
          name: `${idx.label}:${idx.property}`,
          state: 'ONLINE',
          type: 'BTREE',
          labelsOrTypes: [idx.label],
          properties: [idx.property],
          provider: 'native-btree-1.0',
          entityType: 'NODE',
        })) as any
      }
      case 'db.constraints': {
        return _getAllConstraints().map(c => ({
          id: c.name,
          name: c.name,
          state: 'ONLINE',
          type: 'UNIQUENESS',
          entityType: 'NODE',
          labelsOrTypes: [c.label],
          properties: [c.property],
        })) as any
      }
      case 'db.schema.visualization': {
        // 从 nodes 遍历实际 schema
        const labels = new Set<string>()
        const relTypes = new Set<string>()
        const labelProps = new Map<string, Set<string>>()
        const relTypeProps = new Map<string, Set<string>>()

        for (const node of nodes) {
          // 收集节点标签
          const lbl = String(node._label || '')
          if (lbl) {
            for (const l of lbl.split(':').map(s => s.trim()).filter(Boolean)) {
              labels.add(l)
              if (!labelProps.has(l)) labelProps.set(l, new Set())
              // 收集该标签节点的属性名（排除下划线开头的内部属性）
              for (const k of Object.keys(node)) {
                if (!k.startsWith('_')) labelProps.get(l)!.add(k)
              }
            }
          }
          // 收集边类型
          if (node.__edges) {
            for (const e of node.__edges as any[]) {
              const rl = String(e.label || '')
              if (rl && !relTypes.has(rl)) {
                relTypes.add(rl)
                relTypeProps.set(rl, new Set())
              }
              if (rl) {
                if (e.props) for (const k of Object.keys(e.props)) relTypeProps.get(rl)!.add(k)
              }
            }
          }
        }

        return [{
          nodes: Array.from(labels).map(l => ({
            id: l,
            name: l,
            labels: [l],
            properties: Array.from(labelProps.get(l) || []),
          })),
          relationships: Array.from(relTypes).map(r => ({
            id: r,
            type: r,
            properties: Array.from(relTypeProps.get(r) || []),
          })),
        }] as any
      }
      default: {
        // Standalone CALL: nodes 为空时直接返回 proc 结果
        if (nodes.length === 0) {
          const proc = _procedureRegistry.get(name)
          if (!proc) throw new Error(`Unknown procedure: ${name}`)
          const ctx: import('./procedure-registry').ProcedureContext = {
            getAllNodes: () => nodes,
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
              for (const node of nodes) {
                for (const k of Object.keys(node)) if (!k.startsWith('_')) keys.add(k)
              }
              return Array.from(keys)
            },
          }
          const raw = proc.execute(ctx, args || []) as any[]
          const aliased = _applyYieldAliases(raw, plan.callProcedure.yieldItems, query)
          if (plan.with?.columns?.length) {
            let withRows = aliased
            const aggFnPat = /^\s*(collect|count|sum|avg|max|min)\s*\(/i
            const withAggCols = []
            for (const wc of plan.with.columns) {
              if (aggFnPat.test(wc.expression)) {
                if (/^\s*count\s*\(\s*\*\s*\)\s*$/i.test(wc.expression)) {
                  withAggCols.push({ alias: wc.alias || wc.expression, val: withRows.length })
                }
              }
            }
            if (withAggCols.length > 0) {
              withRows = [Object.fromEntries(withAggCols.map(a => [a.alias, a.val]))]
            }
            const secondPlan = { ...plan, with: undefined, returnColumns: plan.returnColumns || Object.keys(withRows[0] || {}) }
            const { _executeViaGraphEngine: _evge } = await import('./query-executor')
            return _evge(secondPlan, withRows, query)
          }
          return aliased
        }
        // In-query CALL: 对每个 MATCH 行执行 proc，返回十字连接
        const proc = _procedureRegistry.get(name)
        if (proc) {
          const ctx: import('./procedure-registry').ProcedureContext = {
            getAllNodes: () => nodes,
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
              for (const node of nodes) {
                for (const k of Object.keys(node)) if (!k.startsWith('_')) keys.add(k)
              }
              return Array.from(keys)
            },
          }
          const procResult = proc.execute(ctx, args || []) as any[]
          // Void procedure (e.g. doNothing) yields no rows and consumes none:
          // re-run the plan without the CALL clause so the preceding MATCH rows
          // flow through untouched.  Dynamic import avoids a module cycle with
          // query-executor.ts (which imports this file for _execNonGePaths).
          if (procResult.length === 0) {
            const matchPlan = { ...plan, callProcedure: undefined } as any
            delete matchPlan.callProcedure
            const { _executeQuery } = await import('./query-executor')
            return _executeQuery(matchPlan, nodes, query)
          }
          // In-query CALL with a non-empty result set: cross-join the matched
          // rows with the procedure rows.  Resolve the MATCH rows by re-running
          // the plan without the CALL clause via a dynamic import (avoids cycle).
          let geRows
          if (nodes.length > 0 && !plan.hasMatch && !plan.scanLabel && (!plan.steps || plan.steps.length === 0)) {
            geRows = nodes
          } else {
            const planCopy = { ...plan, callProcedure: undefined } as any
            delete planCopy.callProcedure
            const { _executeQuery } = await import('./query-executor')
            geRows = await _executeQuery(planCopy, nodes, query)
          }
          const joinedRows: any[] = []
          for (const geRow of geRows) {
            for (const pr of procResult) {
              joinedRows.push({ ...geRow, ...pr })
            }
          }
          return joinedRows
        }
        // 找不到 proc 时走 GE 路径
        break
      }
    }
  }

  // INDEX 操作：CREATE INDEX ON :Label(prop) / DROP INDEX ON :Label(prop)
  if (plan.indexOp) {
    if (plan.indexOp === 'CREATE' && plan.indexLabel && plan.indexProperty) {
      _registerIndex(plan.indexLabel, plan.indexProperty)
      return [{ created: true }] as any
    }
    if (plan.indexOp === 'DROP' && plan.indexLabel && plan.indexProperty) {
      _dropIndex(plan.indexLabel, plan.indexProperty)
      return [{ dropped: true }] as any
    }
    return []
  }

  // CONSTRAINT 操作：DROP CONSTRAINT name
  if (plan.type === 'DROP_CONSTRAINT' && (plan as any).constraint?.property) {
    _dropConstraint((plan as any).constraint.property)
    return [{ dropped: true }] as any
  }

  // CATALOG 操作：CREATE DATABASE / DROP DATABASE / SHOW DATABASES
  if (plan.catalogOp) {
    switch (plan.catalogOp) {
      case 'CREATE_DATABASE':
        if (plan.useGraph) {
          _createDatabase(plan.useGraph)
          return [{ database: plan.useGraph, created: true }] as any
        }
        return []
      case 'DROP_DATABASE':
        if (plan.useGraph) {
          _dropDatabase(plan.useGraph)
          return [{ database: plan.useGraph, dropped: true }] as any
        }
        return []
      case 'SHOW_DATABASES':
        return _getAllDatabases().map(d => ({ name: d })) as any
      default:
        return []
    }
  }

  // USE — 命名空间切换
  if (plan.type === 'USE') {
    if (plan.useGraph) { _setActiveDatabase(plan.useGraph); return [{ database: plan.useGraph, switched: true }] as any }
    return nodes
  }

  // ── DML（DELETE/SET/MERGE/REMOVE） ──
  // 非递归入口。DML 操作仅修改 allNodes，不同步 GE 存储（见 DML 持久化分析）

  // UNION — 递归执行
  if (plan.unionType && plan.rightPlan) {
    const { _executeViaGraphEngine: _evge } = await import('./query-executor')
    const leftResult = await _evge({ ...plan, unionType: undefined, rightPlan: undefined }, nodes)
    const rightResult = await _evge(plan.rightPlan, nodes)
    const leftRows = leftResult as QueryRow[]
    const rightRows = rightResult as QueryRow[]
    switch (plan.unionType) {
      case 'union': return _fastDedup([...leftRows, ...rightRows])
      case 'union_all': return [...leftRows, ...rightRows]
      case 'intersect': return _fastIntersect(leftRows, rightRows)
      case 'subtract': return _fastSubtract(leftRows, rightRows)
      default: return [...leftRows, ...rightRows]
    }
  }

  // ── WITH / UNWIND / aggregate 管道 ──
  // 处理 WITH [...] AS x → UNWIND x AS y → ... → RETURN agg, count(*) 链
  // 不涉及 MATCH/GE 图遍历，纯表达式 + 聚合
  // Note: MATCH + WITH + UNWIND 场景（如 MATCH ... WITH [...] AS x UNWIND ...）
  // 的 WITH 列表包含 MATCH 变量，不能走纯表达式管道。走主路径处理。
  // Exception: mixed MATCH+aggregate WITH queries (e.g. MATCH ... WITH collect(a) AS nodes)
  // — the aggregate pipeline needs to process WITH/UNWIND after MATCH returns nodes.
  // GE's _executeQueryPlan doesn't handle WITH expressions when plan.aggregate is set,
  // so we let the unwind pipeline manage the full post-MATCH projection.
  // Also cover SET/DELETE DML types that have hasMatch+unwind/with: when the query
  // plan is a DML type, GE may not handle WITH correctly, so delegate to pipeline.
  //
  // ── 多子句交叉连接守卫 ──
  // `MATCH (a) WITH a MATCH (b) WHERE ...` 是“变量前向传递 + 第二个 MATCH”的
  // 交叉连接模式，不是 list/collect 投影管道。此类查询必须走 GE 主路径以构建
  // a×b 笛卡尔积。检测信号：查询以 MATCH 开头，且 WITH 后还有第二个 MATCH 子句。
  //
  // 注意区分两类“WITH 后跟 MATCH”：
  //   (1) 交叉连接：`MATCH (a) WITH a MATCH (b)` — 首个子句是 MATCH，第二个
  //       MATCH 是笛卡尔积新起点，必须走 GE。
  //   (2) 管道变量注入：`WITH collect(...) UNWIND ... WITH expected MATCH (n)`
  //       首个子句是 WITH/UNWIND，MATCH 只是对已物化的 `expected` 变量做过滤，
  //       必须走 unwind 管道（否则 `expected` 不会物化，WHERE 全空）。
  // 因此守卫必须以查询是否“以 MATCH 开头”为前提。
  const _hasSecondMatchAfterWith = !!query && /^\s*MATCH\b/is.test(query) && /WITH\b[^]*?\bMATCH\s*\(/is.test(query)
  // 管道变量注入模式以 WITH/UNWIND 开头（如 `WITH collect(...) UNWIND ... WITH expected MATCH (n)`），
  // 而非以 MATCH 开头。以 MATCH 开头的 `MATCH ... WITH collect(a) ... UNWIND ...` 是
  // 聚合投影，必须走 GE，不能误入 unwind 管道。
  const _startsWithWith = !!query && /^\s*(?:WITH|UNWIND)\b/is.test(query)
  // A scalar aggregate in WITH (count/sum/avg/max/min — NOT collect) is now
  // folded by the graph engine's `_executeWithClause` (which reads
  // `with.aggregate`, populated by `extractWith`).  Only `collect(...)` list
  // projections (which GE's WITH handling cannot evaluate) must stay on the
  // unwind pipeline.  Routing a `WITH count(*) AS cnt` to the pipeline here
  // collapses it to count=1, so exclude the scalar-aggregate case.
  const _withScalarAggOnly = !!(plan.with?.columns?.length && plan.with.columns.every((wc: any) =>
    typeof wc?.expression === 'string' && /^\s*(count|sum|avg|max|min)\s*\(/i.test(wc.expression)))
  // A scalar aggregate (sum/count/avg/max/min) — whether it lives in WITH or in
  // RETURN — is folded by the graph engine (`_executeWithClause` /
  // `_executeAggregation`).  Only `collect(...)` list projections (which GE
  // cannot evaluate) and real UNWIND expansions must route through the unwind
  // pipeline.  Routing `MATCH (n) WITH n, n.num AS num DELETE n RETURN sum(num)`
  // here would evaluate `n.num` against the whole match array and throw
  // "Property access on non-map type".
  const _aggIsCollect = !!(plan.aggregate && (plan.aggregate as any).function === 'collect')
  // UNWIND + CREATE/MERGE must materialize nodes via the graph engine (the
  // `_executeViaGraphEngine` createNodes expansion loop substitutes the unwind
  // variable into each created node's properties).  Routing it here would only
  // expand + project rows and leave `n.num` null, so exclude DML-node creators.
  const _unwindCreatesNodes = (plan.type === 'CREATE' || plan.type === 'MERGE') && !!plan.unwind && !!plan.createNodes?.length
  if (!_hasSecondMatchAfterWith && (
      (!plan.hasMatch && (plan.unwind || (plan.with && !plan.hasMatch)) && !_unwindCreatesNodes) ||
      (plan.hasMatch && plan.aggregate && (plan.unwind || _aggIsCollect) && !(plan.steps?.length > 0) && !_withScalarAggOnly) ||
      (_startsWithWith && plan.hasMatch && plan.unwind && plan.with && !plan.aggregate) ||
      (plan.hasMatch && (plan.type === 'SET' || plan.type === 'DELETE') && plan.unwind))) {
    const result = _executeWithUnwindPipeline(plan, nodes, query)
    // Apply ORDER BY / SKIP / LIMIT on the unwind/with pipeline output.
    // `_executeWithUnwindPipeline` only performs expansion + projection and
    // never sorts or slices rows, so a `WITH x ORDER BY x LIMIT n` (promoted
    // onto plan.orderBy / plan.limit by the parser) must be post-processed here.
    const orderedResult = _postProcessResults(result as QueryRow[], plan)
    // Execute SET clauses on the matched nodes after pipeline projection
    if (plan.type === 'SET' && plan.setClauses?.length) {
      for (const sc of plan.setClauses) {
        if (sc.property) {
          const targetVarName = plan.unwind?.name
          for (const row of (orderedResult as QueryRow[])) {
            const target = row[targetVarName!]
            if (target && typeof target === 'object') {
              const val = sc.value
              const parsedVal = typeof val === 'object' && val !== null && 'value' in val
                ? (val as any).value : val
              ;(target as Record<string, unknown>)[sc.property] = parsedVal
            }
          }
        }
      }
    }
    return orderedResult
  }

  // 纯 RETURN 字面量（无 MATCH 无 steps 非 DML）——不经过 GraphEngine
  // Note: OPTIONAL MATCH 必须经过 GraphEngine，即使 hasMatch 为 false
    const isDML = ['MERGE', 'CREATE', 'DELETE', 'SET', 'REMOVE', 'MATCH_MODIFY', 'CREATE_CONSTRAINT'].includes(plan.type || '')
  const hasOptionalMatch = plan.optionalMatchSteps?.length ? true : false
  if (!plan.scanLabel && !plan.steps?.length && !plan.aggregate && !plan.hasMatch && !isDML && !hasOptionalMatch) {
    const row: QueryRow = {}
    // 注入 WITH 列到 row（expressionColumns 可能引用 WITH 中定义的变量）
    if (plan.with?.columns) {
      for (const wc of plan.with.columns) {
        if (wc.alias) {
          row[wc.alias] = _evaluateExpression(wc.expression, row)
        }
      }
    }
    if (plan.returnColumns?.length) {
      // 使用表达式引擎求值每个 returnColumn
      if (plan.expressionColumns?.length) {
        // expressionColumns 包含结构化的 { expression, alias }，来自 ANTLR parse
        for (const ec of plan.expressionColumns) {
          const val = _evaluateExpression(ec.expression, row)
          row[ec.alias] = val !== null ? val : null
        }
      } else {
        // 无 expressionColumns 时的 fallback（向后兼容）
        for (const rc of plan.returnColumns) {
          const isIdentifier = /^[a-zA-Z_]\w*$/.test(rc) && !['null', 'true', 'false'].includes(rc)
          if (isIdentifier) {
            row[rc] = null
          } else {
            const val = _evaluateExpression(rc, row)
            row[rc] = val !== null ? val : null
          }
        }
      }
    }
    // ── FOREACH 子句：纯 RETURN + FOREACH 时，先执行 FOREACH 再返回结果 ──
    // 支持旧格式（updates+name）和新格式（variable+operation）
    const feFe = plan.forEach as any
    const isNewForeach = feFe && feFe.variable && feFe.operation
    if (isNewForeach) {
      const listItems = Array.isArray(feFe.list) ? [...feFe.list] : []
      if (listItems.length > 0) {
        const candidates = nodes.length > 0 ? nodes.map((n: any) => ({ ...n })) : [{}]
        const execResult = executeForeachInlineTop(candidates, feFe)
        if (execResult.length > 0) {
          const rc = (plan.returnColumns || [])[0]
          const retVar = rc ? rc.split('.')[0] : 'n'
          return execResult.map((exr: any) => ({ [retVar]: exr }))
        }
      } else {
        // 空列表：无展开，返回基线单行
        return Object.keys(row).length ? [row] : [{}]
      }
    }
    if (plan.forEach?.updates?.length && Array.isArray(nodes)) {
      const fe = plan.forEach
      // 解析 list：可能是数组或字符串
      let listItems: unknown[] = []
      if (fe.list && fe.name) {
        if (Array.isArray(fe.list)) {
          listItems = fe.list
        } else if (typeof fe.list === 'string') {
          const listStr = fe.list as string
          if (listStr.startsWith('[') && listStr.endsWith(']')) {
            // 尝试 JSON.parse，如果失败（如单引号），将单引号替换为双引号
            try { listItems = JSON.parse(listStr) } catch {
              try { listItems = JSON.parse(listStr.replace(/'/g, '"')) } catch {}
            }
          }
        }
      }
      if (listItems.length === 0 && Object.keys(row).length) return [row]
      const rows: QueryRow[] = []
      for (const item of listItems) {
        for (const update of fe.updates) {
          if (update.type === 'CREATE') {
            const props: Record<string, unknown> = { _label: update.label || 'Default' }
            if (update.props) {
              for (const [k, v] of Object.entries(update.props)) {
                const valToUse = v === fe.name ? item : (typeof v === 'object' && v !== null && 'value' in v ? (v as any).value : v)
                props[k] = valToUse
              }
            }
            if (update.alias) props['_alias'] = update.alias
            ;(nodes as any[]).push(props)
            const r: QueryRow = {}
            if (update.alias) r[update.alias] = { ...props }
            rows.push(r)
          } else if (update.type === 'SET' && update.property && update.value) {
            // SET p.name = val — 用 item 替换变量引用
            // update.value 可能是变量名（等于 fe.name）或字面量
            const valToSet = update.value === fe.name ? item : update.value
            for (const node of nodes as any[]) {
              if (node._alias === update.alias || update.alias === '' || node._alias === undefined) {
                node[update.property] = valToSet
              }
            }
          }
        }
      }
      return rows.length > 0 ? rows : [row]
    }
    return Object.keys(row).length ? [row] : []
  }

  // ── DML 纯操作（无 RETURN）：CREATE/MERGE 必须创建节点不能跳过，其他 DML 直接返回空
  if (isDML && !plan.returnColumns?.length && !plan.aggregate) {
    // CREATE/MERGE 需要创建节点，走 GE 路径（返回 null 给 _executeViaGraphEngine 处理）
    if (plan.type === 'CREATE' || plan.type === 'MERGE') return null
    // CREATE_CONSTRAINT: 验证现有数据唯一性并注册约束
    if (plan.type === 'CREATE_CONSTRAINT' && plan.constraint) {
      const { label, property } = plan.constraint
      // 约束名: label_property_unique
      const constraintName = `${label}_${property}_unique`
      // 检查是否已存在同名约束（幂等）
      const existing = _getAllConstraints().find(c => c.name === constraintName)
      if (existing) {
        return []
      }
      // 遍历所有节点，检查该 label + property 的组合是否唯一
      const seen = new Map<unknown, number>() // value → first index
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]
        const nodeLabel = node._label
        // 检查 label 是否匹配：支持多标签（":" 分隔）
        const labels = String(nodeLabel ?? '').split(':').map(s => s.trim()).filter(Boolean)
        if (!labels.includes(label)) continue
        const rawVal = node[property]
        // null/undefined 不违反唯一约束（Cypher 语义：唯一约束不覆盖 NULL）
        if (rawVal === null || rawVal === undefined) continue
        // 解析 typed 格式：{type: 'STRING', value: 'xxx'} → 'xxx'
        const propVal = (rawVal && typeof rawVal === 'object' && 'value' in (rawVal as any))
          ? (rawVal as any).value
          : rawVal
        if (propVal === null || propVal === undefined) continue
        if (seen.has(propVal)) {
          throw new Error(`ConstraintValidationFailed: Node(${label}) already exists with ${property} = ${JSON.stringify(propVal)}`)
        }
        seen.set(propVal, i)
      }
      _registerConstraint(constraintName, label, property)
      return []
    }
    // DELETE/SET/REMOVE 可以直接返回空（不创建节点/边）
    if (plan.type !== 'CREATE' && plan.type !== 'MERGE') {
      return []
    }
  }

  // ── 变量长度路径：直接 BFS 并返回，不依赖 GE ──
  // `_executeVarLenPath` is a pure BFS matcher: it returns the raw expanded rows
  // but neither folds a trailing aggregate (`RETURN count(*)`) nor applies DML
  // side effects (`DETACH DELETE a, b`).  When a variable-length pattern is
  // followed by DML or an aggregate, fall through to the main GE path, which
  // owns the DELETE/SET/REMOVE side effects and the aggregate fold.
  const hasVarLenGE = plan.steps?.length === 1 && (plan.steps[0] as any)?.range && !isDML && !plan.aggregate
  if (hasVarLenGE) {
    let varLenResult = _executeVarLenPath(plan, nodes)
    // ── 对 VLE 结果应用 expressionColumns 映射 ──
    // _executeVarLenPath 返回 raw row（p, a, b 等），但不包含 length(p)/type(p) 等表达式列
    if (plan.expressionColumns?.length && varLenResult.length) {
      varLenResult = varLenResult.map((row: any) => {
        const newRow: Record<string, unknown> = { ...row }
        const evalCtx: Record<string, unknown> = { ...newRow }
        for (const ec of plan.expressionColumns) {
          if (typeof ec.expression === 'string' && ec.expression in evalCtx) {
            newRow[ec.alias] = evalCtx[ec.expression]
          } else {
            const val = typeof ec.expression === 'string' ? _evaluateExpression(ec.expression, evalCtx) : null
            newRow[ec.alias] = val !== undefined ? val : null
          }
        }
        return newRow
      })
    }
    return varLenResult
  }

  return null  // not a non-GE path, proceed to GE execution
}
