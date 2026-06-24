/**
 * expression-engine.ts — 表达式求值引擎
 *
 * 从 query-engine.ts 提取的纯表达式求值模块。
 * 所有函数均为纯函数——不依赖 query-engine.ts 的任何运行时状态。
 *
 * 提取范围：query-engine.ts line 7411-9538
 * - _evaluateExpression — 表达式求值入口
 * - _evalBinary / _evalComparison / _evalUnary — 二元/比较/一元运算
 * - _evalLiteral / _evalStructuredLiteral — 字面量求值
 * - _postProcessResults — 后处理（ORDER BY / HAVING / SKIP / LIMIT）
 * - _parseAggregate / _executeAggregation — 聚合函数
 * - _validateLiterals — 字面量校验
 * - 所有辅助函数
 */

// ============================================================
// 类型定义
// ============================================================

export type QueryRow = Record<string, unknown>

export interface AggColumnInfo {
  fn: string
  field: string
  prop: string
  distinct?: boolean
  alias?: string | null
}

/** BigInt JSON 序列化/反序列化辅助 */
export const _bigintReplacer = (_k: string, v: unknown): unknown =>
  typeof v === 'bigint' ? { __bigint: v.toString() } : v
export const _bigintReviver = (_k: string, v: unknown): unknown =>
  v && typeof v === 'object' && (v as any).__bigint !== undefined ? BigInt((v as any).__bigint) : v

/** Post-process plan type (subset of QueryPlan used by _postProcessResults) */
interface PostProcessPlan {
  orderBy?: Array<Record<string, unknown>>
  having?: Array<{ aggregate?: string; operator?: string; value?: unknown }>
  skip?: number
  limit?: number
}
export function _evaluateExpression(expr: string | Record<string, unknown>, row?: Record<string, unknown>): unknown {
  if (expr == null) return null
  // 支持结构化表达式 {type, value, items}（从 AST 解析而来）
  if (typeof expr !== 'string' && typeof expr === 'object') {
    return _evalStructuredLiteral(expr as Record<string, unknown>, row)
  }
  if (typeof expr !== 'string') return null
  const t = expr.trim()
  if (t.startsWith('CASE ') || t.startsWith('case ')) {
    const endIdx = t.search(/\bEND\b/i)
    if (endIdx >= 0) {
      const casePart = t.slice(0, endIdx + 3)
      const rest = t.slice(endIdx + 3).trim()
      const r = _evalCase(casePart, row)
      if (rest) {
        const tmpKey = '___CASE_TMP'
        const injectedRow = { ...row as any, [tmpKey]: r }
        return _evalBinary(tmpKey + ' ' + rest, injectedRow)
      }
      return r
    }
  }
  return _evalBinary(t, row)
}

/** 从结构化 AST 字面量对象求值 */
export function _evalStructuredLiteral(expr: Record<string, unknown>, _row?: Record<string, unknown>): unknown {
  const type = String(expr.type || '')
  switch (type.toUpperCase()) {
    case 'STRING': return String(expr.value)
    case 'NUMBER': {
      const n = Number(expr.value)
      if (!Number.isSafeInteger(n) && String(expr.value).length >= 16) {
        try { return BigInt(String(expr.value)) } catch { return n }
      }
      return n
    }
    case 'BOOLEAN': return expr.value === true || expr.value === 'true'
    case 'NULL': return null
    case 'LIST': {
      const items = Array.isArray(expr.items) ? expr.items : []
      return items.map((item: unknown) => {
        if (typeof item === 'object' && item !== null && (item as Record<string, unknown>).type) {
          const typed = item as Record<string, unknown>
          // STRING 类型但值以 { 开头 → map 字面量，用 _evalBinary 解析
          if (String(typed.type).toUpperCase() === 'STRING' && typeof typed.value === 'string' && typed.value.startsWith('{')) {
            return _evalBinary(typed.value, _row || {})
          }
          return _evalStructuredLiteral(typed, _row)
        }
        return item
      })
    }
    case 'MAP': return Object.fromEntries(
      Object.entries(expr).filter(([k]) => k !== 'type').map(([k, v]) => [
        k,
        typeof v === 'object' && v !== null && (v as Record<string, unknown>).type
          ? _evalStructuredLiteral(v as Record<string, unknown>, _row)
          : v,
      ])
    )
    default: return null
  }
}

export function _evalCase(s: string, row?: Record<string, unknown>): unknown {
  // CASE <value> WHEN <v1> THEN <r1> WHEN <v2> THEN <r2> ... ELSE <default> END
  // 或 CASE WHEN <cond1> THEN <r1> WHEN <cond2> THEN <r2> ... ELSE <default> END
  const t = s.replace(/\bEND\b\s*$/i, '').trim()  // 去掉尾部 END
  const caseMatch = t.match(/^CASE\s+(.+?)\s+WHEN\s/i)
  const simpleCase = caseMatch !== null
  let remainder: string
  let baseValue: unknown = null
  if (simpleCase) {
    baseValue = _evaluateExpression(caseMatch[1], row)
    remainder = t.slice(caseMatch[0].length)  // WHEN ... 部分（不含 WHEN 前缀）
  } else {
    // 没有 CASE <value>，直接解析 WHEN ... THEN ... ELSE
    const caseWhenMatch = t.match(/^CASE\s+(WHEN\s)/i)
    remainder = caseWhenMatch ? t.slice(caseWhenMatch[1].length) : t.replace(/^CASE\s+/i, '')
  }

  // 拆分 WHEN ... THEN ... WHEN ... THEN ... [ELSE ...]
  let result: unknown = null
  let hasMatch = false

  const parts = remainder.split(/\bWHEN\s+/i)
  let elseVal: unknown = null
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim()
    if (!part) continue
    if (/^ELSE\s+/i.test(part)) {
      elseVal = _evaluateExpression(part.replace(/^ELSE\s+/i, '').trim(), row)
      continue
    }
    // 一个 WHEN arm: "<cond> THEN <result>"
    const thenIdx = findThenIndex(part)
    if (thenIdx < 0) continue
    const cond = _evaluateExpression(part.slice(0, thenIdx).trim(), row)
    let thenResult = part.slice(thenIdx + 4).trim() // 去掉 "THEN"
    // 如果剩余部分包含 ELSE，截断
    const elseIdx = thenResult.search(/\bELSE\s+/i)
    if (elseIdx >= 0) {
      // 如果当前 arm 不匹配且 elseVal 没有被设置，提取 ELSE 值
      if (elseVal == null) {
        elseVal = _evaluateExpression(thenResult.slice(elseIdx + 4).trim(), row)
      }
      thenResult = thenResult.slice(0, elseIdx).trim()
    }
    if (hasMatch) continue  // 已匹配，跳过剩余
    let condResult: boolean
    if (simpleCase) {
      condResult = _compareValues(baseValue, cond, '=')
    } else {
      condResult = cond === true
    }
    if (condResult) {
      result = _evaluateExpression(thenResult, row)
      hasMatch = true
    }
  }
  if (!hasMatch) result = elseVal
  return result
}

export function findThenIndex(s: string): number {
  // 找到顶层的 THEN（不嵌套在括号内）
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(' || s[i] === '[' || s[i] === '{') depth++
    else if (s[i] === ')' || s[i] === ']' || s[i] === '}') depth--
    else if (depth === 0 && s.slice(i, i + 4).toLowerCase() === 'then' && (i + 4 >= s.length || s[i+4] === ' ' || s[i+4] === '(' || s[i+4] === ')' || s[i+4] === '.' || s[i+4] === "[" || s[i+4] === "'")) {
      // Check that it's "THEN" not part of another word
      if (i === 0 || s[i-1] === ' ' || s[i-1] === ')') return i
    }
  }
  return -1
}

export function _parseCommaList(s: string): string[] {
  const result: string[] = []
  let depth = 0, inStr = false, strChar = '', current = ''
  for (const ch of s) {
    if (inStr) { current += ch; if (ch === strChar) inStr = false; continue }
    if (ch === "'" || ch === '"') { inStr = true; strChar = ch; current += ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; current += ch; continue }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; current += ch; continue }
    if (ch === ',' && depth === 0) { result.push(current.trim()); current = ''; continue }
    current += ch
  }
  if (current.trim()) result.push(current.trim())
  return result
}

type _BuiltinFn = (args: string[], row?: Record<string, unknown>) => unknown

/** Resolve nanoseconds from map combining millisecond, microsecond, nanosecond */
export function _resolveNanoseconds(map: Record<string, unknown>): number {
  const ms = map.millisecond != null ? Math.round(Number(map.millisecond) * 1000000) : 0
  const us = map.microsecond != null ? Math.round(Number(map.microsecond) * 1000) : 0
  const ns = map.nanosecond != null ? Number(map.nanosecond) : 0
  return ms + us + ns
}

/** Format time string per Cypher TCK */
export function _formatTime(hour: number, minute: number, second: number, nanosecond: number): string {
  const base = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  if (nanosecond > 0) {
    let nsStr = String(nanosecond).padStart(9, '0').replace(/0+$/, '')
    return `${base}:${String(second).padStart(2, '0')}.${nsStr}`
  }
  if (second > 0) return `${base}:${String(second).padStart(2, '0')}`
  return base
}

export function _extractTimeMap(map: Record<string, unknown>): { hour: number; minute: number; second: number; nanosecond: number } {
  return {
    hour: map.hour != null ? Number(map.hour) : 0,
    minute: map.minute != null ? Number(map.minute) : 0,
    second: map.second != null ? Number(map.second) : 0,
    nanosecond: _resolveNanoseconds(map),
  }
}

export function _formatTimezone(tz: string): string {
  return /^[+-]\d{2}:\d{2}:00$/.test(tz) ? tz.slice(0, -3) : tz
}

export function _resolveNamedTimezone(tz: string, year?: number, month?: number, day?: number): string {
  if (/^[+-]\d{2}:\d{2}/.test(tz)) return tz
  if (tz.includes('[')) return tz
  try {
    const date = (year != null && month != null && day != null)
      ? new Date(Date.UTC(year, month - 1, day)) : new Date()
    const parts = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(date)
    const tzPart = parts.find(p => p.type === 'timeZoneName')
    if (tzPart && tzPart.value) {
      const m = tzPart.value.match(/GMT([+-]?)(\d+)/)
      if (m) return `${m[1] || '+'}${String(parseInt(m[2], 10)).padStart(2, '0')}:00[${tz}]`
    }
  } catch {}
  return tz
}

export function _isoYear(d: Date): number {
  const t = new Date(d.valueOf())
  t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7))
  return t.getUTCFullYear()
}

export function _isoWeek1Monday(year: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const d = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay()
  return new Date(Date.UTC(year, 0, 4 - d + 1))
}

export function _resolveDateFromMap(map: Record<string, unknown>): Date {
  if (map.date != null) {
    const baseStr = typeof map.date === 'string' ? map.date : String(map.date)
    const parts = baseStr.split('-')
    if (parts.length === 3) {
      const year = Number(parts[0]), month2 = Number(parts[1]), day2 = Number(parts[2])
      const base = new Date(Date.UTC(year, month2 - 1, day2))
      if (map.week != null || map.dayOfWeek != null) {
        const dateDow = base.getUTCDay() === 0 ? 7 : base.getUTCDay()
        const isoY = map.year != null ? Number(map.year) : _isoYear(base)
        const w1Mon = _isoWeek1Monday(isoY)
        const dow = map.dayOfWeek != null ? Number(map.dayOfWeek) : dateDow
        const tw = map.week != null ? Number(map.week) : 1
        const adj = new Date(w1Mon)
        adj.setUTCDate(w1Mon.getUTCDate() + (tw - 1) * 7 + dow - 1)
        return adj
      }
      return base
    }
  }
  const year = map.year != null ? Number(map.year) : 2000
  if (map.week != null) {
    const w1Mon = _isoWeek1Monday(year)
    const dow = map.dayOfWeek != null ? Number(map.dayOfWeek) : 1
    const adj = new Date(w1Mon)
    adj.setUTCDate(w1Mon.getUTCDate() + (Number(map.week) - 1) * 7 + dow - 1)
    return adj
  }
  let month = map.month != null ? Number(map.month) : 1
  let day = map.day != null ? Number(map.day) : 1
  if (map.quarter != null) {
    month = (Number(map.quarter) - 1) * 3 + 1
    if (map.dayOfQuarter != null) {
      const q = new Date(Date.UTC(year, month - 1, 1))
      q.setUTCDate(q.getUTCDate() + Number(map.dayOfQuarter) - 1)
      return q
    }
  }
  if (map.ordinalDay != null) {
    const d = new Date(Date.UTC(year, 0, 1))
    d.setUTCDate(d.getUTCDate() + Number(map.ordinalDay) - 1)
    return d
  }
  return new Date(Date.UTC(year, month - 1, day))
}

/** Unwrap a value to its raw data object, handling NodeRecord/EdgeRecord wrappers */
export function _unwrapRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>
    // If it looks like a NodeRecord with `props` sub-object, unwrap to the props
    if (obj.props && typeof obj.props === 'object' && !Array.isArray(obj.props)) {
      // Keep metadata fields too (flatten into single object)
      const result: Record<string, unknown> = {}
      // Copy props first (they may contain _label, etc.)
      for (const [k, vv] of Object.entries(obj.props)) {
        result[k] = vv
      }
      // Also copy top-level metadata fields (_id, id, _type, _label, type)
      // but only if they don't shadow existing props
      for (const [k, vv] of Object.entries(obj)) {
        if (k === 'props') continue
        if (result[k] === undefined) result[k] = vv
      }
      return result
    }
  }
  return (v as Record<string, unknown>) || {}
}

const _builtinFunctions: Record<string, _BuiltinFn> = {
  length: ([a], r) => {
    const v = _evalBinary(a, r);
    // 路径长度：路径对象以 {__path, __pathEdges} 形式存储
    if (v && typeof v === 'object' && !Array.isArray(v) && (v as any).__path && (v as any).__pathEdges) {
      return (v as any).__pathEdges.length;
    }
    // 字符串长度
    if (typeof v === 'string') return v.length;
    // 列表长度
    if (Array.isArray(v)) return v.length;
    return null;
  },
  type: ([a], r) => {
    const v = _evalBinary(a, r);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // 边对象形如 { _type: 'REL', props: {...} }
      if ((v as any)._type) return (v as any)._type;
      if ((v as any).label) return (v as any).label;
    }
    // 字符串直接返回
    if (typeof v === 'string') return v;
    return null;
  },
  nodes: ([a], r) => {
    const v = _evalBinary(a, r);
    if (v && typeof v === 'object' && !Array.isArray(v) && (v as any).__path) {
      return (v as any).__path;
    }
    return null;
  },
  relationships: ([a], r) => {
    const v = _evalBinary(a, r);
    if (v && typeof v === 'object' && !Array.isArray(v) && (v as any).__pathEdges) {
      return (v as any).__pathEdges;
    }
    return null;
  },
  abs: ([a], r) => Math.abs(Number(_evalBinary(a, r))),
  sqrt: ([a], r) => Math.sqrt(Number(_evalBinary(a, r))),
  ceil: ([a], r) => Math.ceil(Number(_evalBinary(a, r))),
  floor: ([a], r) => Math.floor(Number(_evalBinary(a, r))),
  round: ([a], r) => Math.round(Number(_evalBinary(a, r))),
  sign: ([a], r) => Math.sign(Number(_evalBinary(a, r))),
  rand: () => Math.random(),
  coalesce: (as, r) => { for (const a of as) { const v = _evalBinary(a, r); if (v != null) return v } return null },
  toupper: ([a], r) => String(_evalBinary(a, r)).toUpperCase(),
  tolower: ([a], r) => String(_evalBinary(a, r)).toLowerCase(),
  trim: ([a], r) => String(_evalBinary(a, r)).trim(),
  reverse: ([a], r) => {
    const v = _evalBinary(a, r);
    if (Array.isArray(v)) return [...v].reverse();
    return [...String(v)].reverse().join('');
  },
  substring: ([a, s, l], r) => { const str = String(_evalBinary(a, r)); const st = Number(_evalBinary(s, r)); return l ? str.slice(st, st + Number(_evalBinary(l, r))) : str.slice(st) },
  left: ([a, l], r) => String(_evalBinary(a, r)).slice(0, Number(_evalBinary(l, r))),
  right: ([a, l], r) => String(_evalBinary(a, r)).slice(-Number(_evalBinary(l, r))),
  replace: ([a, s, re], r) => String(_evalBinary(a, r)).split(String(_evalBinary(s, r))).join(String(_evalBinary(re, r))),
  size: ([a], r) => { const v = _evalBinary(a, r); if (v == null) return null; if (Array.isArray(v)) return v.length; if (typeof v === 'string') return v.length; return 0 },
  tostring: ([a], r) => { const v = _evalBinary(a, r); if (v == null) return null; return String(v) },
  tointeger: ([a], r) => { const v = _evalBinary(a, r); if (v == null) return null; const n = parseInt(String(v), 10); return isNaN(n) ? null : n },
  tofloat: ([a], r) => { const v = _evalBinary(a, r); if (v == null) return null; const n = parseFloat(String(v)); return isNaN(n) ? null : n },
  toboolean: ([a], r) => { const v = _evalBinary(a, r); if (v == null) return null; if (v === true || v === false) return v; if (typeof v === 'string') { const lv = v.toLowerCase().trim(); if (lv === 'true') return true; if (lv === 'false') return false; } return null },
  isnan: ([a], r) => isNaN(Number(_evalBinary(a, r))),
  labels: ([a], r) => { const v = typeof a === 'string' ? _evalBinary(a, r) : a; if (v == null) return null; if (typeof v !== 'object' || v === null) throw Object.assign(new Error('TypeError: Invalid argument type for labels()'), { tckError: 'TypeError' }); if (typeof v === 'object' && Object.keys(v).length === 0) return []; const unwrapped = _unwrapRecord(v); const raw = unwrapped.__fullLabel || unwrapped._fullLabel || unwrapped._label; if (!raw || raw === 'Default') return []; return String(raw).split(':').filter(Boolean) },
  type: ([a], r) => { const v = typeof a === 'string' ? _evalBinary(a, r) : a; if (v == null) return null; if (typeof v !== 'object' || Array.isArray(v)) throw Object.assign(new Error('TypeError: Invalid argument type for type()'), { tckError: 'TypeError' }); const uw = _unwrapRecord(v); const edgeLabel = uw.__edgeLabel ?? uw.__edgeLabelStr ?? uw._type ?? ''; return edgeLabel },
  properties: ([a], r) => { const v = typeof a === 'string' ? _evalBinary(a, r) : a; if (v == null) return null; if (typeof v !== 'object' || Array.isArray(v)) throw Object.assign(new Error('TypeError: Invalid argument type for properties()'), { tckError: 'TypeError' }); const uw = _unwrapRecord(v); const o: Record<string, unknown> = {}; for (const [k, vv] of Object.entries(uw)) if (!k.startsWith('_') && ['id', 'type'].indexOf(k) === -1) o[k] = vv; return o },
  keys: ([a], r) => { const v = typeof a === 'string' ? _evalBinary(a, r) : a; if (v == null) return null; if (typeof v === 'object') { const uw = _unwrapRecord(v); return Object.keys(uw).filter(k => !k.startsWith('_') && uw[k] != null); } return [] },
  id: ([a], r) => { const v = _evalBinary(a, r); if (v && typeof v === 'object') { const uw = _unwrapRecord(v); const uid = '_id' in uw ? uw._id : ('id' in uw && typeof uw.id === 'number' ? uw.id : 0); return typeof uid === 'number' ? uid : 0; } return 0 },
  head: ([a], r) => { const v = _evalBinary(a, r); return Array.isArray(v) && v.length ? v[0] : null },
  last: ([a], r) => { const v = _evalBinary(a, r); return Array.isArray(v) && v.length ? v[v.length - 1] : null },
  tail: ([a], r) => { const v = _evalBinary(a, r); return Array.isArray(v) ? v.slice(1) : null },
  nodes: ([a], r) => { const v = _evalBinary(a, r); if (v == null) return null; if (typeof v === 'object' && (v as any).__path) return (v as any).__path; if (Array.isArray(v)) return v; return null },
  relationships: ([a], r) => { const v = _evalBinary(a, r); if (v == null) return null; if (typeof v === 'object' && (v as any).__pathEdges) return (v as any).__pathEdges; return null },
  range: ([s, e, step], r) => {
    const rawS = _evalBinary(s, r), rawE = _evalBinary(e, r);
    const rawStep = step ? _evalBinary(step, r) : 1;
    // Validate: all args must be integers (reject booleans, strings, floats, lists, maps)
    if (typeof rawS !== 'number' || typeof rawE !== 'number' || (step && typeof rawStep !== 'number')) {
      throw Object.assign(new Error('ArgumentError'), { tckError: 'ArgumentError' });
    }
    const start = rawS as number, end = rawE as number;
    const stepVal = (step ? rawStep as number : 1) as number;
    // Validate: step must not be zero
    if (step && stepVal === 0) {
      throw Object.assign(new Error('ArgumentError'), { tckError: 'ArgumentError' });
    }
    // Validate: all args must be integers (reject floats like 0.0, -0.0)
    if (!Number.isInteger(start) || !Number.isInteger(end) || (step && !Number.isInteger(stepVal))) {
      throw Object.assign(new Error('ArgumentError'), { tckError: 'ArgumentError' });
    }
    // Additional check: reject if the original string contained a decimal point
    const hasDecimal = (str: string) => /^-?\d+\.\d+$/.test(str.trim());
    if (hasDecimal(s) || hasDecimal(e) || (step && hasDecimal(step))) {
      throw Object.assign(new Error('ArgumentError'), { tckError: 'ArgumentError' });
    }
    const res: number[] = [];
    // If direction mismatch (end-start and step have opposite signs), return empty
    if (stepVal > 0 && start > end) return res;
    if (stepVal < 0 && start < end) return res;
    for (let i = start; stepVal > 0 ? i <= end : i >= end; i += stepVal) {
      res.push(i);
    }
    return res;
  },
  split: ([a, d], r) => String(_evalBinary(a, r)).split(String(_evalBinary(d, r))),
  // ── Aggregation Functions ──
  count: (args, r) => {
    // count(*) counts all rows; count(null) returns 0; count(expr) skips nulls
    if (args.length === 0 || args[0] === '*') return 1;
    const v = _evalBinary(args[0], r);
    return v == null || v === undefined ? 0 : 1;
  },
  collect: (args, r) => {
    const v = _evalBinary(args[0], r);
    if (v == null) return [];
    return [v];
  },
  sum: (args, r) => {
    const v = _evalBinary(args[0], r);
    if (v == null) return null;
    return Number(v);
  },
  avg: (args, r) => Number(_evalBinary(args[0], r)),
  max: (args, r) => _evalBinary(args[0], r),
  min: (args, r) => _evalBinary(args[0], r),
  // ── Percentile Functions ──
  percentiledisc: ([a, p], r) => {
    // percentileDisc returns the nearest value from the sorted list at or above the percentile
    // Simplified: returns the value at the floor index
    const v = _evalBinary(a, r);
    const perc = Number(_evalBinary(p, r));
    if (Array.isArray(v) && v.length > 0 && typeof perc === 'number' && perc >= 0 && perc <= 1) {
      const sorted = [...v].sort((a: any, b: any) => a - b);
      const idx = Math.ceil(perc * sorted.length) - 1;
      return sorted[Math.max(0, idx)];
    }
    return null;
  },
  percentilecont: ([a, p], r) => {
    // percentileCont returns an interpolated value at the percentile between two values
    const v = _evalBinary(a, r);
    const perc = Number(_evalBinary(p, r));
    if (Array.isArray(v) && v.length > 0 && typeof perc === 'number' && perc >= 0 && perc <= 1) {
      const sorted = [...v].sort((a: any, b: any) => a - b);
      const idx = perc * (sorted.length - 1);
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      if (lo === hi) return sorted[lo];
      const frac = idx - lo;
      const valLo = Number(sorted[lo]);
      const valHi = Number(sorted[hi]);
      return valLo + frac * (valHi - valLo);
    }
    return null;
  },
  "datetime.fromepoch": ([seconds, nanos], r) => {
    const sec = Number(_evalBinary(seconds, r));
    const ns = nanos ? Number(_evalBinary(nanos, r)) : 0;
    const base = new Date(sec * 1000);
    const iso = base.toISOString().replace("Z", "");
    if (ns > 0) {
      const nsStr = String(ns).padStart(9, "0");
      return iso.slice(0, -4) + nsStr + "Z";
    }
    return iso + "Z";
  },
  "datetime.fromepochmillis": ([millis], r) => {
    const ms = Number(_evalBinary(millis, r));
    return new Date(ms).toISOString().replace("Z", "") + "Z";
  },
  date: ([a], r) => {
    if (!a) {
      const d = new Date();
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }
    const v = _evalBinary(a, r);
    if (typeof v === "string") {
      let str = v;
      if (str.startsWith("'") || str.startsWith('"')) str = str.slice(1, -1);
      if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
      return str;
    }
    if (v && typeof v === "object") {
      const map = v;
      const d = _resolveDateFromMap(map);
      return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
    }
    return null;
  },
  localtime: ([a], r) => {
    if (!a) {
      const d = new Date();
      return _formatTime(d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds() * 1000000);
    }
    const v = _evalBinary(a, r);
    if (v && typeof v === "object") {
      const map = v;
      const { hour, minute, second, nanosecond } = _extractTimeMap(map);
      return _formatTime(hour, minute, second, nanosecond);
    }
    return null;
  },
  time: ([a], r) => {
    if (!a) {
      const d = new Date();
      return _formatTime(d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds() * 1000000) + "Z";
    }
    const v = _evalBinary(a, r);
    if (v && typeof v === "object") {
      const map = v;
      const { hour, minute, second, nanosecond } = _extractTimeMap(map);
      const tz = map.timezone != null ? _formatTimezone(_resolveNamedTimezone(String(map.timezone))) : "Z";
      return _formatTime(hour, minute, second, nanosecond) + tz;
    }
    return null;
  },
  localdatetime: ([a], r) => {
    if (!a) {
      const d = new Date();
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0")
        + "T" + _formatTime(d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds() * 1000000);
    }
    const v = _evalBinary(a, r);
    if (v && typeof v === "object") {
      const map = v;
      const d = _resolveDateFromMap(map);
      const dateStr = d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
      const { hour, minute, second, nanosecond } = _extractTimeMap(map);
      return dateStr + "T" + _formatTime(hour, minute, second, nanosecond);
    }
    return null;
  },
  datetime: ([a], r) => {
    if (!a) {
      const d = new Date();
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0")
        + "T" + _formatTime(d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds() * 1000000) + "Z";
    }
    const v = _evalBinary(a, r);
    if (v && typeof v === "object") {
      const map = v;
      const d = _resolveDateFromMap(map);
      const dateStr = d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
      const { hour, minute, second, nanosecond } = _extractTimeMap(map);
      const tz = map.timezone != null ? _formatTimezone(_resolveNamedTimezone(String(map.timezone), d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())) : "Z";
      return dateStr + "T" + _formatTime(hour, minute, second, nanosecond) + tz;
    }
    return null;
  },
  duration: ([a], r) => {
    if (!a) return "PT0S";
    const v = _evalBinary(a, r);
    if (v && typeof v === "object") {
      const map = v;
      const AVG_DAYS_PER_MONTH = 30.436875;
      const _num = (k) => { const x = map[k]; return x != null ? Number(x) : 0; };
      let years = _num("years") || _num("year");
      let months = _num("months") || _num("month");
      let weeks = _num("weeks") || _num("week");
      let days = _num("days") || _num("day");
      let hours = _num("hours") || _num("hour");
      let minutes = _num("minutes") || _num("minute");
      let seconds = _num("seconds") || _num("second");
      let nanos = _resolveNanoseconds(map);
      // weeks → days
      if (weeks) { days += weeks * 7; weeks = 0; }
      // 分数分解
      if (years % 1 !== 0) { months += (years - Math.floor(years)) * 12; years = Math.floor(years); }
      if (months % 1 !== 0) { days += (months - Math.floor(months)) * AVG_DAYS_PER_MONTH; months = Math.floor(months); }
      if (days % 1 !== 0) { hours += (days - Math.floor(days)) * 24; days = Math.floor(days); }
      if (hours % 1 !== 0) { minutes += (hours - Math.floor(hours)) * 60; hours = Math.floor(hours); }
      if (minutes % 1 !== 0) { seconds += (minutes - Math.floor(minutes)) * 60; minutes = Math.floor(minutes); }
      if (seconds % 1 !== 0) { nanos += Math.round((seconds - Math.floor(seconds)) * 1e9); seconds = Math.floor(seconds); }
      // 进位
      if (nanos >= 1e9) { seconds += Math.floor(nanos / 1e9); nanos = nanos % 1e9; }
      if (seconds >= 60) { minutes += Math.floor(seconds / 60); seconds = seconds % 60; }
      if (minutes >= 60) { hours += Math.floor(minutes / 60); minutes = minutes % 60; }
      if (hours >= 24) { days += Math.floor(hours / 24); hours = hours % 24; }
      let nanosFormatted = "";
      if (nanos > 0) {
        // Duration 纳秒也需要去尾零（P22DT19H51M49.5S 而不是 .500000000S）
        let nsStr = String(nanos).padStart(9, "0").replace(/0+$/, "");
        nanosFormatted = "." + nsStr;
      }
      let result = "P";
      if (years) result += years + "Y";
      if (months) result += months + "M";
      if (days) result += days + "D";
      if (hours || minutes || seconds || nanos) {
        result += "T";
        if (hours) result += hours + "H";
        if (minutes) result += minutes + "M";
        if (seconds || nanos) result += seconds + nanosFormatted + "S";
      }
      return result || "PT0S";
    }
    return null;
  },
}

export function _callFunction(name: string, args: string[], row?: Record<string, unknown>): unknown {
  const fn = _builtinFunctions[name]
  return fn ? fn(args, row) : null
}

export function _evalBinary(s: string, row?: Record<string, unknown>): unknown {
  // Fast path: if no boolean operators or NOT, skip directly to comparison
  const t = s.trim()

  // Expression cache: cache pure literal expressions (no row dependency)
  const cacheKey = t
  const cached = _exprCache.get(cacheKey)
  if (cached !== undefined) return cached

  if (!/\b(OR|XOR|AND|NOT)\b/i.test(t)) return _evalAndCache(t, row, cacheKey)
  return _evalOr(t, row)
}

// Expression cache: Map<exprString, pure constant value>
// caches only side-effect-free constant expressions (1+2, 'hello', true)
// to avoid re-parsing on every call
const _exprCache = new Map<string, unknown>()

function _evalAndCache(t: string, row: Record<string, unknown> | undefined, key: string): unknown {
  if (row === undefined) return _evalComparison(t, row)
  const result = _evalComparison(t, row)

  // Cache pure constants: no row-dependent variables or quoted strings
  if (t.length <= 100 && !/[({]/.test(t) && !/CASE\b/i.test(t) && !/EXISTS\b/i.test(t)) {
    const stripped = t.replace(/['"\`][^'"\`]*['"\`]/g, '').replace(/\d+(?:\.\d+)?/g, '')
    const hasVar = (stripped.match(/[a-zA-Z_]\w*/g) || []).some(v => {
      const kw = ['true','false','null','undefined','NaN','Infinity','length','name','constructor','prototype','type','id','toLower','toUpper','trim','replace','substring','left','right','size','reverse','toString','keys','head','last','tail','floor','ceil','round','abs','rand','sqrt','sign','sin','cos','tan','log','exp','e','pi']
      return !kw.includes(v.toLowerCase())
    })
    if (!hasVar) _exprCache.set(key, result)
  }
  return result
}

export function _assertBool(v: unknown, expr: string): void {
  if (typeof v !== 'boolean' && v != null) {
    throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
  }
}

export function _evalOr(s: string, row?: Record<string, unknown>): unknown {
  const parts = _splitTopLevel(s, 'OR')
  if (parts.length === 1) return _evalXor(s, row)
  const values = parts.map(p => _evalXor(p, row))
  for (const v of values) {
    if (typeof v !== 'boolean' && v != null) {
      throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
    }
  }
  let result: unknown = false
  for (const v of values) {
    if (v === true) return true
    if (v == null || v === undefined) result = null
  }
  return result
}

export function _evalXor(s: string, row?: Record<string, unknown>): unknown {
  const parts = _splitTopLevel(s, 'XOR')
  if (parts.length === 1) return _evalAnd(s, row)
  const values = parts.map(p => _evalAnd(p, row))
  for (const v of values) { _assertBool(v, '') }
  if (parts.length >= 3) {
    let trueCount = 0
    for (const v of values) {
      if (v == null || v === undefined) return null
      if (v === true) trueCount++
    }
    return trueCount % 2 === 1
  }
  const left = values[0], right = values[1]
  if (left == null || right == null) return null
  return left !== right
}

export function _evalAnd(s: string, row?: Record<string, unknown>): unknown {
  const parts = _splitTopLevel(s, 'AND')
  if (parts.length === 1) return _evalNot(s, row)
  // Cypher 要求：所有操作数必须验证布尔类型（即使短路）
  const values = parts.map(p => _evalNot(p, row))
  for (const v of values) {
    if (typeof v !== 'boolean' && v != null) {
      throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
    }
  }
  let result: unknown = true
  for (const v of values) {
    _assertBool(v, '')
    if (v === false) return false
    if (v == null || v === undefined) result = null
  }
  return result
}

export function _evalNot(s: string, row?: Record<string, unknown>): unknown {
  const t = s.trim()
  if (t.startsWith('NOT ')) {
    const inner = _evalBinary(t.slice(4), row)
    _assertBool(inner, '')
    return inner === null ? null : !Boolean(inner)
  }
  if (t.startsWith('NOT(') && t.endsWith(')')) {
    const inner = _evalBinary(t.slice(4, -1), row)
    _assertBool(inner, '')
    return inner === null ? null : !Boolean(inner)
  }
  return _evalComparison(s, row)
}

/** 提取 Cypher 链式比较中的所有操作符/操作数对
 *  n.prop1 < m.prop1 = n.prop2 <> m.prop2 → [
 *   { left: "n.prop1", op: "<", right: "m.prop1" },
 *   { left: "m.prop1", op: "=", right: "n.prop2" },
 *   { left: "n.prop2", op: "<>", right: "m.prop2" }
 * ]
 *  1 < n.num < 3 → [{left:"1",op:"<",right:"n.num"},{left:"n.num",op:"<",right:"3"}]
 */
export function _extractChain(expr: string): Array<{ left: string; op: string; right: string }> {
  const ops = ['<>', '>=', '<=', '=', '>', '<']
  // 找所有顶层操作符位置
  const positions: Array<{ idx: number; op: string }> = []
  for (const op of ops) {
    const idx = _findTopLevelOp(expr, op)
    if (idx > 0) positions.push({ idx, op })
  }
  if (positions.length < 2) return []  // 少于 2 个操作符 → 不是链式
  // 按位置排序
  positions.sort((a, b) => a.idx - b.idx)
  // 过滤：如果两个相邻操作符重叠（如 <> 的内部包含了 < 或 >），去掉子操作符
  const filtered: typeof positions = [positions[0]]
  for (let i = 1; i < positions.length; i++) {
    const prev = filtered[filtered.length - 1]
    // 如果当前操作符起始位置在前一个操作符范围内，跳过（子字符串匹配）
    if (positions[i].idx < prev.idx + prev.op.length) continue
    filtered.push(positions[i])
  }
  if (filtered.length < 2) return []
  // 构建操作数/操作符对
  const result: Array<{ left: string; op: string; right: string }> = []
  for (let i = 0; i < filtered.length; i++) {
    const { idx, op } = filtered[i]
    const left = i === 0 ? expr.slice(0, idx) : result[i - 1].right
    const nextStart = idx + op.length
    const rightEnd = i < filtered.length - 1 ? filtered[i + 1].idx : expr.length
    const right = expr.slice(nextStart, rightEnd).trim()
    result.push({ left: left.trim(), op, right })
  }
  return result
}

export function _evalComparison(s: string, row?: Record<string, unknown>): unknown {
  const t = s.trim()
  // 辅助：截断操作数到第一个布尔操作符（OR/XOR/AND），用于 STARTS_WITH/CONTAINS/ENDS_WITH 右操作数
  const _trimToOperand = (s2: string): string => {
    let depth = 0, inStr = false, strChar = ''
    for (let i = 0; i < s2.length; i++) {
      if (inStr && s2[i] === '\\') { i++; continue }
      if (inStr) { if (s2[i] === strChar) inStr = false; continue }
      if (s2[i] === "'" || s2[i] === '"') { inStr = true; strChar = s2[i]; continue }
      if (s2[i] === '(' || s2[i] === '[' || s2[i] === '{') { depth++; continue }
      if (s2[i] === ')' || s2[i] === ']' || s2[i] === '}') { depth--; if (depth < 0) depth = 0; continue }
      if (depth === 0) {
        if (s2.slice(i, i + 3) === ' OR ' || s2.slice(i, i + 4) === ' XOR ' || s2.slice(i, i + 4) === ' AND ') return s2.slice(0, i).trim()
      }
    }
    return s2.trim()
  }
  const _completeBoolean = (leftVal: unknown, after: string, row2?: Record<string, unknown>): unknown => {
    const m = after.match(/^(AND|OR|XOR)\b/i)
    if (!m) return _evalBinary(`${leftVal} ${after}`, row2)
    const op = m[1].toLowerCase()
    const rest = after.slice(m[0].length).trim()
    if (op === 'and') return (leftVal && _evalBinary(rest, row2))
    if (op === 'or') return (leftVal || _evalBinary(rest, row2))
    if (op === 'xor') return ((leftVal ? 1 : 0) ^ (_evalBinary(rest, row2) ? 1 : 0)) !== 0
    return _evalBinary(`${leftVal} ${after}`, row2)
  }
  // 括号表达式直接下推（NOT 之后、进入比较操作符前）
  // 必须确认整个表达式被一对完整括号包围：第一个 '(' 对应的 ')' 正好在末尾
  if (t.startsWith('(') && t.endsWith(')') && _isBalanced(t)) {
    let depth = 0, matchIdx = -1
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') depth++
      if (t[i] === ')') { depth--; if (depth === 0) { matchIdx = i; break } }
    }
    if (matchIdx === t.length - 1) return _evalBinary(t.slice(1, -1), row)
  }
  const re = t.indexOf(' =~ ')
  if (re > 0) { const l = String(_evalAddSub(t.slice(0, re), row)); const r = String(_evalAddSub(t.slice(re + 4), row)); try { return new RegExp(r).test(l) } catch { return false } }
  // 预处理 IS NULL / IS NOT NULL：递归计算每个表达式中的 IS 后缀
  const _resolveIsNull = (expr: string): unknown => {
    const ex = expr.trim()
    // 括号表达式：递归计算内部
    if (ex.startsWith('(') && ex.endsWith(')') && _isBalanced(ex)) {
      let depth = 0, matchIdx = -1
      for (let i = 0; i < ex.length; i++) {
        if (ex[i] === '(') depth++
        if (ex[i] === ')') { depth--; if (depth === 0) { matchIdx = i; break } }
      }
      if (matchIdx === ex.length - 1) return _evalBinary(ex.slice(1, -1), row)
    }
    // 查找 IS NULL / IS NOT NULL（不在括号、字符串内）
    let isPos = -1, depth = 0, inStr = false, strChar = ''
    for (let i = 0; i < ex.length; i++) {
      if (inStr && ex[i] === '\\') { i++; continue }
      if (inStr) { if (ex[i] === strChar) inStr = false; continue }
      if (ex[i] === "'" || ex[i] === '"') { inStr = true; strChar = ex[i]; continue }
      if (ex[i] === '(' || ex[i] === '[' || ex[i] === '{') { depth++; continue }
      if (ex[i] === ')' || ex[i] === ']' || ex[i] === '}') { depth--; continue }
      if (depth === 0 && i + 2 < ex.length && ex[i] === 'I' && ex[i + 1] === 'S' && !/\w/.test(ex[i + 2] || '')) {
        isPos = i; break
      }
    }
    if (isPos > 0) {
      const leftExpr = ex.slice(0, isPos).trim()
      const rest = ex.slice(isPos).trim()
      const isnMatch = rest.match(/^IS\s+(NOT\s+)?NULL/i)
      if (isnMatch) {
        const isNotNull = !!isnMatch[1]
        const leftVal = _evalAddSub(leftExpr, row)
        // Cypher: x IS NULL → (x == null), x IS NOT NULL → (x != null)
        const isResult = leftVal == null ? !isNotNull : isNotNull
        const after = rest.slice(isnMatch[0].length).trim()
        if (after) return _evalComparison(`${isResult} ${after}`, row)
        return isResult
      }
    }
    // 无 IS 后缀，走正常 _evalAddSub
    return _evalAddSub(ex, row)
  }
  // IN 处理：找顶层（不在括号内）的 IN
  const inOp = (() => {
    let idx = t.lastIndexOf(' IN ')
    while (idx > 0 && _inBrackets(t, idx)) {
      idx = t.lastIndexOf(' IN ', idx - 1)
    }
    return idx
  })()
  if (inOp > 0) {
    const leftPart = t.slice(0, inOp)
    // 如果左侧有顶层比较操作符，则 IN 不应抢先（要等 = 先计算）
    const hasTopLevelCmp = ['<>', '>=', '<=', '=', '>', '<'].some(op => {
      const opIdx = _findTopLevelOp(leftPart, op)
      return opIdx > 0
    })
    if (!hasTopLevelCmp) {
      const l = _evalAddSub(leftPart, row)
      const r = _evalAddSub(t.slice(inOp + 4), row)
      // Cypher: null IN null = null, null IN [] = false
      if (!Array.isArray(r)) return l == null ? null : false
      // Cypher: 左操作数 null → 空列表返回 false（确定性），非空列表返回 null（未知）
      if (l == null) return r.length === 0 ? false : null
      let hasMatch = false
      let hasNull = false
      for (const item of r) {
        if (item != null) {
          const eq = _deepEqWithNull(l, item)
          if (eq.match === true && !eq.hasNull) { hasMatch = true }
          if (eq.hasNull) { hasNull = true }
        } else { hasNull = true }
      }
      if (hasMatch) return true
      if (hasNull) return null
      return false
    }
  }
  // 通用链式比较：检测多段链（任意操作符组合），如 a < b = c <> d 或 a < b < c
  const chainOps = _extractChain(t)
  if (chainOps.length >= 2) {
    // Cypher 链式语义：expr OP1 expr2 OP2 expr3 = (expr OP1 expr2) AND (expr2 OP2 expr3)
    // 从左到右依次计算每对操作符
    let result: unknown = true
    for (let i = 0; i < chainOps.length; i++) {
      const { left: l, op: cop, right: r } = chainOps[i]
      const leftVal = _resolveIsNull(l.trim())
      const rightVal = _resolveIsNull(r.trim())
      const cmp = _compareValues(leftVal, rightVal, cop)
      if (cmp === false) return false
      if (cmp == null) result = null
    }
    return result
  }

  for (const op of ['<>', '>=', '<=', '=', '>', '<']) {
    // 链式比较：a = b = c 等价于 (a = b) AND (b = c)
    // 对 =, <>, >=, <=, >, < 支持链式（>= 3 段）
    if (op === '=' || op === '<>' || op === '>=' || op === '<=' || op === '>' || op === '<') {
      const parts = _splitTopLevel(t, op)
      if (parts.length >= 3) {
        let result: unknown = true
        for (let i = 0; i < parts.length - 1; i++) {
          const left = _resolveIsNull(parts[i].trim())
          const right = _resolveIsNull(parts[i + 1].trim())
          const cmp = _compareValues(left, right, op)
          if (cmp === false) return false
          if (cmp == null) result = null
        }
        return result
      }
    }
    const idx = _findTopLevelOp(t, op)
    if (idx > 0) {
      // DEBUG: Precedence4[4] trace
      if (t.includes('STARTS WITH') && t.includes('<>')) {
        //console.log('_evalComparison trace:', {op, t: t.slice(0,100), idx, leftRaw: t.slice(0, idx), rightRaw: t.slice(idx + op.length)})
      }
      const left = _resolveIsNull(t.slice(0, idx))
      let rawRight = t.slice(idx + op.length).trim()
      // Cypher 优先级：IS NULL/IS NOT NULL > 比较操作符
      // 所以 a = b IS NULL 应解析为 a = (b IS NULL) 而非 (a = b) IS NULL
      // 检查 rawRight 末尾是否含 IS NULL（大小写不敏感）
      let isNullRight: boolean | undefined
      const isNullSuffix = _endsWithIsNull(rawRight)
      if (isNullSuffix === 'IS NULL') {
        const innerExpr = rawRight.slice(0, rawRight.length - 7).trim()
        const innerVal = _evalAddSub(innerExpr, row)
        isNullRight = (innerVal === null || innerVal === undefined)
        rawRight = String(isNullRight)
      } else if (isNullSuffix === 'IS NOT NULL') {
        const innerExpr = rawRight.slice(0, rawRight.length - 11).trim()
        const innerVal = _evalAddSub(innerExpr, row)
        isNullRight = (innerVal !== null && innerVal !== undefined)
        rawRight = String(isNullRight)
      }
      // 如果 right 包含顶层 IN，在 _evalAddSub 前处理（IN 优先级 >= 比较操作符）
      const inIdx = rawRight.indexOf(' IN ')
      let right: unknown
      if (inIdx > 0 && !_inBrackets(rawRight, inIdx)) {
        // 在 _evalAddSub 中 IN 会被解析为 null，所以先计算 IN
        const rl = _evalAddSub(rawRight.slice(0, inIdx), row)
        const rr = _evalAddSub(rawRight.slice(inIdx + 4), row)
        right = Array.isArray(rr) && rr.includes(rl)
      } else {
        right = _evalAddSub(rawRight, row)
      }
      return _compareValues(left, right, op)
    }
  }
  // 纯 IS NULL / IS NOT NULL 表达式（大小写不敏感）
  const isNullEnd = _endsWithIsNull(t)
  if (isNullEnd === 'IS NULL') {
    const innerVal = _evalAddSub(t.slice(0, t.length - 7).trim(), row)
    return innerVal === null || innerVal === undefined
  }
  if (isNullEnd === 'IS NOT NULL') {
    const innerVal = _evalAddSub(t.slice(0, t.length - 11).trim(), row)
    return innerVal !== null && innerVal !== undefined
  }
  // 字符串谓语（STARTS WITH / CONTAINS / ENDS WITH）优先级低于比较操作符（= / <> / 链式）
  // 因此放在比较操作符处理之后、回退到 _evalAddSub 之前
  const _findTopLevelKw = (kw: string): number => {
    let idx = t.indexOf(kw)
    while (idx > 0 && _inBrackets(t, idx)) {
      idx = t.indexOf(kw, idx + 1)
    }
    return idx
  }
  const sw = _findTopLevelKw(' STARTS WITH ')
  if (sw > 0) { const l = _evalAddSub(t.slice(0, sw), row); const rPart = _trimToOperand(t.slice(sw + 13)); const r = _evalAddSub(rPart, row); if (l == null || r == null || typeof l !== 'string' || typeof r !== 'string') return null; const swResult = l.startsWith(r); const after = (t.slice(sw + 13).length > rPart.length) ? t.slice(sw + 13 + rPart.length).trim() : ''; return after ? _completeBoolean(swResult, after, row) : swResult }
  const ci = _findTopLevelKw(' CONTAINS ')
  if (ci > 0) { const l = _evalAddSub(t.slice(0, ci), row); const rPart = _trimToOperand(t.slice(ci + 10)); const r = _evalAddSub(rPart, row); if (l == null || r == null || typeof l !== 'string' || typeof r !== 'string') return null; const ciResult = l.includes(r); const after = (t.slice(ci + 10).length > rPart.length) ? t.slice(ci + 10 + rPart.length).trim() : ''; return after ? _completeBoolean(ciResult, after, row) : ciResult }
  const ew = _findTopLevelKw(' ENDS WITH ')
  if (ew > 0) { const l = _evalAddSub(t.slice(0, ew), row); const rPart = _trimToOperand(t.slice(ew + 11)); const r = _evalAddSub(rPart, row); if (l == null || r == null || typeof l !== 'string' || typeof r !== 'string') return null; const ewResult = l.endsWith(r); const after = (t.slice(ew + 11).length > rPart.length) ? t.slice(ew + 11 + rPart.length).trim() : ''; return after ? _completeBoolean(ewResult, after, row) : ewResult }
  return _evalAddSub(t, row)
}

/** Cypher 列表字典序比较 */
export function _listLexCompare(a: unknown[], b: unknown[], op: string): boolean | null {
  const minLen = Math.min(a.length, b.length)
  for (let i = 0; i < minLen; i++) {
    const ai = a[i], bi = b[i]
    if (ai == null || bi == null) {
      return null  // null 在列表中 → 三值不确定
    }
    const isLeOrGe = (op === '<=' || op === '>=')

    if (ai === bi) continue  // 相等 → 继续下一个元素

    // 列表字典序：第一个不相等的元素决定结果
    if (isLeOrGe) {
      // <= 或 >=：先做 =（已由 ai===bi 处理），再做 < 或 >
      // 如果 ai !== bi，退化到 < 或 >
      const dir = op === '<=' ? '<' : '>'
      return _compareValues(ai, bi, dir)
    }
    // < 或 >：直接比较当前元素
    return _compareValues(ai, bi, op)
  }
  // 所有同索引元素相等
  if (a.length === b.length) return op === '>=' || op === '<=' ? true : false
  // 长度不等 → 短列表视为小于长列表
  // 注意：大于号/小于号的不等比较不因多余元素含 null 而返回 null（规范：短列表总是较小的）
  // 等号比较带 null 元素：长度不等时 = 为 false，所以不需要 null 检查
  const isLtGt = op === '>' || op === '<'
  const isLeGe = op === '>=' || op === '<='
  if (isLeGe) {
    // >= 或 <=：退化到 > 或 <（长度不等时 = 不成立），不检查多余元素中的 null
    if (op === '>=') return a.length >= b.length
    if (op === '<=') return a.length <= b.length
  }
  if (isLtGt) {
    // > 或 <：直接比较长度，不检查多余元素中的 null
    if (op === '>') return a.length > b.length
    if (op === '<') return a.length < b.length
  }
  return false
}

/** Check if two values are of comparable types (both numeric types treated as same) */
export function _comparableTypes(a: unknown, b: unknown): boolean {
  const ta = typeof a
  const tb = typeof b
  if (ta === tb) return true
  // bigint and number are both numeric — treat as comparable
  if ((ta === 'bigint' && tb === 'number') || (ta === 'number' && tb === 'bigint')) return true
  return false
}

export function _compareValues(a: unknown, b: unknown, op: string): boolean | null {
  if (a == null || b == null) return null  // Cypher 三值逻辑

  // Fast path: same-type number (most common comparison in practice)
  if (typeof a === 'number' && typeof b === 'number') {
    switch (op) {
      case '=': return a === b
      case '<>': return a !== b
      case '<': return a < b
      case '>': return a > b
      case '<=': return a <= b
      case '>=': return a >= b
    }
  }

  // List 字典序比较（>=, >, <=, <）
  if (Array.isArray(a) && Array.isArray(b) && (op === '>=' || op === '<=' || op === '>' || op === '<')) {
    return _listLexCompare(a, b, op)
  }
  switch (op) {
    case '=': { const __eq = _deepEqWithNull(a, b); return __eq.hasNull ? null : __eq.match }
    case '<>': return !_deepEq(a, b)
    case '<': {
      if (!_comparableTypes(a, b)) return null
      if (typeof a === 'string') return a < b  // 字典序
      return Number(a) < Number(b)
    }
    case '>': {
      if (!_comparableTypes(a, b)) return null
      if (typeof a === 'string') return a > b
      return Number(a) > Number(b)
    }
    case '<=': {
      if (!_comparableTypes(a, b)) return null
      if (typeof a === 'string') return a <= b
      return Number(a) <= Number(b)
    }
    case '>=': {
      if (!_comparableTypes(a, b)) return null
      if (typeof a === 'string') return a >= b
      return Number(a) >= Number(b)
    }
  }
  return false
}

export function _isNaN(v: unknown): boolean {
  return typeof v === 'number' && isNaN(v)
}

/** Cypher 深度相等：支持 List、Map 递归比较，符合三值逻辑（null 元素 = → null） */
/** Cypher 深度相等（含 null 传播，用于 = 比较） */
/** 大小写不敏感检测字符串是否以 IS NULL 或 IS NOT NULL 结尾 */
export function _endsWithIsNull(s: string): 'IS NULL' | 'IS NOT NULL' | false {
  const u = s.toUpperCase()
  if (u.endsWith('IS NULL') && !_inBrackets(s, s.length - 7)) return 'IS NULL'
  if (u.endsWith('IS NOT NULL') && !_inBrackets(s, s.length - 11)) return 'IS NOT NULL'
  return false
}

export function _deepEqWithNull(a: unknown, b: unknown): { match: boolean; hasNull: boolean } {
  if (a === b) return { match: true, hasNull: a == null || b == null }
  if (a == null || b == null) return { match: a === b, hasNull: true }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return { match: false, hasNull: false }
    let hasNull = false
    for (let i = 0; i < a.length; i++) {
      const eq = _deepEqWithNull(a[i], b[i])
      if (eq.hasNull) { hasNull = true; continue }
      if (!eq.match) return { match: false, hasNull: false }
    }
    return { match: true, hasNull }
  }
  if (typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keysA = Object.keys(a as Record<string, unknown>).sort()
    const keysB = Object.keys(b as Record<string, unknown>).sort()
    if (keysA.length !== keysB.length) return { match: false, hasNull: false }
    let hasNull = false
    for (let i = 0; i < keysA.length; i++) {
      if (keysA[i] !== keysB[i]) return { match: false, hasNull: false }
      const eq = _deepEqWithNull((a as any)[keysA[i]], (b as any)[keysB[i]])
      if (eq.hasNull) { hasNull = true; continue }
      if (!eq.match) return { match: false, hasNull: false }
    }
    return { match: true, hasNull }
  }
  return { match: a === b, hasNull: false }
}

/** 浅层深度相等（不含 null 传播，用于 <> 和简单比较） */
export function _deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (a[i] == null || b[i] == null) return false
      if (!_deepEq(a[i], b[i])) return false
    }
    return true
  }
  if (typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keysA = Object.keys(a as Record<string, unknown>).sort()
    const keysB = Object.keys(b as Record<string, unknown>).sort()
    if (keysA.length !== keysB.length) return false
    for (let i = 0; i < keysA.length; i++) {
      if (keysA[i] !== keysB[i]) return false
      if ((a as any)[keysA[i]] == null || (b as any)[keysB[i]] == null) return false
      if (!_deepEq((a as any)[keysA[i]], (b as any)[keysB[i]])) return false
    }
    return true
  }
  // 大整数精度补偿：string vs bigint 语义相等比较
  if (typeof a === 'bigint' && typeof b === 'string') {
    try { return a === BigInt(b) } catch { return false }
  }
  if (typeof b === 'bigint' && typeof a === 'string') {
    try { return BigInt(a) === b } catch { return false }
  }
  return a === b
}

export function _evalAddSub(s: string, row?: Record<string, unknown>): unknown {
  const t = s.trim()
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i] === '+' && !_inBrackets(t, i) && !_inString(t, i) && !(i > 0 && 'eE'.includes(t[i - 1]))) {
      const left = _evalAddSub(t.slice(0, i), row)
      const right = _evalMulDiv(t.slice(i + 1), row)
      // Cypher: null 参与算术 → 返回 null
      if (left == null || right == null) return null
      // Cypher + 语义: list+list(拼接), list+scalar(追加), scalar+list(前置), number+number(加法), string+any(连接)
      if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right]
      if (Array.isArray(left) && !Array.isArray(right)) return [...left, right]
      if (!Array.isArray(left) && Array.isArray(right)) return [left, ...right]
      return typeof left === 'string' || typeof right === 'string' ? String(left) + String(right) : Number(left) + Number(right)
    }
    if (t[i] === '-' && !_inBrackets(t, i) && !_inString(t, i) && i > 0 && !'+-*/%('.includes(t[i - 1]) && !'eE'.includes(t[i - 1])) {
      const left = _evalAddSub(t.slice(0, i), row)
      const right = _evalMulDiv(t.slice(i + 1), row)
      if (left == null || right == null) return null
      return Number(left) - Number(right)
    }
  }
  return _evalMulDiv(t, row)
}

export function _evalMulDiv(s: string, row?: Record<string, unknown>): unknown {
  const t = s.trim()
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i] === '*' && !_inBrackets(t, i) && !_inString(t, i)) { const left = _evalMulDiv(t.slice(0, i), row); const right = _evalExp(t.slice(i + 1), row); if (left == null || right == null) return null; return Number(left) * Number(right) }
    if (t[i] === '/' && !_inBrackets(t, i) && !_inString(t, i)) { const left = _evalMulDiv(t.slice(0, i), row); const right = _evalExp(t.slice(i + 1), row); if (left == null || right == null) return null; const nl = Number(left), nr = Number(right); return Number.isInteger(nl) && Number.isInteger(nr) ? Math.trunc(nl / nr) : nl / nr }
    if (t[i] === '%' && !_inBrackets(t, i) && !_inString(t, i)) { const left = _evalMulDiv(t.slice(0, i), row); const right = _evalExp(t.slice(i + 1), row); if (left == null || right == null) return null; return Number(left) % Number(right) }
  }
  return _evalExp(t, row)
}

/** 指数运算 `^`，优先级高于 * / %，左结合：2 ^ 3 ^ 2 = (2 ^ 3) ^ 2 */
export function _evalExp(s: string, row?: Record<string, unknown>): unknown {
  const t = s.trim()
  // 左结合：从左向右扫描，左操作数用 _evalUnary 或 _evalExp（处理左侧 ^）
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i] === '^' && !_inBrackets(t, i) && !_inString(t, i)) {
      const left = _evalExp(t.slice(0, i).trim(), row)
      const right = _evalUnary(t.slice(i + 1).trim(), row)
      if (left == null || right == null) return null
      return Math.pow(Number(left), Number(right))
    }
  }
  return _evalUnary(t, row)
}

export function _evalUnary(s: string, row?: Record<string, unknown>): unknown {
  const t = s.trim()
  if (t.startsWith('-')) {
    const inner = _evalUnary(t.slice(1), row)
    if (inner == null) return null
    return typeof inner === 'bigint' ? -inner : -Number(inner)
  }
  if (t.startsWith('+')) {
    const inner = _evalUnary(t.slice(1), row)
    if (inner == null) return null
    return typeof inner === 'bigint' ? inner : Number(inner)
  }
  return _evalAtom(t, row)
}

export function _evalAtom(s: string, row?: Record<string, unknown>): unknown {
  const t = s.trim()
  // ── 标签谓词：(n:Foo) → 检查 n 是否有标签 Foo（必须在括号剥离之前处理）──
  if (t.startsWith('(') && t.endsWith(')') && _isBalanced(t)) {
    const labelPredMatch = t.match(/^\((\w*)\s*:\s*(\w+)\)$/)
    if (labelPredMatch) {
      const varName = labelPredMatch[1]
      const labelName = labelPredMatch[2]
      if (!varName) return null  // (:Foo) without variable → null
      const nodeRef = row?.[varName] as Record<string, unknown> | undefined
      if (nodeRef && typeof nodeRef === 'object' && !Array.isArray(nodeRef)) {
        const props = (nodeRef as any).props
        if (props && props._label) return props._label === labelName
        if (nodeRef._label) return nodeRef._label === labelName
      }
      if (row && typeof row === 'object' && '_label' in row) {
        const label = (row as any)._label
        const fullLabel = (row as any).__fullLabel
        if (typeof fullLabel === 'string') {
          return fullLabel.split(':').includes(labelName)
        }
        return label === labelName
      }
      return null
    }
  }
  if (t.startsWith('(') && t.endsWith(')') && _isBalanced(t) && !t.match(/^\w+\(/)) {
    let depth = 0, parenEnd = -1
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') depth++
      if (t[i] === ')') { depth--; if (depth === 0 && parenEnd < 0) { parenEnd = i; break } }
    }
    if (parenEnd === t.length - 1) return _evalBinary(t.slice(1, -1), row)
  }
  // ── 标签谓词独立处理（当 _evalComparison 已经剥离括号后，n:Foo 会被传递到这里）──
  const standaloneLabelPred = t.match(/^(\w+)\s*:\s*(\w+)$/)
  if (standaloneLabelPred) {
    const varName = standaloneLabelPred[1]
    const labelName = standaloneLabelPred[2]
    const nodeRef = row?.[varName] as Record<string, unknown> | undefined
    if (nodeRef && typeof nodeRef === 'object' && !Array.isArray(nodeRef)) {
      const props = (nodeRef as any).props
      if (props && props._label) return props._label === labelName
      if (nodeRef._label) return nodeRef._label === labelName
    }
    if (row && typeof row === 'object' && '_label' in row) {
      const label = (row as any)._label
      const fullLabel = (row as any).__fullLabel
      if (typeof fullLabel === 'string') {
        return fullLabel.split(':').includes(labelName)
      }
      return label === labelName
    }
    return null
  }
  // 括号 + 后缀 IS NULL/IS NOT NULL： (expr) IS NULL → 先计算 expr，再判 null
  if (t.startsWith('(') && (t.endsWith(' IS NULL') || t.endsWith(' IS NOT NULL'))) {
    let depth = 0, parenEnd = -1
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') depth++
      if (t[i] === ')') { depth--; if (depth === 0) { parenEnd = i; break } }
    }
    if (parenEnd > 0) {
      const innerExpr = t.slice(1, parenEnd)
      const suffix = t.slice(parenEnd + 1).trim()
      const innerVal = _evalBinary(innerExpr, row)
      if (suffix.toUpperCase() === 'IS NULL') return (innerVal === null || innerVal === undefined)
      if (suffix.toUpperCase() === 'IS NOT NULL') return (innerVal !== null && innerVal !== undefined)
    }
  }
  // 括号表达式 + 下标后缀：(expr)[n] 或 (expr)[start..end]
  if (t.startsWith('(') && !t.endsWith(')')) {
    let depth = 0, parenEnd = -1
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') depth++
      if (t[i] === ')') { depth--; if (depth === 0) { parenEnd = i; break } }
    }
    if (parenEnd > 0) {
      const innerExpr = t.slice(1, parenEnd)
      let val = _evalBinary(innerExpr, row)
      let pos = parenEnd + 1
      // 如果括号后不是 [ 下标，而是其他操作符（OR/AND/XOR 等），用 _evalBinary 继续计算
      while (pos < t.length && t[pos] === ' ') pos++
      if (pos < t.length && t[pos] !== '[') {
        const suffix = t.slice(pos).trim()
        // 处理 .prop 属性访问（不拼接字符串，直接访问对象属性）
        if (suffix.startsWith('.') && val && typeof val === 'object') {
          const propName = suffix.slice(1).trim()
          if (Array.isArray(val)) {
            // 数组上的 .prop — 数组不支持属性访问
            return null
          }
          return (val as Record<string, unknown>)[propName] ?? null
        }
        if (suffix) return _evalBinary(`${val} ${suffix}`, row)
        return val
      }
      while (pos < t.length && t[pos] === '[') {
        const endBracket = t.indexOf(']', pos)
        if (endBracket < 0) break
        const inner = t.slice(pos + 1, endBracket)
        const rangeIdx = inner.indexOf('..')
        if (rangeIdx >= 0) {
          const startStr = inner.slice(0, rangeIdx).trim()
          const endStr = inner.slice(rangeIdx + 2).trim()
          const len = Array.isArray(val) ? val.length : (typeof val === 'string' ? val.length : 0)
          let startVal = startStr ? _evalBinary(startStr, row) : 0
          let endVal = endStr ? _evalBinary(endStr, row) : len
          if (startVal == null || endVal == null) { val = null; break }
          let sliceStart = Number(startVal), sliceEnd = Number(endVal)
          if (isNaN(sliceStart)) sliceStart = 0
          if (isNaN(sliceEnd)) sliceEnd = len
          if (sliceStart < 0) sliceStart = Math.max(len + sliceStart, 0)
          if (sliceEnd < 0) sliceEnd = Math.max(len + sliceEnd, 0)
          val = Array.isArray(val) ? val.slice(sliceStart, sliceEnd) : (typeof val === 'string' ? val.slice(sliceStart, sliceEnd) : null)
        } else {
          const idx = _evalBinary(inner, row)
          if (Array.isArray(val)) {
            if (idx == null) { val = null }
            else if (typeof idx !== 'number' || !Number.isInteger(idx)) throw Object.assign(new Error('TypeError: List index must be an integer'), { tckError: 'TypeError' })
            else val = val[Number(idx)] ?? null
          } else if (val && typeof val === 'object' && !Array.isArray(val)) {
            if (idx == null) { val = null }
            else if (typeof idx !== 'string') throw Object.assign(new Error('TypeError: Map index must be a string'), { tckError: 'TypeError' })
            else val = (val as Record<string, unknown>)[idx] ?? null
          } else { val = null }
        }
        pos = endBracket + 1
      }
      return val
    }
  }
  // 列表谓词（必须在 fnMatch 之前，因为 all/any/none/single 的 WHERE 子句与普通函数语法冲突）
  const listPredMatch = t.match(/^(all|any|none|single)\s*\((.+?)\s+IN\s+(.+?)\s+WHERE\s+(.+)\)$/is)
  if (listPredMatch) {
    const pred = listPredMatch[1].toLowerCase()
    const varName = listPredMatch[2].trim()
    const listExpr = listPredMatch[3].trim()
    const condExpr = listPredMatch[4].trim()
    const list = _evaluateExpression(listExpr, row)
    if (!Array.isArray(list)) return null
    let count = 0
    let hasNull = false
    let hasFalse = false
    const listLen = list.length
    for (const item of list) {
      const evalCtx: Record<string, unknown> = { ...row as any, [varName]: item }
      const val = _evaluateExpression(condExpr, evalCtx)
      // Cypher 的 all() 全称量化：如果元素为 null，则视为"不在论域"，
      // 跳过该元素（不评估 predicate）。这与 none/any/single 不同，
      // none/any/single 需要区分"null 元素导致 predicate 未知"。
      // 跳过条件：predicate 是纯变量引用且引用的值为 null。
      if (val === null && condExpr === varName) continue
      if (val === true) {
        count++
        if (pred === 'any') return true
        if (pred === 'none') return false
        if (pred === 'single' && count > 1) return false
      } else if (val === false) {
        hasFalse = true
        if (pred === 'all' && hasFalse) return false
      } else if (val == null) {
        hasNull = true
      }
    }
    if (pred === 'all') {
      if (listLen === 0) return true
      if (hasFalse) return false
      // 有未跳过的 null 元素 → null（三值逻辑不确定）
      if (hasNull) return null
      // 所有元素都匹配
      return true
    }
    if (pred === 'any') return hasNull ? null : false
    if (pred === 'none') return hasNull ? null : true
    if (pred === 'single') return (hasNull && count <= 1) ? null : count === 1
  }
  // 函数调用（必须在 dot 之前）
  const fnMatch = t.match(/^(\w+)\((.+?)\)$/s)
  if (fnMatch) {
    const args = fnMatch[2].trim() ? _parseCommaList(fnMatch[2]).map(a => a.trim()) : []
    return _callFunction(fnMatch[1].toLowerCase(), args, row)
  }
  // 如果包含顶层 `^`，是表达式而非纯字面量，委托给 _evalExp
  if (t.includes('^')) {
    let depth = 0, inStr = false, strChar = ''
    for (let i = 0; i < t.length; i++) {
      if (inStr && t[i] === '\\') { i++; continue }
      if (inStr) { if (t[i] === strChar) inStr = false; continue }
      if (t[i] === "'" || t[i] === '"') { inStr = true; strChar = t[i]; continue }
      if (t[i] === '(' || t[i] === '[' || t[i] === '{') { depth++; continue }
      if (t[i] === ')' || t[i] === ']' || t[i] === '}') { depth--; continue }
      if (depth === 0 && t[i] === '^') return _evalExp(t, row)
    }
  }
  // 字面量先行（避免 . 被当属性访问）— 但如果字面量有后缀索引 [n]，先走下标分支
  if (t.startsWith("'") || t.startsWith('"') || t.startsWith('[') || t.startsWith('{') || /^-?\d/.test(t) || t.startsWith('.') || t.toLowerCase() === 'null' || t.toLowerCase() === 'true' || t.toLowerCase() === 'false') {
    // 如果以字面量开头但后面有下标后缀 [[1]][0][0] 或 'hello'[0] 或 {name:'a'}[123]
    if ((t.startsWith('[') || t.startsWith("'") || t.startsWith('"') || t.startsWith('{')) && t.endsWith(']')) {
      // 从最外层找到第一个匹配的 close（支持 [] 和 {}），右侧剩余都是后缀下标
      let closePos = -1, depth = 0
      for (let i = 0; i < t.length; i++) {
        if (t[i] === "'" || t[i] === '"') {
          const q = t[i]; i++
          while (i < t.length && t[i] !== q) { if (t[i] === '\\') i++; i++ }
          continue
        }
        if (t[i] === '(' || t[i] === '[' || t[i] === '{') depth++
        if (t[i] === ')' || t[i] === ']' || t[i] === '}') { depth--; if (depth === 0) { closePos = i; break } }
      }
      if (closePos === t.length - 1) return _evalLiteral(t, row) // 纯字面量，无后缀
      if (closePos > 0) {
        // baseObj = 最外层列表/字符串
        let val = _evalLiteral(t.slice(0, closePos + 1), row)
        // 逐层解析后缀下标
        let pos = closePos + 1
        while (pos < t.length && t[pos] === '[') {
          const endBracket = t.indexOf(']', pos)
          if (endBracket < 0) break
          const inner = t.slice(pos + 1, endBracket)
          // 检测切片语法 [start..end]
          const rangeIdx = inner.indexOf('..')
          if (rangeIdx >= 0) {
            // 切片操作
            const startStr = inner.slice(0, rangeIdx).trim()
            const endStr = inner.slice(rangeIdx + 2).trim()
            const len = Array.isArray(val) ? val.length : (typeof val === 'string' ? val.length : 0)
            // 如果 start 或 end 值为 null，整个切片返回 null
            let startVal = startStr ? _evalBinary(startStr, row) : 0
            let endVal = endStr ? _evalBinary(endStr, row) : len
            if (startVal == null || endVal == null) { val = null; break }
            let sliceStart = Number(startVal)
            let sliceEnd = Number(endVal)
            if (isNaN(sliceStart)) sliceStart = 0
            if (isNaN(sliceEnd)) sliceEnd = len
            // 负索引
            if (sliceStart < 0) sliceStart = Math.max(len + sliceStart, 0)
            if (sliceEnd < 0) sliceEnd = Math.max(len + sliceEnd, 0)
            if (Array.isArray(val)) { val = val.slice(sliceStart, sliceEnd) }
            else if (typeof val === 'string') { val = val.slice(sliceStart, sliceEnd) }
            else { val = null }
          } else {
            const idx = _evalBinary(inner, row)
            if (Array.isArray(val)) {
              if (idx == null) { val = null }
              else if (typeof idx !== 'number' || !Number.isInteger(idx)) throw Object.assign(new Error('TypeError: List index must be an integer'), { tckError: 'TypeError' })
              else val = val[Number(idx)] ?? null
            } else if (val && typeof val === 'object' && !Array.isArray(val)) {
              // map 下标：null → null；非字符串 → TypeError
              if (idx == null) { val = null }
              else if (typeof idx !== 'string') throw Object.assign(new Error('TypeError: Map index must be a string'), { tckError: 'TypeError' })
              else val = (val as Record<string, unknown>)[idx] ?? null
            }
            else { val = null }
          }
          pos = endBracket + 1
        }
        return val
      }
    }
    return _evalLiteral(t, row)
  }
  // 下标 a[b] 或切片 a[start..end] — 优先级高于属性访问，因为 [n] 不涉及点
  const bracketIdx = t.indexOf('[')
  if (bracketIdx > 0 && t.endsWith(']')) {
    const obj = _evalAtom(t.slice(0, bracketIdx), row)
    const inner = t.slice(bracketIdx + 1, -1).trim()
    // 检测切片语法 [start..end]
    const rangeIdx = inner.indexOf('..')
    if (rangeIdx >= 0) {
      const startStr = inner.slice(0, rangeIdx).trim()
      const endStr = inner.slice(rangeIdx + 2).trim()
      const len = Array.isArray(obj) ? obj.length : (typeof obj === 'string' ? obj.length : 0)
      let startVal = startStr ? _evalBinary(startStr, row) : 0
      let endVal = endStr ? _evalBinary(endStr, row) : len
      if (startVal == null || endVal == null) return null
      let sliceStart = Number(startVal)
      let sliceEnd = Number(endVal)
      if (isNaN(sliceStart)) sliceStart = 0
      if (isNaN(sliceEnd)) sliceEnd = len
      if (sliceStart < 0) sliceStart = Math.max(len + sliceStart, 0)
      if (sliceEnd < 0) sliceEnd = Math.max(len + sliceEnd, 0)
      if (Array.isArray(obj)) return obj.slice(sliceStart, sliceEnd)
      if (typeof obj === 'string') return obj.slice(sliceStart, sliceEnd)
      return null
    }
    const idx = _evalBinary(inner, row)
    if (Array.isArray(obj)) {
      if (idx == null) return null
      if (typeof idx !== 'number' || !Number.isInteger(idx)) throw Object.assign(new Error('TypeError: List index must be an integer'), { tckError: 'TypeError' })
      return obj[Number(idx)] ?? null
    }
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      // map 类型下标：null → null；非字符串 → TypeError
      if (idx == null) return null
      if (typeof idx !== 'string') throw Object.assign(new Error('TypeError: Map index must be a string'), { tckError: 'TypeError' })
      return (obj as Record<string, unknown>)[idx] ?? null
    }
    // 非 map/非 list 的基本类型下标抛 TypeError
    if (obj != null) throw Object.assign(new Error('TypeError: Cannot index into non-map/non-list type'), { tckError: 'TypeError' })
    return null
  }
  // 属性访问 a.b
  const dotIdx = t.indexOf('.')
  if (dotIdx > 0 && !t.startsWith('.')) {
    const obj = _evalAtom(t.slice(0, dotIdx), row)
    const propRaw = t.slice(dotIdx + 1)
    // 去掉反引号：m.`name` → m.name
    const prop = propRaw.replace(/^`|`$/g, '')
    // Cypher: null.prop → null; nonMap.prop (非 map) → TypeError
    if (obj == null) return null
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return (obj as Record<string, unknown>)[prop] ?? null
    // 对非 map 的基本类型抛 TypeError（列表也是非 map）
    throw Object.assign(new Error('TypeError: Property access on non-map type'), { tckError: 'TypeError' })
  }
  // 变量引用
  if (t in (row || {})) return row![t]
  if (row?._alias === t) return row
  return _evalLiteral(t, row)
}

export function _evalLiteral(s: string, row?: Record<string, unknown>): unknown {
  const v = s.trim()
  if (v === 'null') return null
  if (v.toLowerCase() === 'true') return true
  if (v.toLowerCase() === 'false') return false
  // 数字字面量：整数、浮点、十六进制、科学计数法、小数点开头
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)) {
    // 纯整数且超出 Number 安全范围 → 返回 BigInt 保持精度
    if (!v.includes('.') && !/e/i.test(v)) {
      try {
        const big = BigInt(v)
        if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)) {
          return big
        }
      } catch { /* fall through to Number */ }
    }
    return parseFloat(v)
  }
  if (/^0[xX][0-9a-fA-F]+$/.test(v)) {
    const n = parseInt(v, 16)
    // 超出 Number 安全范围时用 BigInt 保持精度
    if (n > Number.MAX_SAFE_INTEGER) {
      try { return BigInt(v) } catch { return n }
    }
    return n
  }
  if (/^0[oO][0-7]+$/.test(v)) {
    const n = parseInt(v.slice(2), 8)
    if (n > Number.MAX_SAFE_INTEGER) {
      try { return BigInt(v) } catch { return n }
    }
    return n
  }
  if (/^-?\.\d+([eE][+-]?\d+)?$/.test(v)) return parseFloat(v)
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    let val = v.slice(1, -1)
    // 转义序列：\n \t \r \\ \' \" \uXXXX
    val = val.replace(/\\(n|t|r|\\|'|")/g, (_m: string, ch: string) => {
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' }
      return map[ch]
    })
    val = val.replace(/\\u([0-9a-fA-F]{4})/g, (_m: string, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    return val
  }
  if (v.startsWith('[') && v.endsWith(']')) {
    // 检测列表推导： [var IN list WHERE cond | expr] 或 [var IN list WHERE cond] 或 [var IN list | expr]
    const LC_RE = /^\s*(\w+)\s+IN\s+(.+?)(?:\s+WHERE\s+(.+?))?(?:\s*\|\s*(.+?))?\s*$/s
    const inner = v.slice(1, -1).trim()
    if (!inner) return []
    const lcMatch = inner.match(LC_RE)
    if (lcMatch) {
      const varName = lcMatch[1]
      const listExpr = lcMatch[2].trim()
      const condExpr = lcMatch[3]?.trim()
      const retExpr = lcMatch[4]?.trim()
      const list = _evaluateExpression(listExpr, row)
      if (!Array.isArray(list)) return null
      const result: unknown[] = []
      for (const item of list) {
        const evalCtx: Record<string, unknown> = { ...row as any, [varName]: item }
        if (condExpr) {
          const condVal = _evaluateExpression(condExpr, evalCtx)
          if (condVal !== true) continue
        }
        if (retExpr) {
          result.push(_evaluateExpression(retExpr, evalCtx))
        } else {
          result.push(item)
        }
      }
      return result
    }
    // 普通列表字面量
    return inner ? _parseCommaList(inner).map(item => _evalBinary(item.trim(), row)) : []
  }
  if (v.startsWith('{') && v.endsWith('}')) {
    const inner = v.slice(1, -1).trim()
    if (!inner) return {}
    const result: Record<string, unknown> = {}
    for (const pair of _parseCommaList(inner)) {
      const colonIdx = pair.indexOf(':')
      if (colonIdx === -1) continue
      result[pair.slice(0, colonIdx).trim().replace(/['"]/g, '')] = _evalBinary(pair.slice(colonIdx + 1).trim(), row)
    }
    return result
  }
  return null
}

export function _inBrackets(s: string, idx: number): boolean {
  let depth = 0
  for (let i = 0; i < idx; i++) { if (s[i] === '(' || s[i] === '[' || s[i] === '{') depth++; if (s[i] === ')' || s[i] === ']' || s[i] === '}') depth-- }
  return depth > 0
}

/** 检查字符串中 idx 位置是否在字符串字面量内（引号内） */
export function _inString(s: string, idx: number): boolean {
  let inStr = false, strChar = ''
  for (let i = 0; i < idx; i++) {
    if (!inStr && (s[i] === "'" || s[i] === '"')) { inStr = true; strChar = s[i] }
    else if (inStr && s[i] === strChar) { inStr = false }
  }
  return inStr
}

export function _isBalanced(s: string): boolean {
  let depth = 0
  for (const ch of s) { if (ch === '(') depth++; if (ch === ')') depth--; if (depth < 0) return false }
  return depth === 0
}

export function _findTopLevelOp(s: string, op: string): number {
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(' || s[i] === '[' || s[i] === '{') depth++
    if (s[i] === ')' || s[i] === ']' || s[i] === '}') depth--
    if (depth === 0 && s.slice(i, i + op.length) === op) {
      // 确保不是子字符串匹配（如 <> 内部的 =）
      // 检查前后字符不是 > 或 <，确保操作符是孤立的
      const before = i > 0 ? s[i - 1] : ' '
      const after = s[i + op.length]
      // 对于双字符操作符（<>, >=, <=），确保前一个和后一个字符都不是 < > =（避免从 <= 内部找到 < 或 =）
      if (op.length === 1 && (before === '<' || before === '>' || before === '=' || after === '<' || after === '>' || after === '=')) continue
      return i
    }
  }
  return -1
}

export function _splitTopLevel(s: string, find: string): string[] {
  const result: string[] = []
  let depth = 0, inStr = false, strChar = '', current = '', i = 0
  while (i < s.length) {
    if (inStr) { current += s[i]; if (s[i] === strChar) inStr = false; i++; continue }
    if (s[i] === "'" || s[i] === '"') { inStr = true; strChar = s[i]; current += s[i]; i++; continue }
    if (s[i] === '(' || s[i] === '[' || s[i] === '{') { depth++; current += s[i]; i++; continue }
    if (s[i] === ')' || s[i] === ']' || s[i] === '}') { depth--; current += s[i]; i++; continue }
    if (depth === 0 && s.slice(i, i + find.length) === find) {
      // 单词边界检查：避免 "XOR" 中的 "OR" 被误匹配
      const prev = i === 0 ? ' ' : s[i - 1]
      const next = s[i + find.length]
      const isWord = (c: string) => /[a-zA-Z0-9_]/.test(c)
      if (!isWord(prev) && (!isWord(next) || next === undefined)) {
        result.push(current.trim()); current = ''; i += find.length; continue
      }
    }
    current += s[i]; i++
  }
  const last = current.trim()
  if (last) result.push(last)
  return result.length ? result : [s.trim()]
}

/**
 * 字面量编译时语法和语义验证（SyntaxError）
 * Literals: 整数溢出、非法格式、十六进制/八进制/浮点溢出、Unicode、列表/map 语法
 */
export function _validateLiterals(query: string): void {
  // 提取 RETURN 后的裸表达式（去掉 AS alias）
  const retMatch = query.match(/RETURN\b([\s\S]*)/i)
  if (!retMatch) return
  const afterReturn = retMatch[1].trim()
  const exprs = _splitTopLevel(afterReturn, ',').map(s => s.trim()).filter(Boolean)
  const literals = exprs.map(s => s.replace(/\s+AS\s+\w+$/i, '').trim())

  for (const rawExpr of literals) {
    // 只对纯字面量（不含顶层操作符的 表达式）做语法验证。
    // 复杂表达式（如 [1,2] = [1] 或 0.0/0.0 > 1）不应被误识别为非法字面量。
    if (!_isPureLiteralExpr(rawExpr)) continue

    // 一元运算符前缀（+/-）不是字面量的一部分 — 但在验证字面量类型时需要考虑符号
    const hasSign = rawExpr.startsWith('-') || rawExpr.startsWith('+')
    const expr = hasSign ? rawExpr.slice(1) : rawExpr
    // ── 列表语法检查 ── 包含缺失逗号检测
    if (expr.startsWith('[') && expr.endsWith(']')) {
      if (_detectMissingCommas(expr)) {
        throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
      }
    }

    // ── Map 语法检查 ──
    if (expr.startsWith('{') && expr.endsWith('}')) {
      // 不均衡大括号 + 未闭合字符串
      let depth = 0, inStr = false, strChar = ''
      for (let i = 0; i < expr.length; i++) {
        if (inStr && expr[i] === '\\') { i++; continue }
        if (inStr) { if (expr[i] === strChar) inStr = false; continue }
        if (expr[i] === "'" || expr[i] === '"') { inStr = true; strChar = expr[i]; continue }
        if (expr[i] === '{') depth++
        if (expr[i] === '}') { depth--; if (depth < 0) break }
      }
      if (depth !== 0 || inStr) {
        throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
      }
      const inner = expr.slice(1, -1).trim()
      // {,} 只有逗号
      if (/^,\s*$/.test(inner)) {
        throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
      }
      // {1} 没有 key（值不是 k:v 格式）
      if (inner && !inner.includes(':')) {
        throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
      }
      // 解析 map 条目
      const entries = _splitTopLevel(inner, ',').map(s => s.trim()).filter(Boolean)
      for (const entry of entries) {
        const colonIdx = entry.indexOf(':')
        if (colonIdx <= 0) {
          // {[]} 或 {{}} — 值在前没有 key
          if (entry.startsWith('[') || entry.startsWith('{')) {
            throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
          }
          continue
        }
        const key = entry.slice(0, colonIdx).trim()
        // key 以数字开头
        if (/^[0-9]/.test(key)) {
          throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
        }
        // key 含点号
        if (key.includes('.')) {
          throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
        }
        // key 含非法符号 — 只允许字母数字下划线
        if (!/^[a-zA-Z_]\w*$/.test(key.replace(/['"]/g, ''))) {
          throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
        }
      }
    }

    // ── 纯整数 ──
    const intMatch = expr.match(/^(\d+)$/)
    if (intMatch) {
      const digits = intMatch[1]
      try {
        const absVal = BigInt(digits)
        const big = hasSign ? -absVal : absVal
        const min = BigInt('-9223372036854775808')
        const max = BigInt('9223372036854775807')
        if (big < min || big > max) {
          throw Object.assign(new Error('SyntaxError: IntegerOverflow'), { tckError: 'IntegerOverflow' })
        }
      } catch (e: any) {
        if (e && e.tckError) throw e
        throw Object.assign(new Error('SyntaxError: InvalidNumberLiteral'), { tckError: 'InvalidNumberLiteral' })
      }
      continue
    }
    // 整数含非法符号（如 9223372#54775808）— 以数字开头但非纯数字
    if (!intMatch && /^\d/.test(rawExpr.replace(/^[+-]/, '')) && !/^0[xXoObB]/.test(expr)) {
      // 检查是否合法数字格式
      if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(rawExpr) && !/^-?\.\d+([eE][+-]?\d+)?$/.test(rawExpr)) {
        throw Object.assign(new Error('SyntaxError: InvalidNumberLiteral'), { tckError: 'InvalidNumberLiteral' })
      }
    }

    // ── 十六进制字面量 ──
    const hexMatch = expr.match(/^0[xX](\w*)$/)
    if (hexMatch) {
      const hexDigits = hexMatch[1]
      if (!hexDigits) {
        throw Object.assign(new Error('SyntaxError: InvalidNumberLiteral'), { tckError: 'InvalidNumberLiteral' })
      }
      if (!/^[0-9a-fA-F]+$/.test(hexDigits)) {
        throw Object.assign(new Error('SyntaxError: InvalidNumberLiteral'), { tckError: 'InvalidNumberLiteral' })
      }
      // 溢出：BigInt 不支持 -0x... 格式，所以用纯 hex 拼数字
      try {
        const absVal = BigInt('0x' + hexDigits)
        const big = hasSign ? -absVal : absVal
        const min = BigInt('-9223372036854775808')
        const max = BigInt('9223372036854775807')
        if (big < min || big > max) {
          throw Object.assign(new Error('SyntaxError: IntegerOverflow'), { tckError: 'IntegerOverflow' })
        }
      } catch (e: any) {
        if (e && e.tckError) throw e
        throw Object.assign(new Error('SyntaxError: IntegerOverflow'), { tckError: 'IntegerOverflow' })
      }
      continue
    }

    // ── 八进制字面量 ──
    const octMatch = expr.match(/^0[oO](\w*)$/)
    if (octMatch) {
      const octDigits = octMatch[1]
      if (!octDigits || !/^[0-7]+$/.test(octDigits)) {
        throw Object.assign(new Error('SyntaxError: InvalidNumberLiteral'), { tckError: 'InvalidNumberLiteral' })
      }
      // 溢出：BigInt 不支持 -0o... 格式，先算绝对值再加负号
      try {
        const absVal = BigInt('0o' + octDigits)
        const big = hasSign ? -absVal : absVal
        const min = BigInt('-9223372036854775808')
        const max = BigInt('9223372036854775807')
        if (big < min || big > max) {
          throw Object.assign(new Error('SyntaxError: IntegerOverflow'), { tckError: 'IntegerOverflow' })
        }
      } catch (_e) {
        throw Object.assign(new Error('SyntaxError: IntegerOverflow'), { tckError: 'IntegerOverflow' })
      }
      continue
    }

    // ── 浮点溢出 ──
    if (/^-?\d+(\.\d+)?[eE][+-]?\d+$/.test(expr) || /^-?\.\d+[eE][+-]?\d+$/.test(expr)) {
      const val = parseFloat(expr)
      if (!isFinite(val)) {
        throw Object.assign(new Error('SyntaxError: FloatingPointOverflow'), { tckError: 'FloatingPointOverflow' })
      }
    }

    // ── Unicode 字面量 ──
    const strMatch = expr.match(/^'([^']*)'$/)
    if (strMatch) {
      const strContent = strMatch[1]
      // 查找 \u 后不是 4 hex digits 的情况
      // 场景：'\uH' — \u 后跟 H（不是 hex）
      // 但需要排除 \u 被转义的情况（\\u）
      for (let i = 0; i < strContent.length - 1; i++) {
        if (strContent[i] === '\\' && strContent[i + 1] === 'u') {
          // 检查是否被转义 (\\u)
          if (i > 0 && strContent[i - 1] === '\\') continue
          const hexPart = strContent.slice(i + 2, i + 6)
          if (hexPart.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hexPart)) {
            throw Object.assign(new Error('SyntaxError: InvalidUnicodeLiteral'), { tckError: 'InvalidUnicodeLiteral' })
          }
        }
      }
    }
  }
}

/**
 * 递归检测列表/Map 字面量中是否缺失逗号分隔符（Cypher 语法错误）
 */
export function _detectMissingCommas(expr: string): boolean {
  if (!expr.startsWith('[') && !expr.startsWith('{')) return false
  const opening = expr[0]
  const closing = opening === '[' ? ']' : '}'
  // 找到第一个 depth=0 的 close char（支持 list[0] 语法下标）
  let matchIdx = -1, depth = 0, inStr = false, strChar = ''
  for (let i = 0; i < expr.length; i++) {
    if (inStr) { if (expr[i] === '\\') i++; else if (expr[i] === strChar) inStr = false; continue }
    if (expr[i] === "'" || expr[i] === '"') { inStr = true; strChar = expr[i]; continue }
    if (expr[i] === opening) { depth++; continue }
    if (expr[i] === closing) { depth--; if (depth === 0) { matchIdx = i; break } }
  }
  if (matchIdx < 0) return true
  const inner = expr.slice(1, matchIdx).trim()
  if (!inner) return false

  depth = 0; let i = 0, prevEnded = false, hadExpr = false

  while (i < inner.length) {
    const ch = inner[i]
    if (depth === 0 && /\s/.test(ch)) { i++; continue }

    if (ch === "'" || ch === '"') {
      if (depth === 0) { if (prevEnded) return true; prevEnded = true; hadExpr = true }
      let j = i + 1; while (j < inner.length && inner[j] !== ch) { if (inner[j] === '\\') j++; j++ }
      i = j + 1; continue
    }

    if (ch === '[' || ch === '{') {
      if (depth === 0) {
        // 如果前一个元素已经结束（prevEnded），检查是否下标操作（][）
        // 下标语法 [list[idx]] 中 inner 可能为 "list[idx]" 或已经部分切片
        if (prevEnded) {
          // 如果前一个字符是 ]，这是下标操作 [list[idx]]，不是逗号缺失
          const prevChar = i > 0 ? inner[i - 1] : ''
          if (prevChar === ']') { /* 下标访问，正常 */ }
          else return true
        }
        prevEnded = false; hadExpr = true
      }
      const closeChar = ch === '[' ? ']' : '}'
      let subDepth = 1, j = i + 1
      while (j < inner.length && subDepth > 0) {
        if (inner[j] === "'" || inner[j] === '"') {
          const q = inner[j]; j++
          while (j < inner.length && inner[j] !== q) { if (inner[j] === '\\') j++; j++ }
          j++; continue
        }
        if (inner[j] === ch) subDepth++
        if (inner[j] === closeChar) subDepth--
        j++
      }
      const subExpr = inner.slice(i, j)
      if ((subExpr.startsWith('[') || subExpr.startsWith('{')) && _detectMissingCommas(subExpr)) return true
      i = j
      if (depth === 0) prevEnded = true
      continue
    }

    if ((ch === ']' || ch === '}') && depth === 0) { i++; continue }
    if (ch === ']' || ch === '}') { depth--; if (depth === 0) prevEnded = true; i++; continue }
    if (ch === ':' && depth === 0) { prevEnded = false; i++; continue }
    if (ch === ',' && depth === 0) { if (!hadExpr) return true; prevEnded = false; i++; continue }

    if (depth === 0) {
      if (prevEnded) return true
      hadExpr = true
      while (i + 1 < inner.length && /[a-zA-Z0-9_.\-]/.test(inner[i + 1])) i++
      prevEnded = true
    }
    i++
  }

  if (prevEnded === false && hadExpr && inner.trimEnd().endsWith(',')) return true
  return false
}

/**
 * 检查表达式是否为纯字面量（不含顶层操作符）。
 * 用于 _validateLiterals，避免将复杂表达式（如 [1,2] = [1] 或 0.0/0.0 > 1）
 * 错误地送入字面量语法检查。
 */
export function _isPureLiteralExpr(s: string): boolean {
  let depth = 0, inStr = false, strChar = ''
  for (let i = 0; i < s.length; i++) {
    if (inStr) { if (s[i] === '\\') { i++; continue }; if (s[i] === strChar) inStr = false; continue }
    if (s[i] === "'" || s[i] === '"') { inStr = true; strChar = s[i]; continue }
    if (s[i] === '(' || s[i] === '[' || s[i] === '{') { depth++; continue }
    if (s[i] === ')' || s[i] === ']' || s[i] === '}') { depth--; continue }
    if (depth === 0) {
      // 比较操作符
      if (s[i] === '=') return false
      if (s.slice(i, i + 2) === '<>' || s.slice(i, i + 2) === '>=' || s.slice(i, i + 2) === '<=') return false
      if (s[i] === '>' || s[i] === '<') return false
      // 算术操作符（不在括号/字符串内）
      // 但如果 i==0 且 s[i] 为 +/-，可能是字面量前缀（如 -42, +0o100...）
      if (i === 0 && (s[i] === '+' || s[i] === '-')) continue
      if (s[i] === '+' || s[i] === '-' || s[i] === '*' || s[i] === '/' || s[i] === '%' || s[i] === '^') return false
      // 布尔操作符（IN, AND, OR, XOR, NOT 等）
      if (/\s/.test(s[i]) && i + 2 < s.length) {
        const sub = s.slice(i, i + 5)
        if (/^\s+(?:IN|AND|OR|XOR|NOT)\s/.test(sub)) return false
        if (/^\s+STARTS\s+WITH/.test(sub) || /^\s+ENDS\s+WITH/.test(sub) || /^\s+CONTAINS/.test(sub)) return false
      }
    }
  }
  return true
}

// ═══════════════════════════════════════════════════════════════
// 聚合函数辅助（Aggregation helpers for aggregate.spec.ts）
// ═══════════════════════════════════════════════════════════════


/** 解析单个聚合表达式字符串，如 'count(*)', 'AVG(n.score)', 'SUM(DISTINCT age)' */
export function _parseAggregate(expr: string): { fn: string; field: string; prop: string; distinct: boolean; alias: string | null } | null {
  const trimmed = expr.trim()
  // 需要至少一个字符作为 field（count 和 collect 允许 *）
  const match = trimmed.match(/^(\w+)\s*\(\s*(DISTINCT\s+)?(.+?)?\s*\)\s*(?:AS\s+(\w+))?\s*$/i)
  if (!match) return null
  const fn = match[1].toUpperCase()
  const distinct = !!match[2]
  const rawField = (match[3] || '').trim()
  // count() 无参数（空括号）无效
  if (!rawField) return null
  const field = rawField
  const prop = field === '*' ? '*' : field.includes('.') ? field.split('.').pop()! : field
  return { fn, field, prop, distinct, alias: match[4] || null }
}

/** 提取列列表中的聚合列和 GROUP BY 列 */
export function _extractAggColumns(columns: string[]): { aggCols: AggColumnInfo[]; groupByCols: string[] } {
  const aggCols: AggColumnInfo[] = []
  const groupByCols: string[] = []
  for (const col of columns) {
    const parsed = _parseAggregate(col)
    if (parsed) {
      aggCols.push(parsed)
    } else {
      // Non-aggregate column → GROUP BY 列
      // 移除 AS 别名
      const bareCol = col.replace(/\s+AS\s+\w+\s*$/i, '').trim()
      groupByCols.push(bareCol.includes('.') ? bareCol.split('.').pop()! : bareCol)
    }
  }
  return { aggCols, groupByCols }
}

/** 检查列列表中是否包含聚合函数 */
export function _hasAggregates(columns: string[]): boolean {
  return columns.some(col => _parseAggregate(col) !== null)
}

/**
 * 执行聚合逻辑：根据 aggCols 和 groupByCols 对 rows 进行分组并计算聚合值。
 *
 * AVG 精度处理：使用 sum / count 的 JS 浮点除法，对小数结果做 toFixed(15) 舍入，
 * 消除 0.1 + 0.2 = 0.30000000000000004 类的浮点误差。
 */
export function _executeAggregation(rows: QueryRow[], aggCols: AggColumnInfo[], groupByCols: string[]): QueryRow[] {
  if (!rows.length && aggCols.length) {
    // 空数据集
    const out: QueryRow = {}
    for (const ac of aggCols) {
      const key = ac.alias || ac.fn.toLowerCase()
      if (ac.fn === 'COUNT') {
        out[key] = 0
      } else if (ac.fn === 'AVG') {
        out[key] = null
      } else {
        out[key] = ac.fn === 'MIN' ? 0 : 0
      }
    }
    return [out]
  }

  /** 从行中提取聚合字段的值：count(*) 和 collect(*) 忽略字段名（所有行计 1） */
  function _extractValues(rows: QueryRow[], prop: string, distinct?: boolean): unknown[] {
    if (prop === '*') {
      // count(*) / collect(*) → 所有行都是有效值
      return rows.map(_ => true) // placeholder; _computeAggregate 对 COUNT 只检查 length
    }
    const vals = rows
      .map(r => r[prop])
      .filter(v => v !== undefined && v !== null)
    if (distinct) {
      return [...new Set(vals)]
    }
    return vals
  }

  // No group-by → single aggregate row
  if (!groupByCols.length) {
    const out: QueryRow = {}
    for (const ac of aggCols) {
      const key = ac.alias || ac.fn.toLowerCase()
      const values = _extractValues(rows, ac.prop, ac.distinct)
      out[key] = _computeAggregate(ac.fn, values)
    }
    return [out]
  }

  // Has group-by → group rows by groupByCols values
  const groups = new Map<string, QueryRow[]>()
  for (const row of rows) {
    const gk = groupByCols.map(gc => String(row[gc] ?? '__NULL__')).join('||')
    if (!groups.has(gk)) groups.set(gk, [])
    groups.get(gk)!.push(row)
  }

  const result: QueryRow[] = []
  for (const [gk, groupRows] of groups) {
    const out: QueryRow = {}
    // Set group-by columns
    const gkParts = gk.split('||')
    for (let i = 0; i < groupByCols.length; i++) {
      out[groupByCols[i]] = gkParts[i] === '__NULL__' ? null : groupRows[0][groupByCols[i]]
    }
    // Compute aggregates
    for (const ac of aggCols) {
      const key = ac.alias || ac.fn.toLowerCase()
      const values = _extractValues(groupRows, ac.prop, ac.distinct)
      out[key] = _computeAggregate(ac.fn, values)
    }
    result.push(out)
  }
  return result
}

/** 计算单个聚合值，包含 AVG 精度修复 */
export function _computeAggregate(fn: string, values: unknown[]): number | null {
  if (!values.length) return fn === 'AVG' ? null : 0

  if (fn === 'COUNT') return values.length
  if (fn === 'COLLECT') return values

  const nums = values.map(v => typeof v === 'number' ? v : Number(v)).filter(v => !isNaN(v))
  if (!nums.length) return fn === 'AVG' ? null : 0

  switch (fn) {
    case 'SUM':
      return nums.reduce((a, b) => a + b, 0)
    case 'AVG': {
      const sum = nums.reduce((a, b) => a + b, 0)
      const avg = sum / nums.length
      // 精度修复：对浮点结果做 toFixed(15)，消除 ±1e-15 级别的误差
      return _cleanFloat(avg)
    }
    case 'MAX':
      return Math.max(...nums)
    case 'MIN':
      return Math.min(...nums)
    default:
      return 0
  }
}

/**
 * 清理浮点精度误差：对 ±1e-14 级误差做舍入
 * 例如 2.1999999999999997 → 2.2, 0.30000000000000004 → 0.3
 */
export function _cleanFloat(n: number): number {
  if (Number.isInteger(n)) return n
  const s = n.toFixed(15)
  // 去掉末尾多余的 0
  return parseFloat(s)
}

/** 标记列是否包含聚合函数 */
export function _enrichWithAggregates(cols: Array<{ expression: string; alias?: string | null }>): Array<{ expression: string; alias?: string | null; isAggregate: boolean; aggFn?: string; distinct?: boolean }> {
  return cols.map(col => {
    const parsed = _parseAggregate(col.expression)
    return {
      ...col,
      isAggregate: !!parsed,
      ...(parsed ? { aggFn: parsed.fn, distinct: parsed.distinct } : {}),
    }
  })
}

// ══════════════════════════════════════════════════════════
// _orderByField / _postProcessResults
// ══════════════════════════════════════════════════════════

export function _orderByField(o: any): string {
  let field = o.field || o.property || o.column || o.expression || o.col
  if (!field) {
    for (const k of Object.keys(o)) {
      if (k !== 'direction' && k !== 'type' && typeof o[k] === 'string') { field = o[k]; break }
    }
  }
  if (field) field = field.replace(/^\w+\./, '')
  return field || 'n'
}

export function _postProcessResults(result: QueryRow[], plan: PostProcessPlan): QueryRow[] {
  if (!result?.length) return result
  const p = plan

  // Quick path: no ORDER BY, no HAVING → skip slice + sort + filter overhead
  if (!p.orderBy?.length && !p.having?.length) {
    if (p.skip !== undefined && p.skip > 0) return result.slice(p.skip)
    if (p.limit !== undefined && p.limit >= 0) return result.slice(0, p.limit)
    return result
  }

  let processed = result.slice()

  // ── ORDER BY ──
  if (p.orderBy?.length) {
    processed.sort((a, b) => {
      for (const o of p.orderBy) {
        const field = _orderByField(o)
        const dir = (o.direction || '').trim().toUpperCase()
        const va = a[field] ?? null, vb = b[field] ?? null
        let cmp = 0
        if (va === null && vb === null) cmp = 0
        // openCypher 规范：ASC 排序中 null 排在最后（大于所有非 null 值）
        // 原实现 null 排在最前，违反规范。参考代码审查 CVE-H6。
        else if (va === null) cmp = 1  // null > non-null → last in ASC
        else if (vb === null) cmp = -1 // non-null < null → last in ASC
        else if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb
        else cmp = String(va).localeCompare(String(vb))
        if (cmp !== 0) return dir === 'DESC' ? -cmp : cmp
      }
      return 0
    })
  }

  // ── HAVING ──
  if (p.having?.length && processed.length > 0) {
    for (const h of p.having) {
      let aggKey: string | null = null
      const sampleKeys = Object.keys(processed[0])
      const aggStripped = h.aggregate.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
      for (const key of sampleKeys) {
        if (key.toLowerCase() === h.aggregate.toLowerCase() ||
            key.toLowerCase() === aggStripped ||
            key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() === aggStripped) { aggKey = key; break }
      }
      if (!aggKey) {
        for (const key of sampleKeys) { if (typeof processed[0][key] === 'number') { aggKey = key; break } }
      }

      const op = h.operator, val = h.value
      processed = processed.filter(row => {
        const rowVal = aggKey ? row[aggKey] : undefined
        if (rowVal === undefined) return true
        switch (op) {
          case 'GT': return rowVal > val
          case 'GTE': return rowVal >= val
          case 'LT': return rowVal < val
          case 'LTE': return rowVal <= val
          case 'EQ': return rowVal === val
          case 'NEQ': return rowVal !== val
          default: return true
        }
      })
    }
  }

  // ── SKIP ──
  if (p.skip !== undefined && p.skip > 0) {
    processed = processed.slice(p.skip)
  }
  // ── LIMIT ──
  if (p.limit !== undefined && p.limit >= 0) {
    processed = processed.slice(0, p.limit)
  }

  return processed
}

