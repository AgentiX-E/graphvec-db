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
      // 仅删除 _alias 和 __ 开头的内部属性，保留 _label（toNodeNotation 需要）
      if (k === '_alias' || k.startsWith('__')) continue
      clean[k] = _deepStripInternal(v)
    }
    return clean
  }
  return obj
}


function _formatResultRow(r: any, plan: QueryPlan): QueryRow {
  const row: QueryRow = {}

  // GE 返回格式：{ props: { _label, _alias, name, p, ... } }
  // 过滤内部属性（以 _ 开头）以保持 TCK 兼容性，避免出现 _alias 等内部字段
  // 但保留 _label（toNodeNotation 需要它来识别节点类型）
  if (r.props) {
    for (const k of Object.keys(r.props)) {
      if (k === '_alias' || k.startsWith('__')) continue
      row[k] = r.props[k]
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
      const result: QueryRow = {}
      // 从 r 收集所有变量（包括 __targetPropsMap 中的中间变量等）
      if (r.__targetPropsMap) {
        for (const vn of Object.keys(r.__targetPropsMap)) {
          const nodeData = r.__targetPropsMap[vn]
          if (nodeData && typeof nodeData === 'object' && '_label' in nodeData) {
            const label = (nodeData as any)._label
            result[vn] = label ? `(${label.startsWith(':') ? label : ':' + label})` : '()'
          } else if (nodeData && typeof nodeData === 'object' && '__edgeLabel' in nodeData) {
            result[vn] = `<(${(nodeData as any).__edgeLabel || '??'})>`
          }
        }
      }
      // source 节点变量
      const firstStepSource = plan.steps?.[0]?.source
      if (firstStepSource && r.props && '_label' in (r.props || {})) {
        const label = (r.props as any)._label
        result[firstStepSource] = label ? `(${label.startsWith(':') ? label : ':' + label})` : '()'
      }
      // 如果以上都没填充但 row 有数据，尽量用 row
      if (!Object.keys(result).length && r.props) {
        const label = (r.props as any)._label
        result['_k'] = label ? `(${label.startsWith(':') ? label : ':' + label})` : '()'
      }
      // 路径变量 p
      if (plan.steps?.length) {
        // TODO: 路径变量表示
        result['p'] = '<path>'
      }
      if (Object.keys(result).length) return result
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
  }  // 构造输出行，每列正确映射
  const result: QueryRow = {}
  for (const rc of ret) {
    if (!rc) continue
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

    // 判断 rc 是否直接出现在 GE 返回的 props 中
    // 但如果是函数调用表达式（被 GE 错误当作属性赋值），跳过 GE 数据走函数求值
    // 聚合模式例外：聚合函数名如 count(*) 已在 GE 的 _execAggregation 中正确设为 props key
    // TODO: 更好的方法是统一 QE 和 GE 的聚合列名，避免走函数求值
    if ((rc in row)) {
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
    // rc 是边变量名（如 RETURN r），从 r.__edgeLabel 获取标签输出 [:LABEL] 格式
    if (r.__edgeLabel && !rc.match(/^\w+\(/)) {
      // 只在 rc 确实是 GE 记录的边变量时使用边标签（避免自环中节点被误输出为边格式）
      let isEdgeVar = false
      if (plan.returnColumns) {
        const nodeAliases = new Set([
          ...(plan.createNodes || []).map(n => n.alias).filter(Boolean),
          ...(plan.steps || []).flatMap(s => [s.source, s.targetAlias]).filter(Boolean),
        ])
        isEdgeVar = !nodeAliases.has(rc)
      } else {
        isEdgeVar = typeof r[rc] === 'string' && r[rc].startsWith('[:')
      }
      if (isEdgeVar) {
        result[rc] = '[:' + r.__edgeLabel + ']'
        continue
      }
    }

    // 使用 returnAliasMap 或 expressionColumns 解析原始表达式：统一走 _evaluateExpression
    let expr = (aliasMap && rc in aliasMap) ? aliasMap[rc] : (rc in ecMap ? ecMap[rc] : null)
    // 如果没有表达式映射（aliasMap 为空），但 rc 是简单变量名且存在于 varCtx 中，直接用 rc 作为表达式
    if (expr === null && rc && /^[a-zA-Z_]\w*$/.test(rc) && (rc in varCtx || rc in row)) {
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
        // 从 r.__targetProps 获取（如果有）
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
          if (varName && /^[a-zA-Z_]\w*$/.test(varName) && !(varName in varCtx)) {
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
