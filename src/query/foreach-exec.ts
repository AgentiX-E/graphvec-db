/**
 * FOREACH 执行引擎
 *
 * 实现 _executeForeach 和 _evalForeachCondition，供 foreach.spec.ts 使用。
 * 与 query-engine.ts 分离以避免耦合。
 */
export { }

// ═══════════════════════════════════════════════════════════════
// ForEachClause 接口（与 query-engine.ts 中的接口兼容）
// ═══════════════════════════════════════════════════════════════

export interface ForEachOperation {
  type: 'CREATE' | 'SET' | 'DELETE' | 'REMOVE' | 'FOREACH' | 'MULTI'
  where?: string
  targets?: string[]
  setClauses?: Array<{ property: string; value: string }>
  foreach?: ForEachClause
  operations?: ForEachOperation[]
}

export interface ForEachClause {
  variable: string
  list: any[]
  isVarRef?: boolean
  operation: ForEachOperation
}

// ═══════════════════════════════════════════════════════════════
// _evalForeachCondition
// ═══════════════════════════════════════════════════════════════

/**
 * 评估 FOREACH WHERE 条件表达式。
 * 支持: >, <, >=, <=, =, !=, IN
 */
export function _evalForeachCondition(condition: string, varName: string, value: any): boolean {
  const cond = condition.trim()

  // IN 操作: x IN [list]
  const inMatch = cond.match(new RegExp(`^\\s*${escapeRegex(varName)}\\s+IN\\s+\\[(.+)\\]\\s*$`, 'i'))
  if (inMatch) {
    const listStr = `[${inMatch[1]}]`
    let list: any[]
    try { list = JSON.parse(listStr) }
    catch { return false }
    return list.some(item => {
      if (typeof item === 'number' && typeof value === 'string') return String(item) === value
      return item === value
    })
  }

  // 二元操作符
  const ops = [
    { op: '>=', fn: (a: number, b: number) => a >= b },
    { op: '<=', fn: (a: number, b: number) => a <= b },
    { op: '!=', fn: (a: any, b: any) => a != b },
    { op: '=', fn: (a: any, b: any) => a == b },
    { op: '>', fn: (a: number, b: number) => a > b },
    { op: '<', fn: (a: number, b: number) => a < b },
  ]

  for (const { op, fn } of ops) {
    const pattern = new RegExp(`^\\s*${escapeRegex(varName)}\\s*${escapeRegex(op)}\\s*(.+)$`, 'i')
    const m = cond.match(pattern)
    if (m) {
      const rhs = m[1].trim()
      const numVal = Number(rhs)
      const eVal = Number(value)
      if (!isNaN(numVal) && !isNaN(eVal)) {
        return fn(eVal, numVal)
      }
      return fn(value, rhs)
    }
  }

  return true
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ═══════════════════════════════════════════════════════════════
// _executeForeach
// ═══════════════════════════════════════════════════════════════

/**
 * 执行 FOREACH 子句。
 *
 * @param candidates 当前候选行列表（来自 MATCH / WITH 或上一步）
 * @param foreachClause FOREACH 配置
 * @returns 展开后的行列表
 */
export function _executeForeach(candidates: any[], foreachClause: ForEachClause): any[] {
  // 空列表 → 返回原始候选行
  if (!foreachClause.list.length) {
    return [...candidates]
  }

  // 判断是变量引用还是字面量列表
  let items: any[]
  if (foreachClause.isVarRef && foreachClause.list.length > 0) {
    // 变量引用: 从第 0 个候选行读取
    const varName = foreachClause.list[0] as string
    if (candidates.length > 0 && candidates[0][varName] !== undefined) {
      const refVal = candidates[0][varName]
      items = Array.isArray(refVal) ? refVal : [refVal]
    } else {
      items = [...foreachClause.list]
    }
  } else {
    items = [...foreachClause.list]
  }

  // 对每个候选行 × 每个列表元素 展开
  const allResult: any[] = []

  for (const candidate of candidates) {
    const baseRow = { ...candidate }

    for (const item of items) {
      const newRow = { ...baseRow }
      newRow[foreachClause.variable] = item

      // 应用 WHERE 过滤
      if (foreachClause.operation.where) {
        if (!_evalForeachCondition(foreachClause.operation.where, foreachClause.variable, item)) {
          continue
        }
      }

      // 按操作类型处理
      const processed = applyOperation(newRow, foreachClause.operation, item)
      if (processed !== null) {
        if (Array.isArray(processed)) {
          allResult.push(...processed)
        } else {
          allResult.push(processed)
        }
      }
    }
  }

  // 如果全部被过滤掉，返回原始候选行
  if (allResult.length === 0) {
    return [...candidates]
  }

  return allResult
}

function applyOperation(row: any, op: ForEachOperation, item: any): any | null {
  switch (op.type) {
    case 'CREATE':
      // CREATE 只展开行，保留变量绑定
      return { ...row }

    case 'SET': {
      const result = { ...row }
      if (op.setClauses) {
        for (const sc of op.setClauses) {
          // property: "n.flag", value: "$x" 或字面量
          const propParts = sc.property.split('.')
          const propName = propParts.length > 1 ? propParts[1] : propParts[0]
          let val: any = sc.value
          if (typeof val === 'string' && val.startsWith('$')) {
            const varName = val.slice(1)
            val = row[varName] !== undefined ? row[varName] : val
          }
          result[propName] = val
        }
      }
      return result
    }

    case 'DELETE': {
      if (op.targets) {
        for (const target of op.targets) {
          // 按 _alias 匹配删除
          if (row._alias === target) {
            return null // 移除该行
          }
        }
      }
      return row
    }

    case 'REMOVE': {
      const result = { ...row }
      if (op.targets) {
        for (const target of op.targets) {
          const propParts = target.split('.')
          const propName = propParts.length > 1 ? propParts[1] : propParts[0]
          delete result[propName]
        }
      }
      return result
    }

    case 'FOREACH': {
      if (op.foreach) {
        // 递归处理内层 FOREACH
        return _executeForeach([row], op.foreach)
      }
      return row
    }

    case 'MULTI': {
      if (op.operations) {
        let currentRows: any[] = [row]
        for (const subOp of op.operations) {
          const newRows: any[] = []
          for (const r of currentRows) {
            const processed = applyOperation(r, subOp, item)
            if (processed !== null) {
              if (Array.isArray(processed)) {
                newRows.push(...processed)
              } else {
                newRows.push(processed)
              }
            }
          }
          currentRows = newRows
          if (currentRows.length === 0) break
        }
        if (currentRows.length === 1) return currentRows[0]
        if (currentRows.length === 0) return null
        return currentRows // 返回多行
      }
      return row
    }

    default:
      return { ...row }
  }
}
