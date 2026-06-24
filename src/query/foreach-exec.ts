/**
 * foreach-exec.ts — FOREACH 内联执行引擎
 *
 * 从 query-engine.ts 提取的 FOREACH 执行函数。
 * foreach 操作在构建查询计划时已经解析好（AST → Plan），
 * 这里负责对候选行逐一遍历 FOREACH 列表并执行嵌套操作。
 */

/** 检查 FOREACH WHERE 条件 */
export function evalForeachCondTop(cond: string, varName: string, val: any): boolean {
  const c = cond.trim()
  const inM = c.match(new RegExp(`^\\s*${varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+IN\\s+\\[(.+)\\]\\s*$`, 'i'))
  if (inM) {
    let list: any[]; try { list = JSON.parse(`[${inM[1]}]`); } catch { return false }
    return list.some(it => typeof it === 'number' && typeof val === 'string' ? String(it) === val : it === val)
  }
  const ops = [
    { op: '>=', fn: (a: number, b: number) => a >= b },
    { op: '<=', fn: (a: number, b: number) => a <= b },
    { op: '!=', fn: (a: any, b: any) => a != b },
    { op: '=',  fn: (a: any, b: any) => a == b },
    { op: '>',  fn: (a: number, b: number) => a > b },
    { op: '<',  fn: (a: number, b: number) => a < b },
  ]
  for (const { op, fn } of ops) {
    const p = new RegExp(`^\\s*${varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*${op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(.+)$`, 'i')
    const m = c.match(p)
    if (m) {
      const rhs = m[1].trim(); const nv = Number(rhs); const ev = Number(val)
      if (!isNaN(nv) && !isNaN(ev)) return fn(ev, nv)
      return fn(val, rhs)
    }
  }
  return true
}

/** 对单行应用 FOREACH 内的单个操作 */
export function applyForeachOpTop(row: any, op: any, item: any): any | null {
  if (!op) return { ...row }
  switch (op.type) {
    case 'CREATE': return { ...row }
    case 'SET': {
      const r = { ...row }
      if (op.setClauses) for (const sc of op.setClauses) {
        const propName = sc.property.split('.').length > 1 ? sc.property.split('.')[1] : sc.property
        let val: any = sc.value
        if (typeof val === 'string' && val.startsWith('$')) val = row[val.slice(1)] !== undefined ? row[val.slice(1)] : val
        r[propName] = val
      }
      return r
    }
    case 'DELETE': {
      if (op.targets) for (const t of op.targets) if (row._alias === t) return null
      return row
    }
    case 'REMOVE': {
      const r = { ...row }
      if (op.targets) for (const t of op.targets) {
        const propName = t.split('.').length > 1 ? t.split('.')[1] : t
        delete r[propName]
      }
      return r
    }
    case 'FOREACH': {
      if (op.foreach) {
        return executeForeachInlineTop([row], op.foreach)
      }
      return row
    }
    case 'MULTI': {
      if (op.operations) {
        let cur: any[] = [row]
        for (const so of op.operations) {
          const nr: any[] = []
          for (const r of cur) { const p = applyForeachOpTop(r, so, item); if (p !== null) Array.isArray(p) ? nr.push(...p) : nr.push(p) }
          cur = nr; if (!cur.length) break
        }
        return cur.length === 1 ? cur[0] : cur.length === 0 ? null : cur
      }
      return row
    }
    default: return { ...row }
  }
}

/**
 * Execute FOREACH inline operations (from buildQueryPlan).
 * Processes each candidate row through the FOREACH list and operations.
 */
export function executeForeachInlineTop(candidates: any[], fe: any): any[] {
  if (!fe.list.length) return [...candidates]
  let items: any[]
  if (fe.isVarRef && fe.list.length > 0) {
    const varName = fe.list[0] as string
    if (candidates.length > 0 && candidates[0][varName] !== undefined) {
      const refVal = candidates[0][varName]
      items = Array.isArray(refVal) ? refVal : [refVal]
    } else { items = [...fe.list] }
  } else { items = [...fe.list] }
  const allResult: any[] = []
  for (const candidate of candidates) {
    const baseRow = { ...candidate }
    for (const item of items) {
      const newRow = { ...baseRow }
      newRow[fe.variable] = item
      if (fe.operation?.where && !evalForeachCondTop(fe.operation.where, fe.variable, item)) continue
      const processed = applyForeachOpTop(newRow, fe.operation, item)
      if (processed !== null) {
        if (Array.isArray(processed)) allResult.push(...processed)
        else allResult.push(processed)
      }
    }
  }
  return allResult.length > 0 ? allResult : [...candidates]
}
