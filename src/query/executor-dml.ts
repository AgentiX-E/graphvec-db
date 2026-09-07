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
      const alias = agg.alias || agg.column?.replace(/^.+?\(.+?\)(?:\s+AS\s+)?/i, '').trim() || propField || 'c'
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
    return rows
  }


  // 聚合 DML：如 RETURN count(*)
  if (plan.aggregate) {
    const row: QueryRow = {}
    const agg = plan.aggregate as any
    const alias = agg.alias || agg.column?.replace(/^.+?\(.+?\)(?:\s+AS\s+)?/i, '').trim() || agg.field || 'c'
    // 支持 count/sum/avg/min/max——从 allNodes 提取属性值做聚合
    const propField = agg.field || agg.property || ''
    if (agg.fn === 'count') {
      row[alias] = allNodes.length
    } else if (propField) {
      const values = allNodes
        .map(n => n[propField] ?? (n as any).props?.[propField])
        .filter((v: any) => v !== undefined && v !== null)
        .map(Number)
        .filter((v: any) => !isNaN(v))
      switch (agg.fn) {
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

  for (const rc of plan.returnColumns) {
    if (!rc) continue

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
      const clean: Record<string, unknown> = {}
      if (matchNode.props) {
        for (const [k, v] of Object.entries(matchNode.props)) clean[k] = v
      }
      row[rc] = Object.keys(clean).length ? clean : { _label: matchNode.label || 'Default' }
      continue
    }

    // 阶段 3: rc 是属性别名（RETURN n.name AS p）— 用 returnAliasMap 反向解析
    const aliasMap = plan.returnAliasMap as Record<string, string> | undefined
    if (aliasMap && rc in aliasMap) {
      const expr = aliasMap[rc]  // 原始表达式如 "n.name"
      // Dynamic property access (n['nam' + 'e']) and parameterized lookup
      // (n[$idx]) carry no `.` separator, so a naive prop-name split cannot
      // resolve them. Route those (and any non-`n.prop` expression) through the
      // expression engine with the created node's props in scope.
      if (!expr.includes('.')) {
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
            const clean: Record<string, unknown> = {}
            if (cn.props) for (const [k, v] of Object.entries(cn.props)) {
              clean[k] = (v && (v as any).value !== undefined) ? (v as any).value : v
            }
            if (cn.label) clean['_label'] = cn.label
            varCtx[cn.alias] = clean
          }
        }
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
            const clean: Record<string, unknown> = {}
            if (cn.props) Object.assign(clean, cn.props)
            if (cn.label) clean['_label'] = cn.label
            varCtx[cn.alias] = clean
          }
        }
        try {
          const fnResult = _evaluateExpression(rc, varCtx)
          if (fnResult !== undefined) { row[rc] = fnResult; continue }
        } catch (e: any) {} // function call may fail for invalid args
      }
      row[rc] = ''
      continue
    }
    row[rc] = ''
  }

  return Object.keys(row).length ? [row] : []
}

export { _buildDmlRows }
