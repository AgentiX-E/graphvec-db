/**
 * executor-dml.ts — DML 执行辅助函数
 *
 * 从 query-executor.ts 拆分。
 */

import type { QueryPlan, QueryRow } from './query-types'
import { _evaluateExpression } from './expression-engine'

/**
 * 为 DML（CREATE）带 RETURN 构造结果行。
 *
 * GE 对 DML 返回空数组，所以需要从 plan 元数据直接构造。
 * parseQuery 对 RETURN n.name AS p 的处理：
 *   - returnColumns: ['p']（别名）
 *   - createNodes: [{alias: 'n', label: null, props: {name: 'foo'}}]
 *
 * 挑战：returnColumns 丢失了原始表达式 n.name，只剩下别名 p。
 * 解决方案：从 plan.createNodes 匹配别名；如果找不到，说明 rc 可能是
 * 属性名（没有 AS 重命名），直读 createNodes[0].props。
 *
 * 区分变量名 RETURN vs 属性名 RETURN：
 *   - RETURN n → rc="n"，对应 createNodes[i].alias === "n"
 *   - RETURN n.p → rc="p"，找到 createNodes[i].props.p 或回退正则扫描
 *   - RETURN n.p AS P → rc="P"，找不到属性名 P，回退 fallback：扫描所有 props
 */
function _buildDmlRows(plan: QueryPlan, allNodes: Array<Record<string, unknown>>): QueryRow[] {
  if (!plan.returnColumns?.length) return []

  // ── MATCH-driven fan-out ──
  // `MATCH (person:Person) MERGE/CREATE ... RETURN person.bornIn` binds `person`
  // to N nodes; the DML row builder otherwise collapses the projection to a
  // single row (the first matched node).  When every RETURN column references
  // the primary MATCH variable and it matched more than one node, emit one row
  // per matched node instead.  (Relationship MERGE already fan-outs through the
  // cross-join path; only the node-only DML path needs this expansion.)
  const _matchVar = (plan as any).matchVar as string | undefined
  const _scanLabel = (plan as any).scanLabel as string | null | undefined
  const _mergeEdges = (plan as any).mergeEdges as Array<any> | undefined
  if ((plan as any).hasMatch && _matchVar && _scanLabel && !(plan as any).multiMatch?.length && !_mergeEdges?.length && !plan.aggregate) {
    const aliasMap = plan.returnAliasMap as Record<string, string> | undefined
    const v2n = (allNodes as any).__varToNodeMap as Map<string, any> | undefined
    // Resolve a RETURN column against a variable-scoped node.  Columns that
    // reference the primary MATCH variable vary per matched node; columns that
    // reference a DML (MERGE/CREATE) alias resolve to the single reused/created
    // node (idempotent across rows).  This mirrors the alias-scoped projection
    // used further below for single-row DML results.
    const _resolveColumn = (rc: string, m: Record<string, unknown>): unknown => {
      const expr = aliasMap && rc in aliasMap ? aliasMap[rc] : rc
      const varName = expr.includes('.') ? expr.split('.')[0].trim() : expr.trim()
      const propPart = expr.includes('.') ? expr.split('.').pop()! : null
      if (varName === _matchVar) {
        // Reference to the MATCH variable: project from this matched node.
        return propPart ? (m as any)[propPart] ?? null : m
      }
      // Reference to a non-MATCH variable (MERGE/CREATE alias): resolve via the
      // binding table, then the `_alias` tag, then a top-level property scan.
      let target: Record<string, unknown> | undefined
      if (v2n?.has(varName)) target = v2n.get(varName)
      if (!target) {
        for (let i = allNodes.length - 1; i >= 0; i--) {
          if ((allNodes[i] as any)._alias === varName) { target = allNodes[i]; break }
        }
      }
      if (!target && propPart) {
        for (const n of allNodes) { if (propPart in n) { target = n; break } }
      }
      if (!target) return null
      let v: unknown = propPart ? (target as any)[propPart] : target
      if (v === undefined) v = null
      return v
    }
    const matched = allNodes.filter(n => {
      const lbl = String((n as any)._label ?? '')
      return lbl === _scanLabel || lbl.split(':').includes(_scanLabel as string)
    })
    // When a DELETE sub-clause removed every matched node, the match cardinality
    // survives via `__matchFanOutCount` (set by the DELETE sub-clause handler).
    // Rows still fan-out to that original cardinality; projection then resolves
    // against the surviving/re-created DML nodes rather than the deleted ones.
    const fanOutCount = matched.length > 1 ? matched.length : ((allNodes as any).__matchFanOutCount ?? 0)
    if (fanOutCount > 1) {
      const rows: QueryRow[] = []
      for (let fi = 0; fi < fanOutCount; fi++) {
        const m = matched[fi] ?? matched[0] ?? ({} as Record<string, unknown>)
        const row: QueryRow = {}
        for (const rc of plan.returnColumns) {
          if (!rc) continue
          row[rc] = _resolveColumn(rc, m)
        }
        rows.push(row)
      }
      return rows
    }
  }

  // ── UNWIND + CREATE relationship multi-row expansion ──
  // `UNWIND [...] AS x CREATE ()-[r:R {num:x}]->() RETURN r.num` creates one
  // relationship per unwound element.  The expanded relationship payloads are
  // attached by the graph engine as `__createEdges`; emit one row per edge,
  // projecting `r.prop` (or an aggregate over it) from the edge properties.
  const createEdges = (allNodes as any).__createEdges as Array<any> | undefined
  if (createEdges && createEdges.length > 1 && plan.unwind) {
    const projFromAlias = (rc: string): { varName: string; propPart: string | null } => {
      const aliasMap = plan.returnAliasMap as Record<string, string> | undefined
      const expr = aliasMap && rc in aliasMap ? aliasMap[rc] : rc
      const dot = expr.indexOf('.')
      return dot >= 0
        ? { varName: expr.slice(0, dot).trim(), propPart: expr.slice(dot + 1).trim() }
        : { varName: expr.trim(), propPart: null }
    }
    // Aggregate over the relationship properties (`RETURN sum(r.num)`).
    if (plan.aggregate) {
      const agg = plan.aggregate as any
      const aggFn = agg.function || agg.fn || agg.type || ''
      const rawField = agg.field || agg.property || ''
      const propField = rawField.includes('.') ? rawField.split('.').pop()! : rawField
      const alias = (agg.alias && agg.alias !== agg.function)
        ? agg.alias
        : (agg.column || propField || 'c')
      const aggRow: QueryRow = {}
      if (aggFn === 'count') {
        aggRow[alias] = createEdges.length
      } else if (propField) {
        const values = createEdges
          .map(e => e.props?.[propField])
          .filter((v: any) => v !== undefined && v !== null)
          .map(Number)
          .filter((v: any) => !isNaN(v))
        if (aggFn === 'sum') aggRow[alias] = values.reduce((a: number, b: number) => a + b, 0)
        else if (aggFn === 'avg') aggRow[alias] = values.length ? values.reduce((a: number, b: number) => a + b, 0) / values.length : 0
        else if (aggFn === 'max') aggRow[alias] = values.length ? Math.max(...values) : 0
        else if (aggFn === 'min') aggRow[alias] = values.length ? Math.min(...values) : 0
        else aggRow[alias] = 0
      } else {
        aggRow[alias] = 0
      }
      return [aggRow]
    }
    const rows: QueryRow[] = []
    for (const edge of createEdges) {
      const row: QueryRow = {}
      for (const rc of plan.returnColumns) {
        if (!rc) continue
        const { propPart } = projFromAlias(rc)
        let val: unknown = undefined
        if (propPart) val = edge.props?.[propPart]
        else val = edge
        row[rc] = val !== undefined && val !== null ? val : null
      }
      rows.push(row)
    }
    return _applyEdgeWithFilters(rows, createEdges, plan)
  }

  // ── UNWIND + CREATE multi-row expansion ──
  // `UNWIND [...] AS x CREATE (n {num: x}) RETURN n.num` creates one node per
  // unwound element.  Those nodes all carry the same `_alias` (the createNode
  // alias), so the single-row projection below would collapse them to one row.
  // Emit one row per freshly-created node instead, projecting RETURN columns
  // against that node (and its properties) only.
  const createdAlias = (plan.createNodes || [])[0]?.alias ?? null
  const unwoundNodes = (createdAlias && plan.unwind && plan.createNodes?.length)
    ? allNodes.filter(n => (n as any)._alias === createdAlias)
    : []
  if (unwoundNodes.length > 1) {
    const rows: QueryRow[] = []
    for (const nn of unwoundNodes) {
      const row: QueryRow = {}
      const nodeProps = (nn as any).props && typeof nn.props === 'object' ? nn.props : nn
      for (const rc of plan.returnColumns) {
        if (!rc) continue
        // Property projection (`n.num AS num`) reads from the node's props.
        let val: unknown = undefined
        if (rc in nn) val = (nn as any)[rc]
        else if (nodeProps && rc in nodeProps) val = nodeProps[rc]
        else {
          // Resolve via returnAliasMap expression `n.num` → property `num`.
          const aliasMap = plan.returnAliasMap as Record<string, string> | undefined
          const expr = aliasMap && rc in aliasMap ? aliasMap[rc] : rc
          const propPart = expr.includes('.') ? expr.split('.').pop()! : expr
          if (nodeProps && propPart in nodeProps) val = nodeProps[propPart]
          else if (propPart in nn) val = (nn as any)[propPart]
        }
        row[rc] = val !== undefined && val !== null ? val : null
      }
      rows.push(row)
    }
    // Apply aggregate columns if any (sum/count/avg/min/max over created nodes).
    if (plan.aggregate) {
      const agg = plan.aggregate as any
      const aggFn = agg.function || agg.fn || agg.type || ''
      // `field` may be a dotted property reference (`sum(n.num)` → `n.num`).
      const rawField = agg.field || agg.property || ''
      const propField = rawField.includes('.') ? rawField.split('.').pop()! : rawField
      const aggRow: QueryRow = {}
      // `count(*)`/`count(a)` carry the function name as a synthetic `alias`, so
      // fall back to the full `column` (`count(*)`) unless the user supplied an
      // explicit `AS` alias.
      const alias = (agg.alias && agg.alias !== agg.function)
        ? agg.alias
        : (agg.column || propField || 'c')
      if (aggFn === 'count') aggRow[alias] = unwoundNodes.length
      else if (propField) {
        const values = unwoundNodes
          .map(n => (n as any)[propField] ?? (n as any).props?.[propField])
          .filter((v: any) => v !== undefined && v !== null)
          .map(Number)
          .filter((v: any) => !isNaN(v))
        if (aggFn === 'sum') aggRow[alias] = values.reduce((a: number, b: number) => a + b, 0)
        else if (aggFn === 'avg') aggRow[alias] = values.length ? values.reduce((a: number, b: number) => a + b, 0) / values.length : 0
        else if (aggFn === 'max') aggRow[alias] = values.length ? Math.max(...values) : 0
        else if (aggFn === 'min') aggRow[alias] = values.length ? Math.min(...values) : 0
        else aggRow[alias] = 0
      } else aggRow[alias] = 0
      return [aggRow]
    }
    return _applyWithFilters(rows, unwoundNodes, plan)
  }


  // 聚合 DML：如 RETURN count(*)
  if (plan.aggregate) {
    const row: QueryRow = {}
    const agg = plan.aggregate as any
    // `count(*)`/`count(a)` carry the function name as a synthetic `alias`, so
    // fall back to the full `column` (`count(*)`) unless the user supplied an
    // explicit `AS` alias.
    const alias = (agg.alias && agg.alias !== agg.function)
      ? agg.alias
      : (agg.column || agg.field || 'c')
    // 支持 count/sum/avg/min/max——从 allNodes 提取属性值做聚合
    const propField = agg.field || agg.property || ''
    // The aggregate clause stores its function name in `function` (parsed by
    // `ast-to-plan-v2.ts` as `AggregateClause.function`), not `fn`.  Reading the
    // non-existent `fn` made EVERY aggregate fall through to the `default` branch
    // and emit `0`, so `MERGE (n) RETURN count(n)` returned 0 instead of 1.
    const aggFn = agg.function || agg.fn || agg.type || ''
    if (aggFn === 'count') {
      // `count(*)` / `count(a)` count the RESULT rows, not the raw node count.
      // A bare DML (CREATE/MERGE without MATCH) emits exactly ONE row, so the
      // count is 1; the node count (`allNodes.length`) is meaningless here.
      row[alias] = 1
    } else if (propField) {
      const values = allNodes
        .map(n => n[propField] ?? (n as any).props?.[propField])
        .filter((v: any) => v !== undefined && v !== null)
        .map(Number)
        .filter((v: any) => !isNaN(v))
      switch (aggFn) {
        case 'sum':
          row[alias] = values.reduce((a: number, b: number) => a + b, 0)
          break
        case 'avg':
          row[alias] = values.length ? values.reduce((a: number, b: number) => a + b, 0) / values.length : 0
          break
        case 'max':
          row[alias] = values.length ? Math.max(...values) : 0
          break
        case 'min':
          row[alias] = values.length ? Math.min(...values) : 0
          break
        default:
          row[alias] = 0
      }
    } else {
      row[alias] = 0
    }
    return [row]
  }

  // 预计算：allNodes 中所有 props key 的并集（包括嵌套 props 对象）
  // 以及 createNodes 原始 props
  const insertNodes = (plan.createNodes || []) as Array<{ alias: string; label: string | null; props: Record<string, unknown> | null }>
  const allPropKeys = new Set<string>()
  for (const node of allNodes) {
    for (const k of Object.keys(node)) {
      if (!k.startsWith('_')) allPropKeys.add(k)
    }
    const p = node['props'] as Record<string, unknown> | undefined
    if (p) { for (const k of Object.keys(p)) allPropKeys.add(k) }
  }

  const row: QueryRow = {}

  // ── Alias-scoped projection resolution ──
  // `RETURN a.num` projects a property of the MERGE/CREATE variable `a`, NOT an
  // arbitrary node's property.  When the query is DML-backed (MERGE/CREATE), the
  // seed nodes still sit at the FRONT of `allNodes`, so a naive first-match scan
  // (`for ... if (rc in node) break`) would read the seed's `num` (42) instead of
  // the freshly-created node's `num` (43).  Resolve the alias-declaring variable
  // first and prefer that node whenever `rc` maps to a `var.prop` expression.
  const aliasMap = plan.returnAliasMap as Record<string, string> | undefined
  const v2n = (allNodes as any).__varToNodeMap as Map<string, any> | undefined
  const _targetNodeFor = (rc: string): Record<string, unknown> | undefined => {
    if (!aliasMap) return undefined
    const expr = aliasMap[rc]
    if (!expr || !expr.includes('.')) return undefined
    const varName = expr.split('.')[0].trim()
    // Prefer the live binding table (MERGE match-or-create binds the alias to
    // either the reused or the freshly-created node).
    if (v2n?.has(varName)) return v2n.get(varName)
    // Fall back to `_alias` tagging on the freshly created node (which sits at
    // the tail of allNodes; scan backwards so it wins over a same-named seed).
    for (let i = allNodes.length - 1; i >= 0; i--) {
      if ((allNodes[i] as any)._alias === varName) return allNodes[i]
    }
    return undefined
  }

  for (const rc of plan.returnColumns) {
    if (!rc) continue

    // Alias-scoped projection: resolve against the variable's node first.
    const targetNode = _targetNodeFor(rc)
    if (targetNode) {
      const tProps = (targetNode as any).props && typeof (targetNode as any).props === 'object'
        ? (targetNode as any).props
        : targetNode
      const propName = (aliasMap![rc] || '').split('.').pop()!
      let tVal: unknown = (targetNode as any)[propName]
      if (tVal === undefined && tProps && typeof tProps === 'object') tVal = tProps[propName]
      tVal = (tVal && typeof tVal === 'object' && 'value' in tVal) ? (tVal as any).value : tVal
      if (tVal !== undefined) { row[rc] = tVal; continue }
    }

    // 阶段 1: rc 作为属性名，直接匹配 node 顶层（allNodes 的 props 已展开到顶层）
    let val: unknown = undefined
    for (const node of allNodes) {
      if (rc in node) { val = node[rc]; break }
      const p = node['props'] as Record<string, unknown> | undefined
      if (p && rc in p) { val = p[rc]; break }
    }
    if (val !== undefined) { row[rc] = val; continue }

    // 阶段 2: rc 匹配 createNodes 的 alias（RETURN n）
    const matchNode = insertNodes.find(cn => cn.alias === rc)
    if (matchNode) {
      // A bound-variable reference (`WITH n AS a` then `CREATE (a) ... RETURN a`)
      // has no label/props of its own; the alias points at a pre-existing node.
      // Resolve through the binding table first (supports several aliases naming
      // the same node), then through `_alias`, else fall back to a placeholder.
      if (!matchNode.label && (!matchNode.props || !Object.keys(matchNode.props).length)) {
        const v2n = (allNodes as any).__varToNodeMap as Map<string, any> | undefined
        let boundNode = v2n?.get(rc)
        if (!boundNode) boundNode = allNodes.find(n => (n as any)._alias === rc)
        if (boundNode) { row[rc] = boundNode; continue }
      }
      const clean: Record<string, unknown> = {}
      if (matchNode.props) {
        for (const [k, v] of Object.entries(matchNode.props)) clean[k] = v
      }
      row[rc] = Object.keys(clean).length ? clean : { _label: matchNode.label || 'Default' }
      continue
    }

    // 阶段 3: rc 是属性别名（RETURN n.name AS p）— 用 returnAliasMap 反向解析
    if (aliasMap && rc in aliasMap) {
      const expr = aliasMap[rc]  // 原始表达式如 "n.name"
      // Dynamic property access (n['nam' + 'e']) and parameterized lookup
      // (n[$idx]) carry no `.` separator, so a naive prop-name split cannot
      // resolve them. Route those (and any non-`n.prop` expression) through the
      // expression engine with the created node's props in scope.
      // Relationship path functions (`startNode(r).id`, `endNode(r).prop`,
      // `type(r)`) also carry a `.` in their *argument identity* but must NOT be
      // reduced to a naive `.prop` split — the leading `startNode(r)`/`endNode(r)`
      // is a function call whose result node is then property-accessed.  Detect
      // those (and any other function-call expression) so the expression engine
      // resolves the whole thing, with the bound relationship variables (`r`)
      // injected from `__relVarMap`.
      const _relFnExpr = /^(startnode|endnode|nodes|relationships)\s*\(/i.test(expr)
      // Relationship variable property access (`RETURN t2.name` after
      // `MERGE ...-[t2:T {name: ... }]->...`).  The variable `t2` binds an edge
      // object in `__relVarMap`, not a node, so the property must be read from
      // that edge object rather than scanned from `allNodes`.
      if (expr.includes('.')) {
        const relVarMapHere = (allNodes as any).__relVarMap as Map<string, Record<string, unknown>> | undefined
        const relVarName = expr.split('.')[0].trim()
        if (relVarMapHere?.has(relVarName)) {
          const edgeObj = relVarMapHere.get(relVarName)!
          const rprop = expr.split('.').slice(1).join('.').trim()
          let rval: unknown = (edgeObj as any)[rprop]
          if (rval === undefined && edgeObj.props && typeof edgeObj.props === 'object') {
            rval = (edgeObj.props as any)[rprop]
          }
          if (rval !== undefined) { row[rc] = rval; continue }
        }
      }
      if (!expr.includes('.') || _relFnExpr) {
        const varCtx: Record<string, unknown> = {}
        for (const node of allNodes) {
          const p = (node['props'] as Record<string, unknown>) || node
          for (const [k, v] of Object.entries(p)) {
            if (!k.startsWith('_')) varCtx[k] = v as unknown
          }
        }
        // Bind each created node by alias too (n -> its props).
        for (const cn of insertNodes) {
          if (cn.alias) {
            // Prefer the LIVE node (with any ON CREATE/ON MATCH SET side effects,
            // e.g. an appended label) over the raw template, so `labels(a)`
            // reflects the post-set `_label` (`TheLabel:Foo`).
            const live = allNodes.find((n: any) => (n as any)._alias === cn.alias)
            if (live) {
              varCtx[cn.alias] = live
              continue
            }
            const clean: Record<string, unknown> = {}
            if (cn.props) for (const [k, v] of Object.entries(cn.props)) {
              clean[k] = (v && (v as any).value !== undefined) ? (v as any).value : v
            }
            if (cn.label) clean['_label'] = cn.label
            varCtx[cn.alias] = clean
          }
        }
        // Bind relationship variables created by relationship MERGE (`r`), so
        // `startNode(r)` / `endNode(r)` / `type(r)` resolve their edge object.
        const relVarMap = (allNodes as any).__relVarMap as Map<string, unknown> | undefined
        if (relVarMap) for (const [rv, ro] of relVarMap.entries()) varCtx[rv] = ro
        // Parameters ($idx) are resolved by the expression engine; inject them
        // from plan.parameters if present.
        const params = (plan as any).parameters || {}
        for (const [k, v] of Object.entries(params)) varCtx[k] = v
        try {
          const dynVal = _evaluateExpression(expr, varCtx)
          if (dynVal !== undefined && dynVal !== null) { row[rc] = dynVal; continue }
        } catch (_e) { /* fall through to property split below */ }
      }
      const propPart = expr.includes('.') ? expr.split('.').pop()! : expr
      // 遍历所有节点找 propPart
      let aliasVal: unknown = undefined
      for (const node of allNodes) {
        if (propPart in node) { aliasVal = node[propPart]; break }
        const p = node['props'] as Record<string, unknown> | undefined
        if (p && propPart in p) { aliasVal = p[propPart]; break }
      }
      if (aliasVal !== undefined) { row[rc] = aliasVal; continue }
    }

    // 阶段 4: 检查 rc 在 allPropKeys 中——如果在但没匹配到，是 null property
    if (!allPropKeys.has(rc)) {
      // 阶段 4b: 检查 createEdges 的属性（如 RETURN r.num AS num）
      const aliasMap = plan.returnAliasMap as Record<string, string> | undefined
      if (aliasMap && rc in aliasMap) {
        const expr = aliasMap[rc]
        const propPart = expr.includes('.') ? expr.split('.').pop()! : expr
        const edgeVar = expr.includes('.') ? expr.split('.')[0] : ''
        // 在 createEdges 中找匹配的边变量 alias 或序号
        for (const edge of plan.createEdges || []) {
          const edgeProps = edge.props as Record<string, unknown> | undefined
          if (edgeProps && propPart in edgeProps) {
            row[rc] = edgeProps[propPart]
            break
          }
        }
        if (rc in row) continue
      }
      // rc 是纯别名且无法映射——尝试函数调用表达式（如 labels(node)）
      const fnCall = rc.match(/^(\w+)\((.+)\)$/)
      if (fnCall) {
        const varCtx: Record<string, unknown> = {}
        for (const cn of insertNodes) {
          if (cn.alias) {
            // Prefer the LIVE node from allNodes (which carries any ON CREATE /
            // ON MATCH SET side effects, e.g. an appended label or a SET property)
            // over the raw createNode template.  `labels(a)` must reflect the
            // post-SET `_label` (`TheLabel:Foo`), not the template's `TheLabel`.
            let live = allNodes.find((n: any) => n._alias === cn.alias)
            if (!live) live = (allNodes as any).__varToNodeMap?.get(cn.alias)
            if (live) {
              varCtx[cn.alias] = live
            } else {
              const clean: Record<string, unknown> = {}
              if (cn.props) Object.assign(clean, cn.props)
              if (cn.label) clean['_label'] = cn.label
              varCtx[cn.alias] = clean
            }
          }
        }
        try {
          const fnResult = _evaluateExpression(rc, varCtx)
          if (fnResult !== undefined) { row[rc] = fnResult; continue }
        } catch (e: any) {} // function call may fail for invalid args
      }
      row[rc] = null
      continue
    }
    row[rc] = null
  }

  // ── Relationship-MERGE DELETE fan-out ──
  // `MATCH (a)-[t:T]->(b) DELETE t MERGE (a)-[t2:T {name:'rel3'}]->(b)
  //  RETURN t2.name` matched N T edges, deleted them, then merged a single fresh
  // edge.  It must still return one row per originally-matched edge (N rows, all
  // projecting the same merged `t2.name`).  Relationship MERGE has no scanLabel,
  // so the node fan-out above is bypassed; expand the single projected row to the
  // preserved pre-delete cardinality here.
  const _relFanOutCount = (allNodes as any).__matchFanOutCount as number | undefined
  if (_relFanOutCount && _relFanOutCount > 1 && (_mergeEdges?.length && !(plan as any).multiMatch?.length) && !plan.aggregate) {
    const base = Object.keys(row).length ? [row] : []
    if (base.length) {
      const expanded: QueryRow[] = []
      for (let fi = 0; fi < _relFanOutCount; fi++) expanded.push({ ...base[0] })
      return expanded
    }
  }

  return Object.keys(row).length ? [row] : []
}

/**
 * Apply `WITH ... WHERE <cond>` filters (carried on `plan.with.filters`) to the
 * freshly-built DML rows.  Each row is paired with its backing node (the node
 * that spawned it) so a filter expression such as `n.num % 2 = 0` can be
 * evaluated against the node's properties.  FilterClauses with an `expression`
 * (arithmetic/composite left-hand side) are evaluated via `_evaluateExpression`;
 * plain `source.property` filters compare directly.
 */
function _applyWithFilters(
  rows: QueryRow[],
  backingNodes: Array<Record<string, unknown>>,
  plan: QueryPlan,
): QueryRow[] {
  const filters = (plan.with?.filters || []) as Array<{
    source?: string
    property?: string
    operator?: string
    value?: unknown
    expression?: string
    negated?: boolean
  }>
  if (!filters.length) return rows

  const matches = (row: QueryRow, node: Record<string, unknown>, f: typeof filters[number]): boolean => {
    let lhs: unknown
    if (f.expression) {
      // Composite/arithmetic left-hand side: evaluate against the node, with the
      // node's own properties (and itself) in scope.
      const ctx: Record<string, unknown> = {}
      const src = (node as any).props && typeof (node as any).props === 'object' ? (node as any).props : node
      for (const [k, v] of Object.entries(src)) if (!k.startsWith('_')) ctx[k] = v
      // Bind the node by its alias (and by every createNode alias pointing at it).
      const alias = (node as any)._alias
      if (alias) ctx[alias] = node
      for (const cn of plan.createNodes || []) {
        const cnAlias = (cn as any).alias
        if (cnAlias && (node as any)._alias === cnAlias) ctx[cnAlias] = node
      }
      // Fall back: if the expression's root variable is not yet bound, bind every
      // createNode alias to this node (single-node-per-row semantics).
      const rootVar = f.expression.match(/^[a-zA-Z_]\w*/)?.[0]
      if (rootVar && !(rootVar in ctx)) ctx[rootVar] = node
      try {
        lhs = _evaluateExpression(f.expression, ctx)
      } catch {
        return false
      }
    } else {
      const src = (node as any).props && typeof (node as any).props === 'object' ? (node as any).props : node
      lhs = (node as any)[f.property!] ?? (src as any)?.[f.property!]
    }
    const rhs = f.value
    const op = f.operator || 'EQ'
    let matched: boolean
    switch (op) {
      case 'EQ': matched = lhs === rhs; break
      case 'NEQ': matched = lhs !== rhs; break
      case 'GT': matched = (lhs as number) > (rhs as number); break
      case 'GTE': matched = (lhs as number) >= (rhs as number); break
      case 'LT': matched = (lhs as number) < (rhs as number); break
      case 'LTE': matched = (lhs as number) <= (rhs as number); break
      default: matched = false
    }
    return f.negated ? !matched : matched
  }

  const result: QueryRow[] = []
  for (let i = 0; i < rows.length; i++) {
    const node = backingNodes[i] || {}
    let keep = true
    for (const f of filters) {
      if (!matches(rows[i], node, f)) { keep = false; break }
    }
    if (keep) result.push(rows[i])
  }
  return result
}

/**
 * Apply `WITH ... WHERE` filters to relationship rows.  Each row is paired with
 * its backing relationship payload (an `__createEdges` entry: `{props, label}`),
 * and the relationship variable is bound so `r.num % 2 = 0` evaluates correctly.
 */
function _applyEdgeWithFilters(
  rows: QueryRow[],
  edges: Array<{ props?: Record<string, unknown>; [k: string]: unknown }>,
  plan: QueryPlan,
): QueryRow[] {
  const filters = (plan.with?.filters || []) as Array<{
    expression?: string
    operator?: string
    value?: unknown
    negated?: boolean
  }>
  if (!filters.length) return rows

  const result: QueryRow[] = []
  for (let i = 0; i < rows.length; i++) {
    const edge = edges[i] || {}
    const edgeProps = edge.props || {}
    let keep = true
    for (const f of filters) {
      if (!f.expression) continue
      // Bind the relationship variable (the expression's root identifier) to the
      // flat edge-property map, and also expose each property as a bare key.
      const rootVar = f.expression.match(/^[a-zA-Z_]\w*/)?.[0]
      const ctx: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(edgeProps)) ctx[k] = v
      if (rootVar) ctx[rootVar] = edgeProps
      let lhs: unknown
      try {
        lhs = _evaluateExpression(f.expression, ctx)
      } catch {
        keep = false
        break
      }
      const op = f.operator || 'EQ'
      let matched: boolean
      switch (op) {
        case 'EQ': matched = lhs === f.value; break
        case 'NEQ': matched = lhs !== f.value; break
        case 'GT': matched = (lhs as number) > (f.value as number); break
        case 'GTE': matched = (lhs as number) >= (f.value as number); break
        case 'LT': matched = (lhs as number) < (f.value as number); break
        case 'LTE': matched = (lhs as number) <= (f.value as number); break
        default: matched = false
      }
      if (f.negated ? matched : !matched) { keep = false; break }
    }
    if (keep) result.push(rows[i])
  }
  return result
}

export { _buildDmlRows }