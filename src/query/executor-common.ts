/**
 * executor-common.ts — 执行器共享工具函数
 *
 * 从 query-executor.ts 拆分。
 */

import { executeVarLenPath } from './var-length-path'
import type { QueryPlan, QueryRow } from './query-types'
import { _makeUniqueKey } from './query-parser'
import { _evaluateExpression, _extractDurationProp } from './expression-engine'

function _executeVarLenPath(plan: QueryPlan, nodes: Array<Record<string, unknown>>): QueryRow[] {
  return executeVarLenPath(plan, nodes)
}


function parseCsvContent(content: string, options: { headers: boolean; delimiter: string; as: string }): any[] {
  const lines = content.split(/\r?\n/).filter((l: string) => l.trim() !== '')
  if (lines.length === 0) return []

  const delimiter = options.delimiter
  const headerLine = options.headers ? lines.shift() : null
  const headers = headerLine ? splitCsvLine(headerLine, delimiter) : null

  return lines.map((line: string) => {
    const fields = splitCsvLine(line, delimiter)
    if (options.headers && headers) {
      const obj: Record<string, string> = {}
      headers.forEach((h, i) => { obj[h] = fields[i] || '' })
      return { [options.as]: obj }
    } else {
      return { [options.as]: fields }
    }
  })
}


function splitCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      // 检查是否转义引号（"" → "）
      if (i + 1 < line.length && line[i + 1] === '"') {
        current += '"'
        i++ // skip next
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === delimiter && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current.trim())
  return result
}


function _deepStripInternal(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(_deepStripInternal)
  if (obj && typeof obj === 'object') {
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      // Strip `_alias` and `__`-prefixed internal properties, keeping `_label`
      // (toNodeNotation needs it).  Exception: preserve `__path`/`__pathEdges`
      // (the internal path-object representation) which the serialization layer
      // renders as TCK path notation <(:A)-[:T]->(:B)>, `__fullLabel` /
      // `_fullLabel` (the full multi-label set, e.g. `A:B:C`), and the edge
      // markers `__edgeLabel` / `__edgeLabelStr` so a relationship still renders
      // as `[:T1]` instead of collapsing to a bare property bag.
      if (k === '_alias' || (k.startsWith('__') && k !== '__path' && k !== '__pathEdges' && k !== '__fullLabel' && k !== '__edgeLabel' && k !== '__edgeLabelStr' && k !== '__float')) continue
      clean[k] = _deepStripInternal(v)
    }
    return clean
  }
  return obj
}


function _formatResultRow(r: any, plan: QueryPlan): QueryRow {
  const row: QueryRow = {}
  // expressionColumns 序号索引（用于拆解后的 returnColumns 列变量恢复）
  let _ecColIdx = 0

  // GE 返回格式：{ props: { _label, _alias, name, p, ... } }
  // 过滤内部属性（以 _ 开头）以保持 TCK 兼容性，避免出现 _alias 等内部字段
  // 但保留 _label（toNodeNotation 需要它来识别节点类型）
  if (r.props) {
    for (const k of Object.keys(r.props)) {
      if (k === '_alias' || k.startsWith('__')) continue
      row[k] = r.props[k]
    }
    // Multi-hop (__multiStep) rows stash the *correct* per-step variable bindings
    // under `_allVars` (e.g. {a:A, b:B, c:C}).  It may live on `r.props` or
    // `r.__targetProps`.  Promote those bindings to the top-level row so
    // downstream `rc in row` lookups and varCtx construction resolve each RETURN
    // variable to its true node instead of a stale/mis-attributed value.  Skip
    // keys already set on `row` (explicit props win).
    const allVars = (r.props as any)._allVars || (r.__targetProps as any)?._allVars
    if (allVars && typeof allVars === 'object' && !Array.isArray(allVars)) {
      for (const vn of Object.keys(allVars)) {
        if (vn.startsWith('_')) continue
        if (!(vn in row)) row[vn] = allVars[vn]
      }
    }
  }
  
  const aliasMap = plan.returnAliasMap as Record<string, string> | undefined

  // 当 expressionColumns 存在时，使用它们而非 returnColumns（括号嵌套导致 returnColumns 被截断）
  const ret = plan.expressionColumns?.length
    ? plan.expressionColumns.map((ec: any) => (typeof ec === 'string' ? ec : ec.alias || ec.expression))
    : plan.returnColumns
  if (!ret?.length) {
    // RETURN *：返回所有在作用域内的变量
    if (plan.type === 'QUERY' && !plan.aggregate && !ret?.some((rc: string) => /^\w+\(/.test(rc))) {
      // A WITH projection narrows the scope: after `WITH a.name AS name`, the
      // MATCH variable `a` is no longer in scope and `RETURN *` must emit the
      // projected columns (`name`), not the raw MATCH variable.  `row` was built
      // from `r.props` above and already carries the projected aliases.
      const withCols = (plan.with?.columns || []).filter((c: any) => {
        const e = typeof c === 'object' ? c.expression : c
        return e !== '*' && !/^\s*(count|sum|avg|max|min|collect)\s*\(/i.test(String(e))
      })
      if (withCols.length) {
        const result: QueryRow = {}
        for (const wc of withCols) {
          const alias = wc.alias || null
          if (!alias) continue
          if (alias in row) result[alias] = row[alias]
        }
        if (Object.keys(result).length) return result
      }
      const result: QueryRow = {}
      // Prefer the full per-variable bindings stashed on `r.__crossVarRows`.
      // These carry every step's node variable (e.g. a, b, c) plus each edge
      // variable (e.g. r1, r2 as `{__edgeLabel:'R1', _type:'R1'}`).  Return the
      // raw objects (nodes as `{_label:'A'}`, edges as `{__edgeLabel:'R1'}`) so
      // the serialization layer (normalizeActual → toNodeNotation /
      // _toEdgeNotation) formats them into `(:A)` / `[:R1]`.  Hand-stringifying
      // them here would break the edge markers and lose variables entirely.
      if (r.__crossVarRows && typeof r.__crossVarRows === 'object') {
        for (const [vn, vval] of Object.entries(r.__crossVarRows)) {
          if (vn.startsWith('_')) continue
          const v = vval as Record<string, unknown>
          if (v && typeof v === 'object') {
            // Edge variable: keep the __edgeLabel/_type markers verbatim.
            if ('__edgeLabel' in v || '_type' in v) {
              result[vn] = v
              continue
            }
            // Node variable: unwrap the `props` wrapper and keep _label so the
            // serializer can emit `(:Label)`. Strip internal helper keys.
            const clean: Record<string, unknown> = {}
            const src = (v.props && typeof v.props === 'object') ? (v.props as Record<string, unknown>) : v
            for (const [k, vv] of Object.entries(src)) {
              if (k.startsWith('__') || k === 'props' || k === '_alias') continue
              clean[k] = vv
            }
            result[vn] = clean
          }
        }
        if (Object.keys(result).length) return result
      }
      // Fallback: legacy __targetPropsMap / source-node formatting (single-step
      // patterns without __crossVarRows).
      if (r.__targetPropsMap) {
        for (const vn of Object.keys(r.__targetPropsMap)) {
          const nodeData = r.__targetPropsMap[vn]
          if (nodeData && typeof nodeData === 'object' && '_label' in nodeData) {
            const label = (nodeData as any)._label
            result[vn] = label ? `(${label.startsWith(':') ? label : ':' + label})` : '()'
          } else if (nodeData && typeof nodeData === 'object' && '__edgeLabel' in nodeData) {
            result[vn] = nodeData
          }
        }
      }
      if (Object.keys(result).length) return result
      return row
    }
    return row
  }

  // expressionColumns 模式下从 ec map 找原始表达式
  const ecMap: Record<string, string> = {}
  if (plan.expressionColumns?.length) {
    for (const ec of plan.expressionColumns) {
      ecMap[ec.alias || ec.expression] = ec.expression
    }
  } else if (plan.returnAliasMap) {
    for (const [rawKey, rawExpr] of Object.entries(plan.returnAliasMap)) {
      if (rawExpr !== rawKey) {
        ecMap[rawKey] = rawExpr
      }
    }
  }
  // DEBUG
  // 构造输出行，每列正确映射
  const result: QueryRow = {}
  // When row contains keys not in ret (e.g. aggregation aliases from WITH
  // pipelines), include them so _formatResultRow doesn't silently drop them.
  const extraColumns = Object.keys(row).filter(k => !k.startsWith('_') && !ret.includes(k))
  for (const k of extraColumns) { ret.push(k) }
  // DEBUG
  for (const rc of ret) {
    if (!rc) continue

    // ── Path variable override ──
    // When rc is a path variable (MATCH p = (n)-->()), evaluate the
    // corresponding list comprehension expression directly so that
    // collect(p) / head(nodes(x)) can resolve against the path object.
    const isPathVar = rc && plan.steps?.some(s => s.pathVariable === rc)
    if (isPathVar && ecMap[rc] && ecMap[rc] !== rc) {
      // Build varCtx with the path object from r.props[rc]
      const localCtx: Record<string, unknown> = {}
      for (const k of Object.keys(row)) {
        if (!k.startsWith('__')) localCtx[k] = row[k]
      }
      // When the path variable value is a pre-aggregated array (from executor),
      // replace collect(p) with p directly in the expression so the list
      // comprehension operates on the full array.
      const pvVal = (r as any).props?.[rc]
      if (pvVal && typeof pvVal === 'object' && Array.isArray(pvVal) && pvVal.length > 1) {
        const adjustedExpr = ecMap[rc].replace(new RegExp(`collect\\s*\\(\\s*${rc}\\s*\\)`, 'gi'), rc)
        const evalCtx: Record<string, unknown> = { [rc]: pvVal }
        const evalResult = _evaluateExpression(adjustedExpr, evalCtx)
        if (evalResult !== null && evalResult !== undefined) {
          if (evalResult && typeof evalResult === 'object') {
            result[rc] = _deepStripInternal(evalResult)
          } else {
            result[rc] = evalResult
          }
          continue
        }
      }
      if (r.__targetProps) {
        for (const [k, v] of Object.entries(r.__targetProps)) {
          if (!k.startsWith('__') && !(k in localCtx)) localCtx[k] = v
        }
      }
      const evalResult = _evaluateExpression(ecMap[rc], localCtx)
      if (evalResult !== null && evalResult !== undefined) {
        if (evalResult && typeof evalResult === 'object') {
          result[rc] = _deepStripInternal(evalResult)
        } else {
          result[rc] = evalResult
        }
        continue
      }
    }

    // ── Expression column evaluation (non-path-variable) ──
    // When rc has an associated expression (e.g. "size([(n)--() | 1]) > 0 AS b"),
    // evaluate it via the expression engine before falling through to raw value.
    // Also evaluate when rc itself is a computed expression (function call like
    // labels(m)/count(b), or a binary comparison like p1 = p2) even when the
    // alias equals the expression text (ecMap[rc] === rc). A pure identifier or
    // property access (n, n.name) is a plain value and needs no evaluation.
    const _isComputedExpr = /^[a-zA-Z_]\w*\s*\(/.test(rc) || /[+*/<>=!]|\s+(?:IN|AND|OR|XOR|IS\s+NULL|IS\s+NOT\s+NULL)\s+/i.test(rc)
    if (!isPathVar && ecMap[rc] && (ecMap[rc] !== rc || _isComputedExpr)) {
      // Only evaluate if row value is an edge-format placeholder ([:...])
      // or undefined. If already pre-computed (boolean, number, object), skip.
      const rowVal = row[rc]
      const fnMatch = ecMap[rc].match(/^([a-zA-Z_]\w*)\s*\(/);
      const isFnCall = !!fnMatch && /size|length|head|nodes|labels|collect|count|sum|avg|min|max|coalesce|toLower|toUpper|type|exists|id|all|any|none|single|reduce|reverse|tail|left|right|split|replace|substring|trim|ltrim|rtrim|toString|toInteger|toFloat|toBoolean|keys|properties|startNode|endNode|range|abs|sqrt|ceil|floor|round|sign|rand|pi|sin|cos|tan|asin|acos|atan|degrees|radians|log|log10|exp|e|haversin|percentiledisc|percentilecont/i.test(fnMatch[1])
      // An aliased function call such as `toInteger(n.name) AS name` collides
      // with a same-named node property: `row['name']` holds the raw property
      // value ('42', a string), not the function result (42, a number). When the
      // alias shadows a property, the expression must be evaluated and override
      // the stale property value. Detect this by checking whether the row value
      // is a plain string that does NOT already equal the evaluated result —
      // the safe discriminator is: a bare string value is a property shadow, so
      // a function-call alias must always re-evaluate over it.
      // A literal expression (e.g. `RETURN 42 AS num`) must also always be
      // evaluated: it never depends on the row, but its alias may collide with
      // a node property (here `num`), in which case the raw property value would
      // otherwise leak through as the result column.
      const isLiteralExpr = /^[-+]?\d+(\.\d+)?$|^'(?:[^']|'')*'$|^"(?:[^"]|"")*"$|^(?:true|false|null)$/i.test(ecMap[rc] ?? '')
      const needsEval = isLiteralExpr || rowVal === undefined || rowVal === null
        || (typeof rowVal === 'string' && (rowVal.startsWith('[:') || (isFnCall && ecMap[rc] !== rc)))
      if (needsEval) {
      // Non-function computed expressions (binary comparisons like `p1 = p2`,
      // arithmetic like `a + b`) are also valid and must be evaluated.
      const isBinaryExpr = !isFnCall && (ecMap[rc] !== rc || /[+*/<>=!]/.test(ecMap[rc]))
      if (isFnCall || isBinaryExpr) {
        const localCtx: Record<string, unknown> = {};
        for (const k of Object.keys(row)) {
          if (!k.startsWith('__')) localCtx[k] = row[k];
        }
        // Inject cross-variable row context (e.g. n for pattern comprehension)
        if (r.__crossVarRows) {
          for (const [varName, varNode] of Object.entries(r.__crossVarRows)) {
            localCtx[varName] = varNode as Record<string, unknown>;
          }
        }
        try {
          const evalResult = _evaluateExpression(ecMap[rc], localCtx);
          if (evalResult !== null && evalResult !== undefined) {
            if (evalResult && typeof evalResult === 'object') {
              result[rc] = _deepStripInternal(evalResult);
            } else {
              result[rc] = evalResult;
            }
            continue;
          }
        } catch (_e: any) {
          // Percentile range errors are semantic (not a fall-through signal):
          // percentileDisc/percentileCont with p < 0 or p > 1 must surface as a
          // runtime ArgumentError (NumberOutOfRange), never be silently dropped.
          if (_e?.tckError === 'NumberOutOfRange') throw _e
          /* fall through to raw value for other transient eval failures */
        }
        } // if (isFnCall || isBinaryExpr)
      } // if (needsEval)
    } // expression column eval

        // ── 解析 "a.id" → { variable: "a", property: "id" } ──
    const propMatch = rc.match(/^(\w+)\.(\w+)$/)
    if (propMatch) {
      const variable = propMatch[1]
      const property = propMatch[2]
      // 区分 source 变量和 target 变量
      // 当 source 回溯后，r.props 是 source 节点属性，r.__targetProps 是 target 节点属性
      // 如果 variable 与 firstStep.source 匹配 → 从 r.props 取（source）
      // 否则 → 从 r.__targetProps 取（target，如 b.id）
      // 边变量属性：如 r.weight → 从 r.__edgeProps 取
      if (r.__edgeProps && property in r.__edgeProps) {
        result[rc] = r.__edgeProps[property]
        continue
      }
      // 无边多变量 MATCH: 从 __crossVarRows 中查找变量节点属性
      // 用于 MATCH (dur:Label1), (dur2: Label2) RETURN dur.date + dur2.date 等场景
      if (r.__crossVarRows && variable in r.__crossVarRows) {
        const crossNode = r.__crossVarRows[variable]
        if (crossNode && typeof crossNode === 'object' && property in crossNode) {
          result[rc] = (crossNode as Record<string, unknown>)[property]
          continue
        }
      }
      const firstStepSource = plan.steps?.[0]?.source
      const isSourceVar = firstStepSource && variable === firstStepSource
      if (isSourceVar && r.props && property in r.props) {
        result[rc] = r.props[property]
      } else if (!isSourceVar && r.__targetPropsMap && variable in r.__targetPropsMap) {
        // 中间步变量属性（如 b.name 在 MATCH (a)-[:R1]->(b)-[:R2]->(c) 中）
        // 从 __targetPropsMap 取该变量的节点属性
        const midNode = r.__targetPropsMap[variable]
        result[rc] = midNode && property in midNode ? midNode[property] : null
      } else if (r.__targetProps && property in r.__targetProps) {
        // 当 isSourceVar（如 RETURN i.var）但 r.props（source 节点）不含该属性时，
        // 回退到 __targetProps（target 节点，如 Child 的 var 属性）
        result[rc] = r.__targetProps[property]
      } else if (r.props && property in r.props) {
        result[rc] = r.props[property]
      } else if (property in row) {
        result[rc] = row[property]
      } else if (row[variable] && typeof row[variable] === 'string' && /^P/i.test(row[variable] as string)) {
        // ISO duration 字符串属性访问（如 dur.days 中 dur='PT22H'）
        result[rc] = _extractDurationProp(row[variable] as string, property)
      } else {
        result[rc] = null
      }
      continue
    }

    // ── 对拆解后的 returnColumns 做变量-属性恢复 ──
    // returnColumns 已被 query-parser 拆解（b.name → name），
    // 用 expressionColumns 的原始表达式恢复变量名，从 __crossVarRows 取值
    // 必须在 (rc in row) 之前执行，防止 id 等拆后属性误从 row 取值
    let resolved = false
    if (plan.expressionColumns?.length) {
      const ecIdx = _ecColIdx++
      if (ecIdx < plan.expressionColumns.length) {
        const ec = plan.expressionColumns[ecIdx]
        const origExpr = ec.expression || ''
        const propMatch2 = origExpr.match(/^(\w+)\.(\w+)$/)
        if (propMatch2 && r.__crossVarRows) {
          const variable = propMatch2[1]
          const property = propMatch2[2]
          const cvrNode = r.__crossVarRows[variable]
          // Use rc (the alias column name) when expressionColumns has an explicit AS,
          // otherwise use origExpr (e.g. "a.id") to preserve multi-variable column distinction.
          // When the same alias appears multiple times in returnColumns (e.g. RETURN a.id, b.id
          // both produce "id"), fall back to origExpr to avoid key collisions.
          const aliasCount = (plan.returnColumns || []).filter(c => c === rc).length
          const key = (ec.alias && ec.alias !== ec.expression && aliasCount <= 1) ? rc : origExpr
          if (cvrNode && typeof cvrNode === 'object' && property in cvrNode) {
            result[key] = (cvrNode as Record<string, unknown>)[property]
            resolved = true
          } else if (r.__targetProps && property in r.__targetProps) {
            result[key] = r.__targetProps[property]
            resolved = true
          }
        }
      }
    }
    if (resolved) continue

    // 判断 rc 是否直接出现在 GE 返回的 props 中
    // 但如果是函数调用表达式（被 GE Error当作属性赋值），跳过 GE 数据走函数求值
    // 聚合模式例外：聚合函数名如 count(*) 已在 GE 的 _execAggregation 中正确设为 props key
    // TODO: 更好的方法是统一 QE 和 GE 的聚合列名，避免走函数求值
    if ((rc in row)) {
      // 如果 row[rc] 是 "[:T]" 格式字符串但没有 props，而 __crossVarRows 有边属性，
      // 替换为带 props 的格式"[:T {name: 'bar'}]"
      if (typeof row[rc] === 'string' && row[rc].startsWith('[:') && !row[rc].includes('{') && r.__crossVarRows?.[rc]) {
        const edgeInfo = r.__crossVarRows[rc] as Record<string, unknown>
        const props: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(edgeInfo)) {
          if (!k.startsWith('_')) props[k] = v
        }
        const propKeys = Object.keys(props)
        if (propKeys.length) {
          const propStr = propKeys.map(k => {
            const v = props[k]
            if (typeof v === 'string') return `${k}: '${v}'`
            if (typeof v === 'number') return `${k}: ${v}`
            return `${k}: ${JSON.stringify(v)}`
          }).join(', ')
          const label = row[rc].replace(/^\[:/, '').replace(/\].*$/, '')
          result[rc] = `[:${label} {${propStr}}]`
          continue
        }
      }
      result[rc] = row[rc]
      continue
    }

    // 检查 rc 是否是节点变量名（RETURN n / RETURN m）
    // GE 返回的 r 本身可能包含节点数据
    if (r[rc] !== undefined) {
      // 如果是边变量（值是字符串 "[:T1]" 格式），直接输出
      if (typeof r[rc] === 'string' && r[rc].startsWith('[:')) {
        result[rc] = r[rc]
        continue
      }
      // 边变量：从 __crossVarRows 或 r[rc] 获取，格式化为 [:Label {prop: 'val'}]
      if (typeof r[rc] === 'object' && r[rc] !== null && '_label' in r[rc]) {
        const edgeObj = r[rc] as Record<string, unknown>
        const label = (edgeObj._label as string) || ''
        const propKeys = Object.keys(edgeObj).filter(k => !k.startsWith('_'))
        if (propKeys.length === 0) {
          result[rc] = label ? `[:${label}]` : '[:]'
        } else {
          const propStr = propKeys.map(k => {
            const v = edgeObj[k]
            if (typeof v === 'string') return `${k}: '${v}'`
            if (typeof v === 'number') return `${k}: ${v}`
            return `${k}: ${JSON.stringify(v)}`
          }).join(', ')
          result[rc] = label ? `[:${label} {${propStr}}]` : `[: {${propStr}}]`
        }
        continue
      }
      result[rc] = r[rc]
      continue
    }

    // ── 函数表达式（如 labels(m)、type(r)） ──
    // 必须在边变量 RETURN r 分支之前，避免 labels(m) 被误输出为 [:R]
    // 每当 rc 是函数调用表达式时，优先通过 _evaluateExpression 求值
    // 也支持 rc 是别名但 aliasMap 中对应当函数表达式（如 rc="l" → aliasMap["l"] = "labels(...)"）
    const aliasMap = plan.returnAliasMap as Record<string, string> | undefined
    let fnExpr: string | null = null
    if (rc.match(/^\w+\(/)) {
      fnExpr = rc.replace(/\s+AS\s+\w+(?:\s*\([^)]*\))?\s*$/i, '').trim()
    } else if (aliasMap && rc in aliasMap && aliasMap[rc].match(/^\w+\(/)) {
      fnExpr = aliasMap[rc]
    }
    if (fnExpr) {
      const fnVarCtx: Record<string, unknown> = {}
      if (r.__crossVarRows) {
        for (const vn of Object.keys(r.__crossVarRows)) {
          fnVarCtx[vn] = r.__crossVarRows[vn]
        }

      }
      if (r.__targetPropsMap) {
        for (const vn of Object.keys(r.__targetPropsMap)) {
          if (!(vn in fnVarCtx)) fnVarCtx[vn] = r.__targetPropsMap[vn]
        }
      }
      // 补充变量名 → 节点数据映射：从 steps 推断变量引用关系
      if (plan.steps?.length && (r.__targetProps || r.__targetPropsMap)) {
        const steps = plan.steps as Array<{source: string; targetAlias: string}>
        for (const step of steps) {
          if (step.source && !(step.source in fnVarCtx) && r.props) {
            fnVarCtx[step.source] = r.props
          }
          if (step.targetAlias && !(step.targetAlias in fnVarCtx)) {
            if (r.__targetProps) {
              fnVarCtx[step.targetAlias] = r.__targetProps
            } else if (r.__targetPropsMap?.[step.targetAlias]) {
              fnVarCtx[step.targetAlias] = r.__targetPropsMap[step.targetAlias]
            } else if (r.props) {
              fnVarCtx[step.targetAlias] = r.props
            }
          }
        }
      }
      // 补充 row 中的属性到变量上下文
      for (const k of Object.keys(row)) {
        if (!(k in fnVarCtx)) fnVarCtx[k] = row[k]
      }
      // 尝试通过 _evaluateExpression 求值
      try {
        const fnResult = _evaluateExpression(fnExpr, fnVarCtx)
        if (fnResult !== null && fnResult !== undefined) {
          const cleaned = _deepStripInternal(fnResult)
          result[rc] = cleaned
          continue
        }
      } catch (e: any) {}
      // 回退：检查 rc 是否是别名（rc 本身可求值）
      try {
        const fnResult = _evaluateExpression(rc, fnVarCtx)
        if (fnResult !== null && fnResult !== undefined) {
          const cleaned = _deepStripInternal(fnResult)
          result[rc] = cleaned
          continue
        }
      } catch (e: any) {}
    }

    // ── 边变量 RETURN r ──
    // rc 是边变量名（如 RETURN r），输出 [:LABEL] / [:LABEL {prop: 'val'}]。
    // 边标签可能来自两个位置：
    //   1. 行顶层的 r.__edgeLabel（多步 cross-join / rawWithEdges 路径写入）；
    //   2. r.__crossVarRows[rc] 的 __edgeLabel / _type 标记（单步 hasEdgeStep
    //      的 multiStepRaw 路径，见 query-executor 的边变量绑定）。
    {
      const edgeInfo = r.__crossVarRows?.[rc]
      const edgeLabel = (r.__edgeLabel as string)
        || (edgeInfo && typeof edgeInfo === 'object'
          ? ((edgeInfo.__edgeLabel as string) || (edgeInfo._type as string) || (edgeInfo.__edgeLabelStr as string))
          : '')
      if (edgeLabel && !rc.match(/^\w+\(/)) {
        // 只在 rc 确实是 GE 记录的边变量时使用边标签（避免自环中节点被误输出为边格式）
        let isEdgeVar = false
        if (plan.returnColumns) {
          const nodeAliases = new Set([
            ...(plan.createNodes || []).map(n => n.alias).filter(Boolean),
            ...(plan.steps || []).flatMap(s => [s.source, s.targetAlias, s.pathVariable].filter(Boolean)),
            // OPTIONAL MATCH 步骤中的变量也视为节点别名（不是边变量）
            ...(plan.optionalMatchSteps || []).flatMap(om => {
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
          // Include scanLabel source alias (MATCH (n:Label) without TraverseStep)
          if (plan.scanLabel && plan.steps?.length === 0) {
            const q = ((plan as any)._originalQuery as string) || ''
            const scAlias = (q.match(/MATCH\s*\(\s*(\w+)\s*(?::\s*\w+\s*)?\)/i) || [])[1]
            if (scAlias) nodeAliases.add(scAlias)
          }
          isEdgeVar = !nodeAliases.has(rc)
        } else {
          isEdgeVar = typeof r[rc] === 'string' && r[rc].startsWith('[:')
        }
        if (isEdgeVar) {
          if (edgeInfo && typeof edgeInfo === 'object') {
            // Only surface *user* relationship properties.  Internal edge fields
            // (srcIdx / dstIdx / label / props) are bookkeeping and must never
            // leak into the `[:LABEL {prop: ...}]` rendering.
            const props: Record<string, unknown> = {}
            const _internalEdgeKeys = new Set(['srcIdx', 'dstIdx', 'label', 'props'])
            for (const [k, v] of Object.entries(edgeInfo)) {
              if (k.startsWith('_') || _internalEdgeKeys.has(k)) continue
              props[k] = v
            }
            const propKeys = Object.keys(props)
            if (propKeys.length === 0) {
              result[rc] = '[:' + edgeLabel + ']'
            } else {
              const propStr = propKeys.map(k => {
                const v = props[k]
                if (typeof v === 'string') return `${k}: '${v}'`
                if (typeof v === 'number') return `${k}: ${v}`
                return `${k}: ${JSON.stringify(v)}`
              }).join(', ')
              result[rc] = `[:${edgeLabel} {${propStr}}]`
            }
          } else {
            result[rc] = '[:' + edgeLabel + ']'
          }
          continue
        }
      }
    }

    // 使用 returnAliasMap 或 expressionColumns 解析原始表达式：统一走 _evaluateExpression
    let expr = (aliasMap && rc in aliasMap) ? aliasMap[rc] : (rc in ecMap ? ecMap[rc] : null)
    // ecMap takes precedence over aliasMap for expression columns (e.g. list comprehensions)
    if (ecMap[rc] && ecMap[rc] !== rc) {
      expr = ecMap[rc]
    }
    // If there is no expression mapping (empty aliasMap) but rc is a simple
    // variable name present in `row`, use rc itself as the expression. Note:
    // `varCtx` is not yet constructed here (it is declared below), so only
    // `row` can be tested; `row` already flattens every in-scope variable.
    if (expr === null && rc && /^[a-zA-Z_]\w*$/.test(rc) && rc in row) {
      expr = rc
    }
    if (expr !== null) {
      // 如果 row[rc] 已经是边格式 [:xxx]（由 rawWithEdges 填充），不要覆盖
      if (typeof row[rc] === 'string' && row[rc].startsWith('[:')) {
        result[rc] = row[rc]
        continue
      }
      // 构建变量上下文字典：从 r 的交叉变量表和 targetProps 中提取所有可用变量
      const varCtx: Record<string, unknown> = {}
      // 无边模式：从 __crossVarRows 构建
      if (r.__crossVarRows) {
        for (const vn of Object.keys(r.__crossVarRows)) {
          varCtx[vn] = r.__crossVarRows[vn]
        }
      }
      // WITH 生成的自定义变量（如 list、map）：也从 r.props 提取
      if (r.props && typeof r.props === 'object') {
        for (const k of Object.keys(r.props)) {
          if (!k.startsWith('_') && !(k in varCtx)) {
            varCtx[k] = r.props[k]
          }
        }
      }
      // 多步多 RETURN 变量：从 __targetPropsMap 构建
      if (r.__targetPropsMap) {
        for (const vn of Object.keys(r.__targetPropsMap)) {
          if (!(vn in varCtx)) varCtx[vn] = r.__targetPropsMap[vn]
        }
      }
      // WITH 生成的自定义变量（如 list、map）：从 r 的顶层 key 和 __vridPropMap 提取
      for (const k of Object.keys(r)) {
        if (!k.startsWith('_') && !(k in varCtx)) {
          varCtx[k] = r[k]
        }
      }
      if (r.__vridPropMap) {
        for (const k of Object.keys(r.__vridPropMap)) {
          if (!(k in varCtx)) varCtx[k] = r.__vridPropMap[k]
        }
      }
      // source 变量：从 row 构建（过滤掉边变量字符串，避免 [:xxx] 被混入节点属性）
      const firstStepSource = plan.steps?.[0]?.source
      if (firstStepSource && !(firstStepSource in varCtx)) {
        const srcRow: Record<string, unknown> = {}
        for (const k of Object.keys(row)) {
          if (k === '_allVars') continue
          if (typeof row[k] !== 'string' || !(row[k] as string).startsWith('[:')) {
            srcRow[k] = row[k]
          }
        }
        varCtx[firstStepSource] = srcRow
      }
      // 其他 target 变量：从 __targetProps 构建（优先使用 __targetAlias）
      const targetVar = (r.__targetAlias || firstStepSource) as string
      if (r.__targetProps && !(targetVar in varCtx)) {
        const cleanTarget: Record<string, unknown> = {}
        for (const k of Object.keys(r.__targetProps as Record<string, unknown>)) {
          if (k !== 'props' && k !== '__edges' && !k.startsWith('__')) cleanTarget[k] = (r.__targetProps as any)[k]
        }
        varCtx[targetVar] = cleanTarget
      }
      // 多步路径：补充所有步骤变量的节点数据（从 __crossVarRows / __targetProps / 直接 row 属性推断）
      // 当 RETUNR 包含多步路径的多个变量（如 x, r1, y, r2, z）时，varCtx 可能缺 z
      const allStepAliases = (plan.steps || []).map(s => [s.source, s.targetAlias]).flat().filter(Boolean)
      const allReturnVars = (plan.returnColumns || []).map(rc => rc?.split('.')[0]).filter(Boolean)
      const missingVars = [...new Set([...allStepAliases, ...allReturnVars])].filter((vn: string) => vn && !vn.startsWith('_') && !(vn in varCtx))
      if (missingVars.length && plan.steps && plan.steps.length > 1) {
        // 从 r.__targetProps 获取（If any）
        if (r.__targetProps) {
          for (const vn of missingVars) {
            if (r.__targetAlias === vn) {
              const clean: Record<string, unknown> = {}
              for (const k of Object.keys(r.__targetProps as Record<string, unknown>)) {
                if (k !== 'props' && k !== '__edges' && !k.startsWith('__')) clean[k] = (r.__targetProps as any)[k]
              }
              if (Object.keys(clean).length) varCtx[vn] = clean
            }
          }
        }
        // 如果还有缺失，从 r.props（行级数据）取节点值
        if (missingVars.some((vn: string) => !(vn in varCtx))) {
          for (const vn of missingVars) {
            if (!(vn in varCtx) && row && typeof row === 'object' && !Array.isArray(row) && !(row as any)[vn]) {
              // 找不到：用 _label 兜底
              varCtx[vn] = row._label ? { _label: row._label || 'Default' } : null
            }
          }
        }
      }
      // 如果 GE 没有 steps（MATCH (a) 无关系），从 expr 推断变量名填充 varCtx
      if (!firstStepSource) {
        // 标签谓词：(n:Foo) → 提取变量名 n
        const labelPredMatch = expr.match(/^\((\w+)\s*:\s*\w+\)$/)
        if (labelPredMatch) {
          const vn = labelPredMatch[1]
          if (vn && !(vn in varCtx)) {
            varCtx[vn] = { ...row }
          }
        }
        // 如果 expr 是函数调用（如 coalesce(a.title, a.name)），通过提取所有 . 之前的标识符
        // 来找到变量名；如果 expr 是纯变量名（"a"）或属性访问（"a.name"），直接提取
        const varNameMatches = expr.match(/(\b[a-zA-Z_]\w*)\s*\./g)
        if (varNameMatches) {
          for (const m of varNameMatches) {
            const vn = m.replace(/\s*\.$/, '')
            if (vn && /^[a-zA-Z_]\w*$/.test(vn) && !(vn in varCtx)) {
              varCtx[vn] = { ...row }
            }
          }
        } else if (!labelPredMatch) {
          const varName = expr.includes('.') ? expr.split('.')[0] : expr
          // An OPTIONAL MATCH relationship variable that has no data yet must
          // not be fallback-mapped onto the leading MATCH node: it belongs to
          // the OPTIONAL expansion (which binds it or nulls it later), so a
          // blank fill here would make the subsequent OPTIONAL handler believe
          // it is already bound and skip the null (leaking the MATCH node).
          const _isOptionalEdgeVar = (plan.optionalMatchSteps || []).some((om: any) =>
            (om.steps || []).some((s: any) => s.edgeVariable === varName || s.edgeAlias === varName)
          )
          if (varName && /^[a-zA-Z_]\w*$/.test(varName) && !(varName in varCtx) && !_isOptionalEdgeVar) {
            varCtx[varName] = { ...row }
          }
          // Extract function argument variables for type(), labels(), properties(), keys(), id()
          // Edge variables need __edgeLabel to be in varCtx for function body evaluation
          // For unmatched OPTIONAL MATCH rows, edge variable should NOT get fallback data
          const fnArgMatch = expr.match(/^(type|labels|properties|keys|id)\s*\(\s*([a-zA-Z_]\w*)\s*\)$/i)
          if (fnArgMatch) {
            const argVar = fnArgMatch[2]
            if (/^[a-zA-Z_]\w*$/.test(argVar) && !(argVar in varCtx)) {
              // Check raw GE row for __edgeLabel (edge type data set during raw row building)
              if (r.__edgeLabel) {
                // Edge variable: create object with __edgeLabel for type() resolution
                const edgeObj: Record<string, unknown> = { __edgeLabel: r.__edgeLabel, _type: r.__edgeLabel }
                if (r.__edgeProps) edgeObj._props = r.__edgeProps
                varCtx[argVar] = edgeObj
              } else if (r.__crossVarRows?.[argVar]) {
                varCtx[argVar] = r.__crossVarRows[argVar]
              } else if (r[argVar] !== undefined) {
                varCtx[argVar] = r[argVar]
              }
              // When no edge data exists (e.g. unmatched OPTIONAL MATCH), DON'T add fallback
              // The function will get undefined → null check → return null
            }
          }
        }
      }
      // 如果表达式中包含变量名（a.b 或 a），尝试通过 _evaluateExpression 求值
      const evalResult = _evaluateExpression(expr, varCtx)
      if (evalResult !== null && evalResult !== undefined) {
        // 对节点对象（_label、_alias 等内部属性）做深度清理，避免 TCK 输出中泄露
        if (evalResult && typeof evalResult === 'object') {
          const cleaned = _deepStripInternal(evalResult)
          result[rc] = cleaned
        } else {
          result[rc] = evalResult
        }
                continue
      }
      // 回退：从 row 取值
      if (rc in row) {
        result[rc] = row[rc]
        continue
      }
      result[rc] = null
      continue
    }
    // ── 没有任何分支处理该列 —— 输出 null（TCK 兼容） ──
    if (!(rc in result)) {
      result[rc] = null
    }
  }
  return result
}



// ── 导出 ──
export { _executeVarLenPath, parseCsvContent, splitCsvLine, _deepStripInternal, _formatResultRow }
