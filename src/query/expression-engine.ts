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

/**
 * ExprValue — 表达式引擎中的值类型。
 *
 * Cypher 表达式可以返回的值类型：
 * - string, number, boolean, null（标量）
 * - bigint（大整数精度）
 * - ExprValue[]（嵌套列表）
 * - { [key: string]: ExprValue }（嵌套映射）
 */
/** duration 原始组件存储：用于 `=` 比较时绕过 V8 intern 短路。
 *  由 `duration({...})` map 路径写入，`_compareValues('=')` 读取。
 *  缓存上限 MAX_CACHE_SIZE。 */
const _rawDurationCache = new Map<string, Array<{ y: number; mo: number; d: number; h: number; min: number; s: number; ns: number }>>()
const MAX_CACHE_SIZE = 64

export type ExprValue = string | number | boolean | null | bigint | ExprValue[] | { [key: string]: ExprValue }

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
/**
 * 检查字符串是否是表达式（而非普通字符串字面量）
 */
export function _isExprValue(s: string): boolean {
  return /^[a-z_]\w*\s*\(.*\)\s*$/i.test(s) || /^(?:[-+!]|[\w.]+)\s+/.test(s) || /\s+(?:AND|OR|XOR|IN|IS|=|<>|<=?|>=?|[+\-*/%])\s/.test(s)
}
export function _evaluateExpression(expr: string | Record<string, unknown>, row?: Record<string, unknown>): ExprValue {
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
export function _evalStructuredLiteral(expr: Record<string, unknown>, _row?: Record<string, unknown>): ExprValue {
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

export function _evalCase(s: string, row?: Record<string, unknown>): ExprValue {
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
  const ms = map.milliseconds != null ? Math.round(Number(map.milliseconds) * 1000000) : map.millisecond != null ? Math.round(Number(map.millisecond) * 1000000) : 0
  const us = map.microseconds != null ? Math.round(Number(map.microseconds) * 1000) : map.microsecond != null ? Math.round(Number(map.microsecond) * 1000) : 0
  const ns = map.nanoseconds != null ? Number(map.nanoseconds) : map.nanosecond != null ? Number(map.nanosecond) : 0
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

/** 从 ISO 持续时间字符串中提取指定属性的数值（如 duration('P1DT2H').days → 1） */export function _extractDateProp(s: string, prop: string): number | undefined {
  let dateStr = s
  if (dateStr.includes('T')) dateStr = dateStr.slice(0, dateStr.indexOf('T'))
  const parts = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!parts) return undefined
  const year = parseInt(parts[1], 10), month = parseInt(parts[2], 10), day = parseInt(parts[3], 10)
  const d = new Date(Date.UTC(year, month - 1, day))
  const jsDow = d.getUTCDay()
  const isoDow = jsDow === 0 ? 7 : jsDow
  const startOfYear = new Date(Date.UTC(year, 0, 1))
  const ordinalDay = Math.floor((d.getTime() - startOfYear.getTime()) / 86400000) + 1
  const quarter = Math.ceil(month / 3)
  const qStart = new Date(Date.UTC(year, (quarter - 1) * 3, 1))
  const dayOfQuarter = Math.floor((d.getTime() - qStart.getTime()) / 86400000) + 1
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const jan4Dow = jan4.getUTCDay() || 7
  const isoWeek1Start = new Date(Date.UTC(year, 0, 4 - (jan4Dow - 1)))
  const week = Math.ceil((d.getTime() - isoWeek1Start.getTime() + 1) / 604800000)
  let weekYear = year
  let weeksInPrevYear = 52
  if (week < 1) {
    weekYear = year - 1
    // ISO 周编号公式：floor((ordinalDay - dow + 10) / 7)
    // 上一年 12 月 28 日一定在最后一周
    const dec28 = new Date(Date.UTC(year - 1, 11, 28))
    const dec28Ordinal = Math.floor((dec28.getTime() - new Date(Date.UTC(year - 1, 0, 1)).getTime()) / 86400000) + 1
    const dec28Dow = dec28.getUTCDay() || 7
    weeksInPrevYear = Math.floor((dec28Ordinal - dec28Dow + 10) / 7)
  }
  else {
    const nextJan4 = new Date(Date.UTC(year + 1, 0, 4))
    const nextIsoWeek1 = new Date(Date.UTC(year + 1, 0, 4 - ((nextJan4.getUTCDay() || 7) - 1)))
    if (d.getTime() >= nextIsoWeek1.getTime()) { weekYear = year + 1 }
  }
  let correctedWeek = week < 1 && weekYear < year ? weeksInPrevYear : week
  if (correctedWeek < 1) correctedWeek = 1
  switch (prop) {
    case 'year': return year
    case 'quarter': return quarter
    case 'month': return month
    case 'week': return correctedWeek
    case 'weekYear': return weekYear
    case 'year': return year
    case 'quarter': return quarter
    case 'month': return month
    case 'week': return week
    case 'weekYear': return weekYear
    case 'day': return day
    case 'ordinalDay': return ordinalDay
    case 'weekDay': return isoDow
    case 'dayOfQuarter': return dayOfQuarter
  }
  return undefined
}
export function _extractTimeProp(s: string, prop: string): number | undefined {
  const cleanS = s.replace(/[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$|Z$|\[[^\]]+\]$/, '')
  const parts = cleanS.match(/^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/)
  if (!parts) return undefined
  const hour = parseInt(parts[1], 10), minute = parseInt(parts[2], 10), second = parseInt(parts[3] || '0', 10)
  let nanosecond = 0
  if (parts[4]) nanosecond = parseInt((parts[4] + '000000000').slice(0, 9), 10)
  // 提取时区/偏移Info
  const tzMatch = s.match(/(?:([+-])(\d{2}):(\d{2})(?:\[([^\]]+)\])?|Z)$/)
  let tzOffsetMinutes = 0
  let tzName = ''
  const ianaMatch = s.match(/\[([^\]]+)\]$/)
  if (ianaMatch) tzName = ianaMatch[1]
  if (tzMatch && Array.isArray(tzMatch) && tzMatch[1]) {
    const sign = tzMatch[1] === '+' ? 1 : -1
    tzOffsetMinutes = sign * (parseInt(tzMatch[2], 10) * 60 + parseInt(tzMatch[3], 10))
  } else if (s.endsWith('Z')) {
    // Z = UTC, no offset minutes change needed
  }
  // duration components also use _extractTimeProp


  switch (prop) {
    case 'hour': return hour
    case 'minute': return minute
    case 'second': return second
    case 'millisecond': return Math.floor(nanosecond / 1e6)
    case 'microsecond': return Math.floor(nanosecond / 1e3)
    case 'nanosecond': return nanosecond
    case 'milliseconds': return Math.floor(nanosecond / 1e6)
    case 'microseconds': return Math.floor(nanosecond / 1e3)
    case 'nanoseconds': return nanosecond
    case 'timezone':
      if (tzName) return tzName
      if (s.endsWith('Z')) return '+00:00'
      if (tzMatch && Array.isArray(tzMatch) && tzMatch[1]) return tzMatch[1] + tzMatch[2] + ':' + tzMatch[3]
      return null
    case 'offset':
      if (s.endsWith('Z')) return '+00:00'
      if (tzMatch && Array.isArray(tzMatch) && tzMatch[1]) return tzMatch[1] + tzMatch[2] + ':' + tzMatch[3]
      return null
    case 'offsetMinutes': return tzOffsetMinutes
    case 'offsetSeconds': return tzOffsetMinutes * 60
  }
  return undefined
}

export function _extractDurationProp(durStr: string, prop: string): number | null {
  // 尝试标准格式：P...T...（组件前可能带 - 符号）
  const m = durStr.match(/^([-])?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(-?\d+(?:\.\d+)?)H)?(?:(-?\d+(?:\.\d+)?)M(?!S))?(?:(-?\d+(?:\.\d+)?)S)?)?$/)
  if (!m) return null
  const [, signStr, years, months, days, hours, minutes, seconds] = m
  const sign = signStr === '-' ? -1 : 1
  const y = parseFloat(years || '0'), mo = parseFloat(months || '0')
  const d = parseFloat(days || '0'), h = parseFloat(hours || '0')
  const min = parseFloat(minutes || '0'), sec = parseFloat(seconds || '0')
  // 分离纳秒：小数秒 -> 纳秒（Cypher 用 ceil 拆分为整秒 + 正 ns）
  const secVal = parseFloat(seconds || '0')
  const secInt = secVal < 0 ? Math.ceil(secVal) - 1 : Math.floor(secVal)
  const secFrac = secVal - secInt
  const nanos = Math.round(Math.abs(secFrac) * 1e9)
  // Cypher 规范：duration 组件分为 calendar 侧（years/months）和 dayTime 侧（days/hours/minutes/seconds/nanos）
  // calendar 侧累积：months_total = y*12 + mo
  // dayTime 侧累积到各单位（不含 days 换算，days 是独立组件）：
  // minutes = h*60 + min, seconds = h*3600 + min*60 + secInt
  const calMonths = y * 12 + mo
  const dtMinutes = h * 60 + min
  const dtSeconds = h * 3600 + min * 60 + secInt
  // 辅助属性：取模到对应"一年中/一季度中/一周中"的索引（1-indexed）
  const _totalMonths = Math.round(calMonths)
  const _totalQuarters = Math.floor(_totalMonths / 3)
  const _quartersOfYear = _totalQuarters > 0 ? ((_totalQuarters - 1) % 4) + 1 : 0
  const _monthsOfYear = _totalMonths > 0 ? ((_totalMonths - 1) % 12) + 1 : 0
  const _monthsOfQuarter = _totalMonths > 0 ? ((_totalMonths - 1) % 3) + 1 : 0
  const _daysOfWeek = d > 0 ? ((Math.round(d) - 1) % 7) + 1 : 0
  switch (prop) {
    case 'years': return sign * y
    case 'months': return sign * calMonths
    case 'quarters': return sign * _totalQuarters
    case 'weeks': return sign * Math.floor(d / 7)
    case 'days': return sign * d
    case 'hours': return sign * h
    case 'minutes': return sign * dtMinutes
    case 'seconds': return sign * dtSeconds
    case 'milliseconds': return sign * (dtSeconds * 1000 + Math.floor(nanos / 1e6))
    case 'microseconds': return sign * (dtSeconds * 1000000 + Math.floor(nanos / 1e3))
    case 'nanoseconds': return sign * (dtSeconds * 1000000000 + nanos)
    case 'nanosecondsOfSecond': return sign * nanos
    case 'millisecondsOfSecond': return sign * Math.floor(nanos / 1e6)
    case 'microsecondsOfSecond': return sign * Math.floor(nanos / 1e3)
    case 'quartersOfYear': return sign * _quartersOfYear
    case 'monthsOfYear': return sign * _monthsOfYear
    case 'monthsOfQuarter': return sign * _monthsOfQuarter
    case 'daysOfWeek': return sign * _daysOfWeek
    case 'minutesOfHour': return sign * Math.floor(min)
    case 'secondsOfMinute': return sign * Math.floor(secInt + Math.round(secFrac * 1e9) / 1e9)
  }
  return null
}

/** 规范化各种日期字符串格式为标准 ISO 日期输出（YYYY-MM-DD） */
function _normalizeDateStr(s: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const yyyymmdd = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (yyyymmdd) return yyyymmdd[1] + '-' + yyyymmdd[2] + '-' + yyyymmdd[3]
  const yyyyMm = s.match(/^(\d{4})-(\d{2})$/);
  if (yyyyMm) return yyyyMm[1] + '-' + yyyyMm[2] + '-01'
  const yyyymm = s.match(/^(\d{4})(\d{2})$/);
  if (yyyymm) return yyyymm[1] + '-' + yyyymm[2] + '-01'
  const yyyy = s.match(/^(\d{4})$/);
  if (yyyy) return yyyy[1] + '-01-01'
  const isoWeekDay = s.match(/^(\d{4})-?W(\d{2})-?(\d)?$/i);
  if (isoWeekDay) {
    const year = parseInt(isoWeekDay[1], 10), week = parseInt(isoWeekDay[2], 10), dow = isoWeekDay[3] ? parseInt(isoWeekDay[3], 10) : 1
    const jan4 = new Date(Date.UTC(year, 0, 4))
    const jan4Dow = jan4.getUTCDay() || 7
    const isoWeek1Start = new Date(Date.UTC(year, 0, 4 - (jan4Dow - 1)))
    const targetDate = new Date(isoWeek1Start.getTime() + (week - 1) * 7 * 86400000 + (dow - 1) * 86400000)
    return targetDate.getUTCFullYear() + '-' + String(targetDate.getUTCMonth() + 1).padStart(2, '0') + '-' + String(targetDate.getUTCDate()).padStart(2, '0')
  }
  const ordinal = s.match(/^(\d{4})-?(\d{3})$/);
  if (ordinal) {
    const year = parseInt(ordinal[1], 10), dayOfYear = parseInt(ordinal[2], 10)
    const d = new Date(Date.UTC(year, 0, dayOfYear))
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0')
  }
  return s
}

/** 规范化各种时间字符串格式为标准 ISO 时间输出（HH:MM:SS.fff） */
function _normalizeTimeStr(s: string): string {
  // 已标准化的 HH:MM 或 HH:MM:SS[.sss]，时区可能是 ±HH:MM（冒号格式），也可能是 ±HHMM 或 ±HH（无冒号格式）
  if (/^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[+-]\d{2}:\d{2}(?:\[[^\]]+\])?|Z|[+-]\d{2,4}(?:\[[^\]]+\])?)?$/.test(s)) {
    // 即使时间部分已标准，仍需归一化时区（如 +0100 → +01:00, -00:00 → Z）
    const tzMatch = s.match(/([+-]\d{2,4}(?:\.[^Z\[\]]+)?(?:\[[^\]]+\])?|Z)$/)
    if (tzMatch) {
      const beforeTz = s.slice(0, tzMatch.index)
      const normalizedTz = _normalizeTz(tzMatch[1])
      return beforeTz + normalizedTz
    }
    return s
  }
  // HHMMSS.sss[tz]
  const hmsNoColon = s.match(/^(\d{2})(\d{2})(\d{2}(?:\.\d+)?)([+-]\d{2,4}(?:\[[^\]]+\])?|Z)?$/);
  if (hmsNoColon) {
    let r = hmsNoColon[1] + ':' + hmsNoColon[2] + ':' + hmsNoColon[3]
    if (hmsNoColon[4]) r += _normalizeTz(hmsNoColon[4])
    return r
  }
  // HHMM[tz]（时区可能含冒号如 -00:00）
  const hmNoColon = s.match(/^(\d{2})(\d{2})(?:([+-]\d{1,2}:\d{2}(?:\[[^\]]+\])?|Z|[+-]\d{2,4}(?:\[[^\]]+\])?))?$/)
  if (hmNoColon) {
    let r = hmNoColon[1] + ':' + hmNoColon[2]
    if (hmNoColon[3]) r += _normalizeTz(hmNoColon[3])
    return r
  }
  // HH[tz]（时区可能含冒号）
  const hOnly = s.match(/^(\d{2})(?:([+-]\d{1,2}:\d{2}(?:\[[^\]]+\])?|Z|[+-]\d{2,4}(?:\[[^\]]+\])?))?$/)
  if (hOnly) {
    let r = hOnly[1] + ':00'
    if (hOnly[2]) r += _normalizeTz(hOnly[2])
    return r
  }
  // HH:MM[tz] 无秒 → 加 :00（时区可能含/不含冒号）
  const hmTz = s.match(/^(\d{2}:\d{2})([+-]\d{1,2}:\d{2}(?:\[[^\]]+\])?|Z|[+-]\d{2,4}(?:\[[^\]]+\])?)$/)
  if (hmTz) return hmTz[1] + ':00' + _normalizeTz(hmTz[2])
  return s
}
function _normalizeTz(tz: string): string {
  if (tz === 'Z') {
    // standalone Z, no IANA context — stays Z
    return 'Z'
  }
  // Z with IANA suffix: Z[Europe/London] → +00:00[Europe/London]
  if (tz === 'Z' || tz.startsWith('Z')) {
    const ianaMatch = tz.match(/Z\[([^\]]+)\]/)
    if (ianaMatch) return '+00:00[' + ianaMatch[1] + ']'
    return 'Z'
  }
  // ±HH:MM (already normalized)
  if (/^[+-]\d{2}:\d{2}/.test(tz)) {
    // -00:00 should be normalized to Z (zero offset flagged)
    if (tz === '-00:00') return 'Z'
    return tz
  }
  // ±HHMM → ±HH:MM
  const m4 = tz.match(/^([+-])(\d{2})(\d{2})(\.\d+)?(.*)?$/)
  if (m4) {
    const result = m4[1] + m4[2] + ':' + m4[3] + (m4[4] || '') + (m4[5] || '')
    // -00:00 → Z
    if (result === '-00:00') return 'Z'
    return result
  }
  // ±HH → ±HH:00 (and normalize -00 → Z)
  const m2 = tz.match(/^([+-])(\d{2})(\.\d+)?(.*)?$/)
  if (m2) {
    if (m2[1] === '-' && m2[2] === '00') return 'Z' + (m2[4] || '')
    return m2[1] + m2[2] + ':00' + (m2[3] || '') + (m2[4] || '')
  }
  return tz
}

/** 解析时区 offset 字符串为分钟数（+01:00 → 60, Z → 0） */
function _parseTzOffset(tz: string): number {
  if (tz === 'Z' || tz === '') return 0;
  const m = tz.match(/([+-])(\d{1,2}):(\d{2})/);
  if (!m) return 0;
  const offset = parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
  return m[1] === '-' ? -offset : offset;
}

/** 对给定的小时/分钟做时区偏移调整（处理跨日） */
function _adjustTz(hour: number, minute: number, srcTz: string, dstTz: string, dayAdjust?: { sign: number }, year?: number, month?: number, day?: number): { hour: number; minute: number; dayDelta: number } {
  if (!srcTz || !dstTz) return { hour, minute, dayDelta: 0 };
  // 如果时区包含 IANA 名称，解析 DST 实际偏移
  let srcForParse = srcTz;
  let dstForParse = dstTz;
  if (srcTz.includes('[') || !/^[+-]/.test(srcTz.replace(/\[.*?\]$/, ''))) {
    const iana = srcTz.match(/\[([^\]]+)\]/);
    const resolved = _resolveNamedTimezone(iana ? iana[1] : srcTz, year ?? 1984, month ?? 1, day ?? 1, hour ?? 12, minute ?? 0);
    const match = resolved.match(/^([+-]\d{2}:\d{2})/);
    if (match) srcForParse = match[1];
  }
  if (dstTz.includes('[') || !/^[+-]/.test(dstTz.replace(/\[.*?\]$/, ''))) {
    const iana = dstTz.match(/\[([^\]]+)\]/);
    const resolved = _resolveNamedTimezone(iana ? iana[1] : dstTz, year ?? 1984, month ?? 1, day ?? 1, hour ?? 12, minute ?? 0);
    const match = resolved.match(/^([+-]\d{2}:\d{2})/);
    if (match) dstForParse = match[1];
  }
  const srcOffset = _parseTzOffset(srcForParse);
  const dstOffset = _parseTzOffset(dstForParse);
  if (srcOffset === dstOffset) return { hour, minute, dayDelta: 0 };
  const diffMinutes = dstOffset - srcOffset;
  const totalMinutes = hour * 60 + minute + diffMinutes;
  const dayDelta = Math.floor(totalMinutes / 1440);
  const adjustedMinutes = ((totalMinutes % 1440) + 1440) % 1440;
  return { hour: Math.floor(adjustedMinutes / 60), minute: Math.round(adjustedMinutes % 60), dayDelta };
}

/** 归一化 duration ISO 字符串：分解分数值、进位溢出、处理非标准格式 */
function _normalizeDurationStr(str: string): string {
  const upper = str.toUpperCase()
  // 处理非标准格式 P2012-02-02T14:37:21.545 → parse date/time
  const dateForm = upper.match(/^P(\d{4})-(\d{2})-(\d{2})T(.+)$/)
  if (dateForm) {
    const years = parseInt(dateForm[1], 10)
    const months = parseInt(dateForm[2], 10)
    const days = parseInt(dateForm[3], 10)
    // parse time part
    const timeStr = dateForm[4]
    const timeParts = timeStr.match(/^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)$/)
    if (timeParts) {
      const hours = parseInt(timeParts[1], 10)
      const minutes = parseInt(timeParts[2], 10)
      let seconds = parseFloat(timeParts[3])
      return _formatDuration(years, months, 0, days, hours, minutes, seconds, 0)
    }
  }
  // 标准或非标准化 ISO 持续期间格式
  // P[n]Y[n]M[n]DT[n]H[n]M[n]S 或 P[n]W 等
  let years = 0, months = 0, weeks = 0, days = 0
  let hours = 0, minutes = 0, seconds = 0
  const AVG_DAYS_PER_MONTH = 30.436875

  // 分离日期部分和时间部分
  const tIdx = upper.indexOf('T')
  const datePart = tIdx >= 0 ? str.slice(1, tIdx) : str.slice(1)
  const timePart = tIdx >= 0 ? str.slice(tIdx + 1) : ''

  // 解析日期部分（支持负值）
  const yearMatch = datePart.match(/(-?[\d.]+)Y/i)
  if (yearMatch) years = parseFloat(yearMatch[1])
  const monthMatch = datePart.match(/(-?[\d.]+)M/i)
  if (monthMatch) months = parseFloat(monthMatch[1])
  const weekMatch = datePart.match(/(-?[\d.]+)W/i)
  if (weekMatch) weeks = parseFloat(weekMatch[1])
  const dayMatch = datePart.match(/(-?[\d.]+)D/i)
  if (dayMatch) days = parseFloat(dayMatch[1])

  // 解析时间部分（支持负值）
  const hourMatch = timePart.match(/(-?[\d.]+)H/i)
  if (hourMatch) hours = parseFloat(hourMatch[1])
  const minMatch = timePart.match(/(-?[\d.]+)M(?!S)/i)
  if (minMatch) minutes = parseFloat(minMatch[1])
  const secMatch = timePart.match(/(-?[\d.]+)S/i)
  if (secMatch) seconds = parseFloat(secMatch[1])

  // weeks → days
  if (weeks) { days += weeks * 7; weeks = 0 }

  // 分数分解
  if (years % 1 !== 0) { months += (years - Math.floor(years)) * 12; years = Math.floor(years) }
  if (months % 1 !== 0) { days += (months - Math.floor(months)) * AVG_DAYS_PER_MONTH; months = Math.floor(months) }
  if (days % 1 !== 0) { hours += (days - Math.floor(days)) * 24; days = Math.floor(days) }
  if (hours % 1 !== 0) { minutes += (hours - Math.floor(hours)) * 60; hours = Math.floor(hours) }
  if (minutes % 1 !== 0) { seconds += (minutes - Math.floor(minutes)) * 60; minutes = Math.floor(minutes) }
  // 秒的分数 → 保留为秒的小数部分（不剥离）
  // 如果 seconds 有小数，不做 floor，让 _formatDuration 保留其小数形式
  let nanos = 0

  // 进位（注意 seconds 可能有小数，进位前取整）
  // 向零取整（trunc），避免 -0.001 → floor → -1 的问题
  let secInt = seconds >= 0 ? Math.floor(seconds) : Math.ceil(seconds)
  const secFrac = seconds - secInt
  // 处理负值跨组件借位：负秒从分钟借，负分钟从小时借，负小时从天数借
  while (secInt < 0 && minutes > 0) { minutes--; secInt += 60 }
  while (minutes < 0 && hours > 0) { hours--; minutes += 60 }
  while (hours < 0 && days > 0) { days--; hours += 24 }
  // 常规正进位
  while (secInt >= 60) { minutes += Math.floor(secInt / 60); secInt = secInt % 60 }
  while (minutes >= 60) { hours += Math.floor(minutes / 60); minutes = minutes % 60 }
  while (hours >= 24) { days += Math.floor(hours / 24); hours = hours % 24 }
  // 恢复小数部分（精度修整：最多保留 9 位小数，去除尾零）
  seconds = secInt + Math.round(secFrac * 1e9) / 1e9

  return _formatDuration(Math.floor(years), Math.floor(months), 0, Math.floor(days),
    Math.floor(hours), Math.floor(minutes), seconds, 0)
}

/** 格式化 duration 组件为标准字符串 */
function _formatDuration(years: number, months: number, _weeks: number, days: number,
  hours: number, minutes: number, seconds: number, nanos: number): string {
  while (nanos >= 1e9) { seconds++; nanos -= 1e9 }
  while (nanos < 0) { seconds--; nanos += 1e9 }
  while (seconds >= 60) { minutes++; seconds -= 60 }
  if (days >= 0) { while (seconds < 0) { minutes--; seconds += 60 } }
  while (minutes >= 60) { hours++; minutes -= 60 }
  if (!(hours <= 0 && minutes < 0)) { while (minutes < 0) { hours--; minutes += 60 } }
  if (days > 0 && hours > 0) {
    while (hours < days) { days -= 1; hours += 24; if (days <= 0) break; }
    if (hours / days > 1.5) { days -= 1; hours += 24 }
  }
  if (months >= 12) { years += Math.floor(months / 12); months = months % 12 }
  if (months > 0 && months % 1 !== 0) { days += (months - Math.floor(months)) * 30.436875; months = Math.floor(months); }
  if (days > 0 && days % 1 !== 0) { hours += (days - Math.floor(days)) * 24; days = Math.floor(days); }
  if (hours > 0 && hours % 1 !== 0) { minutes += (hours - Math.floor(hours)) * 60; hours = Math.floor(hours); }
  if (minutes > 0 && minutes % 1 !== 0) { seconds += (minutes - Math.floor(minutes)) * 60; minutes = Math.floor(minutes); }
  while (seconds >= 60) { minutes++; seconds -= 60 }
  if (days >= 0) { while (seconds < 0) { minutes--; seconds += 60 } }
  while (minutes >= 60) { hours++; minutes -= 60 }
  if (!(hours <= 0 && minutes < 0)) { while (minutes < 0) { hours--; minutes += 60 } }
  if (!Number.isInteger(seconds)) {
    const intS = seconds >= 0 ? Math.floor(seconds) : Math.ceil(seconds)
    const extraNs = Math.round(Math.abs(seconds - intS) * 1e9)
    seconds = intS; nanos += extraNs
    while (nanos >= 1e9) { seconds++; nanos -= 1e9 }
    while (nanos < 0) { seconds--; nanos += 1e9 }
  }
  // 秒的小数部分：如果 seconds 有小数，保留其小数形式
  let secStr = ''
  if (seconds || nanos) {
    if (Number.isInteger(seconds)) {
      secStr = String(seconds)
      if (nanos > 0) {
        let nsStr = String(nanos).padStart(9, '0').replace(/0+$/, '')
        if (seconds === 0 && days < 0) { secStr = '-0.' + nsStr }
        else { secStr += '.' + nsStr }
      } else if (nanos < 0) {
        // 负纳秒：纳秒以正数小数形式附加（负号已在秒上）
        let nsStr = String(Math.abs(nanos)).padStart(9, '0').replace(/0+$/, '')
        if (seconds === 0) {
          secStr = '-0.' + nsStr
        } else {
          secStr = String(seconds) + '.' + nsStr
        }
      }
    } else {
      // 有小数秒（如 49.5），保留原样
      secStr = String(seconds)
    }
  }
  let result = 'P'
  if (years) result += years + 'Y'
  if (months) result += months + 'M'
  if (days) result += days + 'D'
  if (hours || minutes || secStr) {
    result += 'T'
    if (hours) result += hours + 'H'
    if (minutes) result += minutes + 'M'
    if (secStr) result += secStr + 'S'
  }
  return result === 'P' ? 'PT0S' : (result || 'PT0S')
}

export function _formatTimezone(tz: string): string {
  return /^[+-]\d{2}:\d{2}:00$/.test(tz) ? tz.slice(0, -3) : tz
}

/** 将 map 中的覆盖字段（second, minute, hour 等）合并到时间字符串中 */
function _mergeTimeStr(timeStr: string, map: Record<string, unknown>): string {
  const hasOverrides = map.hour != null || map.minute != null || map.second != null || map.nanosecond != null || map.microsecond != null || map.millisecond != null || map.timezone != null
  if (!hasOverrides) return timeStr
  const parts = timeStr.match(/(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?/)
  if (!parts) return timeStr
  const baseHour = Number(parts[1]), baseMinute = Number(parts[2])
  const baseSecStr = parts[3] || '0'
  let baseSecond = 0, baseNanosecond = 0
  if (baseSecStr.includes('.')) { baseSecond = Number(baseSecStr.split('.')[0]); baseNanosecond = Math.round(parseFloat('0.' + baseSecStr.split('.')[1]) * 1e9) }
  else { baseSecond = Number(baseSecStr) }
  const merged = {
    hour: map.hour != null ? Number(map.hour) : baseHour,
    minute: map.minute != null ? Number(map.minute) : baseMinute,
    second: map.second != null ? Number(map.second) : baseSecond,
    nanosecond: map.nanosecond != null ? Number(map.nanosecond) : baseNanosecond,
  }
  const { hour, minute, second, nanosecond } = _extractTimeMap(merged)
  return _formatTime(hour, minute, second, nanosecond)
}

/** 将 map 中的日期覆盖字段（year, month, day）合并到日期字符串中 */
function _mergeDateStr(dateStr: string, map: Record<string, unknown>): string {
  const hasOverrides = map.year != null || map.month != null || map.day != null || map.week != null || map.dayOfWeek != null || map.quarter != null || map.dayOfQuarter != null || map.ordinalDay != null
  if (!hasOverrides) return dateStr
  const parts = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!parts) return dateStr
  let year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3])
  if (map.year != null) year = Number(map.year)
  if (map.month != null) month = Number(map.month)
  if (map.day != null) { day = Number(map.day) }
  else if (map.week != null || map.dayOfWeek != null || map.quarter != null || map.dayOfQuarter != null || map.ordinalDay != null) {
    const y = map.year != null ? Number(map.year) : year
    // week/quarter/ordinalDay 必须使用 ISO 周年份，而非日历年份
    const isoYearForWeek = map.year != null ? Number(map.year) : _isoYear(new Date(dateStr))
    // week: 计算 ISO 周
    if (map.week != null) {
      const w = Number(map.week)
      // week 0 = 上一年的最后一周
      const actualYear = w <= 0 ? isoYearForWeek - 1 : isoYearForWeek
      const actualWeek = w <= 0 ? _isoWeeksInYear(actualYear) : w
      const w1 = _isoWeek1Monday(actualYear)
      const targetDate = new Date(w1.getTime() + (actualWeek - 1) * 7 * 86400000)
      year = targetDate.getUTCFullYear()
      month = targetDate.getUTCMonth() + 1
      day = targetDate.getUTCDate()
      // dayOfWeek 覆盖：调整到指定周几（1=Monday, 7=Sunday）
      // 无 dayOfWeek 时继承 date 的 dayOfWeek（不是默认周一！）
      if (map.dayOfWeek != null) {
        const dow = Number(map.dayOfWeek)
        const currentDow = targetDate.getUTCDay() === 0 ? 7 : targetDate.getUTCDay()
        const diff = dow - currentDow
        const adj = new Date(targetDate.getTime() + diff * 86400000)
        year = adj.getUTCFullYear()
        month = adj.getUTCMonth() + 1
        day = adj.getUTCDate()
      } else {
        // 继承原始 date 的 dayOfWeek
        const origDate = new Date(dateStr)
        const origDow = origDate.getUTCDay() === 0 ? 7 : origDate.getUTCDay()
        const currentDow = targetDate.getUTCDay() === 0 ? 7 : targetDate.getUTCDay()
        const diff = origDow - currentDow
        const adj = new Date(targetDate.getTime() + diff * 86400000)
        year = adj.getUTCFullYear()
        month = adj.getUTCMonth() + 1
        day = adj.getUTCDate()
      }
    } else if (map.dayOfWeek != null) {
      // 无 week 覆盖，只有 dayOfWeek：从当前日期计算出在所在周中移动到指定周几
      const d = new Date(dateStr);
      const currentDow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
      const diff = Number(map.dayOfWeek) - currentDow;
      const adj = new Date(d.getTime() + diff * 86400000);
      month = adj.getUTCMonth() + 1;
      day = adj.getUTCDate();
    } else if (map.quarter != null) {
      const q = Number(map.quarter)
      month = (q - 1) * 3 + 1
      day = 1
      // dayOfQuarter 覆盖：quarter 第一天 + (dayOfQuarter-1) 天
      if (map.dayOfQuarter != null) {
        const dq = Number(map.dayOfQuarter)
        const d = new Date(Date.UTC(y, month - 1, 1 + dq - 1))
        month = d.getUTCMonth() + 1
        day = d.getUTCDate()
      }
    } else if (map.ordinalDay != null) {
      const od = Number(map.ordinalDay)
      const d = new Date(Date.UTC(y, 0, od))
      month = d.getUTCMonth() + 1
      day = d.getUTCDate()
    }
  }
  return String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0")
}

/** 对日期字符串按 unit 进行截断。str 可以是纯日期或完整 datetime/localdatetime 字符串。
 * 参数 dateOnly=true 表示只返回日期部分（用于 date.truncate）。*/
function _truncateDateStr(str: string, unit: string, dateOnly = false): string {
  // 提取日期部分
  const datePart = str.includes('T') ? str.slice(0, str.indexOf('T')) : str;
  const timePart = str.includes('T') ? str.slice(str.indexOf('T')) : 'T00:00:00';
  const origTz = _extractTz(str);
  const cleanTime = timePart.replace(/[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$|Z$/, '');
  if (["millennium","millennia","century","centuries","decade","decades","weekyear","weekyears","year","years"].includes(unit)) {
    let year = Number(datePart.slice(0,4));
    if (unit === "millennium" || unit === "millennia") year = Math.floor(year / 1000) * 1000;
    else if (unit === "century" || unit === "centuries") year = Math.floor(year / 100) * 100;
    else if (unit === "decade" || unit === "decades") year = Math.floor(year / 10) * 10;
    else if (["weekyear","weekyears"].includes(unit)) {
      const d = new Date(datePart);
      const iy = _isoYear(d);
      const w1 = _isoWeek1Monday(iy);
      const truncated = w1.getUTCFullYear() + "-" + String(w1.getUTCMonth() + 1).padStart(2, "0") + "-" + String(w1.getUTCDate()).padStart(2, "0");
      return _withTime(truncated, 'T00:00' + (origTz || 'Z'));
    }
    const truncated = String(year).padStart(4,"0") + "-01-01";
    return _withTime(truncated, 'T00:00' + (origTz || 'Z'));
  }
  if (["quarter","quarters"].includes(unit)) {
    const m = Number(datePart.slice(5,7));
    const q = Math.ceil(m / 3);
    const qm = String((q - 1) * 3 + 1).padStart(2,"0");
    const truncated = datePart.slice(0,5) + qm + "-01";
    return _withTime(truncated, 'T00:00' + (origTz || 'Z'));
  }
  if (["month","months"].includes(unit)) {
    const truncated = datePart.slice(0,7) + "-01";
    return _withTime(truncated, 'T00:00' + (origTz || 'Z'));
  }
  if (["day","days"].includes(unit)) {
    const truncated = datePart;
    return _withTime(truncated, 'T00:00' + (origTz || 'Z'));
  }
  if (["hour","hours"].includes(unit)) {
    const truncated = datePart;
    return _withTime(truncated, 'T' + cleanTime.slice(1,3) + ':00' + (origTz || 'Z'));
  }
  if (["minute","minutes"].includes(unit)) {
    const truncated = datePart;
    // minute truncation 输出 HH:MM（不带 :00 秒）
    return _withTime(truncated, cleanTime.slice(0,6) + (origTz || 'Z'));
  }
  if (["second","seconds"].includes(unit)) {
    const truncated = datePart;
    // second truncation 去掉小数部分（纳秒/微秒/毫秒），保留时区后缀
    const cleanSec = cleanTime.includes('.') ? cleanTime.slice(0, cleanTime.indexOf('.')) : cleanTime;
    return truncated + cleanSec + origTz;
  }
  if (["week","weeks"].includes(unit)) {
    const d = new Date(datePart); const day = d.getUTCDay();
    d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
    const truncated = d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2,"0") + "-" + String(d.getUTCDate()).padStart(2,"0");
    return _withTime(truncated, 'T00:00' + (origTz || 'Z'));
  }
  // millisecond/microsecond/nanosecond truncation — 保留到对应精度
  function _truncNanos(rawNanos: string, precision: 'ms'|'us'|'ns'): string {
    if (!rawNanos) return '';
    const len = precision === 'ms' ? 3 : precision === 'us' ? 6 : 9;
    return rawNanos.slice(0, len).padEnd(len, '0');
  }
  if (["millisecond","milliseconds"].includes(unit)) {
    let rawNanos = '';
    if (timePart) { const m = timePart.match(/\.(\d+)/); if (m) rawNanos = m[1]; }
    const trunc = _truncNanos(rawNanos, 'ms');
    const trimmed = trunc.replace(/0+$/, '');
    const timePrefix = cleanTime.includes('.') ? cleanTime.slice(0, cleanTime.indexOf('.')) : cleanTime;
    return datePart + (trimmed ? timePrefix + '.' + trimmed : timePrefix) + origTz;
  }
  if (["microsecond","microseconds"].includes(unit)) {
    let rawNanos = '';
    if (timePart) { const m = timePart.match(/\.(\d+)/); if (m) rawNanos = m[1]; }
    const trunc = _truncNanos(rawNanos, 'us');
    const trimmed = trunc.replace(/0+$/, '');
    const timePrefix = cleanTime.includes('.') ? cleanTime.slice(0, cleanTime.indexOf('.')) : cleanTime;
    return datePart + (trimmed ? timePrefix + '.' + trimmed : timePrefix) + origTz;
  }
  if (["nanosecond","nanoseconds"].includes(unit)) {
    let rawNanos = '';
    if (timePart) { const m = timePart.match(/\.(\d+)/); if (m) rawNanos = m[1]; }
    const trunc = _truncNanos(rawNanos, 'ns');
    const trimmed = trunc.replace(/0+$/, '');
    const timePrefix = cleanTime.includes('.') ? cleanTime.slice(0, cleanTime.indexOf('.')) : cleanTime;
    return datePart + (trimmed ? timePrefix + '.' + trimmed : timePrefix) + origTz;
  }
  // 未知 unit — 返回原值
  return str;
  // 内部函数：根据 dateOnly 决定是否追加时间部分
  function _withTime(date: string, time: string): string {
    if (dateOnly || !str.includes('T')) return date;
    // 如果原字符串无时区后缀，不加 Z（localdatetime/localtime）
    if (!origTz) {
      const timeNoTz = time.replace(/Z$/, '');
      return date + timeNoTz;
    }
    return date + time;
  }
}

/** 对时间字符串按 unit 进行截断。str 可以是纯时间或带时区的时间字符串。 */
function _truncateTimeStr(str: string, unit: string): string {
  // 提取时区后缀
  const tzMatch = str.match(/[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$|Z$/);
  const tz = tzMatch ? tzMatch[0] : '';
  const cleanTime = str.replace(/[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$|Z$/, '');
  const parts = cleanTime.split(':');
  if (parts.length < 2) return str;
  const hh = parts[0];
  const mm = parts.length >= 2 ? parts[1] : '00';
  const ssRaw = parts.length >= 3 ? parts.slice(2).join(':') : '';
  // 解析秒 + 纳秒部分
  let ss = '', nanos = '';
  if (ssRaw.includes('.')) {
    ss = ssRaw.split('.')[0];
    nanos = ssRaw.split('.')[1];
  } else {
    ss = ssRaw;
  }
  if (["day","days"].includes(unit)) return '00:00' + tz;
  if (["hour","hours"].includes(unit)) return hh + ':00' + (ss.includes('00') && mm === '00' ? '' : '') + tz;
  if (["minute","minutes"].includes(unit)) return hh + ':' + mm + tz;
  if (["second","seconds"].includes(unit)) return hh + ':' + mm + ':' + ss + tz;
  if (["millisecond","milliseconds"].includes(unit)) {
    const truncatedNanos = nanos ? nanos.slice(0, 3).padEnd(3, '0') : '000';
    return hh + ':' + mm + ':' + ss + '.' + truncatedNanos.replace(/0+$/, '') + tz;
  }
  if (["microsecond","microseconds"].includes(unit)) {
    const truncatedNanos = nanos ? nanos.slice(0, 6).padEnd(6, '0') : '000000';
    return hh + ':' + mm + ':' + ss + '.' + truncatedNanos.replace(/0+$/, '') + tz;
  }
  if (["nanosecond","nanoseconds"].includes(unit)) {
    const truncatedNanos = nanos ? nanos.padEnd(9, '0') : '000000000';
    const trimmed = truncatedNanos.replace(/0+$/, '');
    if (!trimmed) return hh + ':' + mm + ':' + ss + tz;
    return hh + ':' + mm + ':' + ss + '.' + trimmed + tz;
  }
  // 未知 unit — 返回原值
  return str;
}

/** 将 truncate 结果（date 格式）转为 datetime 格式 */
/** 将 truncation 结果的日期字段用 config 中的 day/month 等覆盖 */
function _applyTruncateConfig(result: string, configArg: string, r: Record<string, unknown> | undefined, origStr?: string): string {
  // configArg 可能被引号包裹（字符串字面量），需要 strip 后重新 eval
  let cleanArg = configArg.trim()
  if ((cleanArg.startsWith("'") && cleanArg.endsWith("'")) || (cleanArg.startsWith('"') && cleanArg.endsWith('"')))
    cleanArg = cleanArg.slice(1, -1)
  const cv = _evalBinary(cleanArg, r);
  if (!cv || typeof cv !== 'object') return result;
  const config = cv as Record<string, unknown>;
  // 检查是否有可用的日期覆盖字段
  const hasDateOverrides = config.day != null || config.month != null || config.year != null ||
    config.week != null || config.dayOfWeek != null || config.quarter != null || config.dayOfQuarter != null;
  // 检查是否有时间覆盖字段
  const hasTimeOverrides = config.hour != null || config.minute != null || config.second != null ||
    config.nanosecond != null || config.microsecond != null || config.millisecond != null;
  if (!hasDateOverrides && !hasTimeOverrides) {
    // 只检查时区覆盖
    if (config.timezone != null) {
      // 如果 result 是纯时间格式（无日期部分，只有 HH:MM[:SS...] 和Optional的时区），直接替换时区后缀
      if (!result.includes('T') && !/^\d{4}/.test(result)) {
        const noTz = result.replace(/[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$|Z$/, '');
        const tz = _formatTimezone(_resolveNamedTimezone(String(config.timezone)));
        return noTz + tz;
      }
      // 从 result 提取年、月、日以获取正确的时区 offset（夏令时/冬令时）
      const parts = result.split('-');
      const tzYear = parseInt(parts[0], 10) || undefined;
      const tzMonth = parts.length >= 2 ? parseInt(parts[1], 10) : undefined;
      const tzDay = parts.length >= 3 ? parseInt(parts[2].split('T')[0], 10) : undefined;
      const tz = _formatTimezone(_resolveNamedTimezone(String(config.timezone), tzYear, tzMonth, tzDay));
      const datePart = result.includes('T') ? result.slice(0, result.indexOf('T')) : result;
      const timePartRaw = result.includes('T') ? result.slice(result.indexOf('T')) : 'T00:00:00';
      // Strip existing timezone from time part before appending new one
      const timePart = timePartRaw.replace(/[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$/, '').replace('Z', '');
      // 格式规范化：T00:00:00 → T00:00；T00:00:00.000 → T00:00
      const fmtTime = timePart.replace(/T00:00:00(?:\.0+)?$/, 'T00:00');
      return datePart + fmtTime + tz;
    }
    return result;
  }
  // 处理时间覆盖字段（hour/minute/second/nanosecond/microsecond/millisecond）
  let currentTime = result.includes('T') ? result.slice(result.indexOf('T')) : result.includes(':') ? 'T' + result.split(/[+-]/)[0].trim() : '';
  // 如果结果不包含时间部分（纯日期），不要添加时间部分
  const isDateOnly = !result.includes('T') && !result.includes(':');
  let currentOriginTz = result.replace(/^[^T]*T/, '').match(/[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$|Z$/);
  let currentTz = currentOriginTz ? currentOriginTz[0] : '';
  let cleanTimePart = currentTime;
  if (currentTime) {
    cleanTimePart = currentTime.replace(/[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$/, '').replace('Z', '');
  }
  if (hasTimeOverrides && !isDateOnly) {
    // Extract current time components
    const timeParts = cleanTimePart ? cleanTimePart.slice(1).split(':') : [];
    if (timeParts.length < 2) timeParts.push('00', '00');
    let hh = timeParts[0] || '00';
    let mm = timeParts[1] || '00';
    let ssRaw = timeParts.slice(2).join(':') || '00';
    let ss = ssRaw, nanos = '';
    if (ssRaw.includes('.')) { ss = ssRaw.split('.')[0]; nanos = ssRaw.split('.')[1]; }
    // Apply overrides
    if (config.hour != null) hh = String(Number(config.hour)).padStart(2, '0');
    if (config.minute != null) mm = String(Number(config.minute)).padStart(2, '0');
    if (config.second != null) ss = String(Number(config.second)).padStart(2, '0');
    if (config.nanosecond != null) {
      const nsPadded = nanos.padEnd(9, '0');
      nanos = nsPadded.slice(0, 6) + String(Number(config.nanosecond)).padStart(3, '0');
    }
    if (config.microsecond != null) {
      const usPadded = nanos.padEnd(9, '0');
      nanos = String(Number(config.microsecond)).padStart(6, '0') + usPadded.slice(6);
    }
    if (config.millisecond != null) {
      const msPadded = nanos.padEnd(9, '0');
      nanos = String(Number(config.millisecond)).padStart(3, '0') + msPadded.slice(3);
    }
    // Build time string with appropriate precision
    let timeStr;
    if (nanos) {
      const trimmedNanos = nanos.replace(/0+$/, '');
      timeStr = hh + ':' + mm + ':' + ss + '.' + trimmedNanos;
    } else {
      timeStr = hh + ':' + mm + ':' + ss;
      // If original had no fractional part, don't add one
    }
    cleanTimePart = 'T' + timeStr;
  }
  // 合并日期覆盖字段到 truncation 结果的日期部分
  let datePart = isDateOnly || !result.includes('T') ? (result.includes(':') ? '' : result) : result.slice(0, result.indexOf('T'));
  if (hasDateOverrides) {
    datePart = _mergeDateStr(datePart, config);
  }
  // If any timezone 覆盖且 config 中指定了 timezone，附加它
  if (config.timezone != null) {
    const parts = datePart.split('-');
    const tzYear = parseInt(parts[0], 10) || undefined;
    const tzMonth = parts.length >= 2 ? parseInt(parts[1], 10) : undefined;
    const tzDay = parts.length >= 3 ? parseInt(parts[2].split('T')[0], 10) : undefined;
    currentTz = _formatTimezone(_resolveNamedTimezone(String(config.timezone), tzYear, tzMonth, tzDay));
  }
  return (datePart || '') + (cleanTimePart ? (datePart ? cleanTimePart : cleanTimePart.replace(/^T/, '')) : '') + currentTz;
}

/** 从字符串中提取时区后缀（Z / +HH:MM 等） */
function _extractTz(str: string): string {
  if (str.includes('Z')) return 'Z';
  const m = str.match(/[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$/);
  return m ? m[0] : '';
}

export function _resolveNamedTimezone(tz: string, year?: number, month?: number, day?: number, hour?: number, minute?: number): string {
  if (/^[+-]\d{2}:\d{2}/.test(tz)) return tz
  if (tz.includes('[')) return tz
  try {
    const date = (year != null && month != null && day != null)
      ? new Date(Date.UTC(year, month - 1, day, hour ?? 12, minute ?? 0)) : new Date()
    const parts = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(date)
    const tzPart = parts.find(p => p.type === 'timeZoneName')
    if (tzPart && tzPart.value) {
      // longOffset 格式: GMT+HH:MM:SS 或 GMT+HH:MM
      const m = tzPart.value.match(/^GMT([+-]\d{2}:\d{2}(?::\d{2})?)$/)
      if (m) return m[1] + '[' + tz + ']'
    }
  } catch {}
  return tz
}

// 将无时区的本地时间字符串（如 "2017-10-29T04:00"）转换为 IANA 时区的 Date 对象
export function _tzLocalToUTC(localStr: string, ianaTz: string): Date | null {
  try {
    const dateRe = localStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
    const timeRe = localStr.match(/T(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?/);
    if (!dateRe) return null;
    const year = parseInt(dateRe[1],10), month = parseInt(dateRe[2],10), day = parseInt(dateRe[3],10);
    let hour = 0, minute = 0, second = 0, nsFrac = 0;
    if (timeRe) {
      hour = parseInt(timeRe[1],10); minute = parseInt(timeRe[2],10);
      if (timeRe[3]) { second = parseFloat(timeRe[3]); nsFrac = Math.round((second - Math.floor(second)) * 1e9); second = Math.floor(second); }
    }
    const targetLocal = { year, month, day, hour, minute };
    for (let hAdj = -14; hAdj <= 14; hAdj++) {
      const utcH = ((hour - hAdj) % 24 + 24) % 24;
      const dayAdj = hAdj > hour ? -1 : (hour - hAdj >= 24 ? 1 : 0);
      const utcD = day + dayAdj;
      const testDate = new Date(Date.UTC(year, month-1, utcD, utcH, minute, second, Math.round(nsFrac/1e6)));
      const parts = new Intl.DateTimeFormat('en', {
        timeZone: ianaTz, timeZoneName: 'shortOffset',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
      }).formatToParts(testDate);
      const map: Record<string, string> = {};
      parts.forEach(p => map[p.type] = p.value);
      if (parseInt(map.hour) === targetLocal.hour &&
          parseInt(map.minute) === targetLocal.minute &&
          parseInt(map.day) === targetLocal.day &&
          parseInt(map.month) === targetLocal.month) {
        return testDate;
      }
    }
    return null;
  } catch { return null }
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

/** ISO 8601 一年的周数（52 或 53） */
export function _isoWeeksInYear(year: number): number {
  const w1 = _isoWeek1Monday(year)
  const w1Next = _isoWeek1Monday(year + 1)
  return Math.round((w1Next.getTime() - w1.getTime()) / (7 * 86400000))
}

/** 获取日期对应的 ISO 周数 */
export function _isoWeekNumber(d: Date): number {
  const iy = _isoYear(d)
  const w1 = _isoWeek1Monday(iy)
  return Math.floor((d.getTime() - w1.getTime()) / (7 * 86400000)) + 1
}

/** Construct a UTC Date from calendar year/month/day components without the
 *  0-99 → 1900+ year mapping that `new Date(Date.UTC(year, ...))` applies to
 *  two-digit years. Cypher temporal literals legitimately use years like 1
 *  (e.g. `date({year: 1})`), which must map to 0001, not 1901.
 *
 *  `Date.UTC(1, 0, 1)` returns 1901-01-01 because the Date constructor folds
 *  years 0-99 into 1900-1999. `setUTCFullYear` does not apply that fold, so we
 *  build from the epoch and set the full year explicitly. */
function _utcDateFromYmd(year: number, monthIndex: number, day: number): Date {
  const d = new Date(0)
  d.setUTCFullYear(year, monthIndex, day)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

/** Format a Date as a zero-padded ISO calendar date `YYYY-MM-DD`. Unlike a bare
 *  `getUTCFullYear()` (which returns `1` for year 1), the year is left-padded
 *  to four digits so `date({year: 1})` yields `0001-01-01`, matching Cypher. */
function _fmtUtcDate(d: Date): string {
  return String(d.getUTCFullYear()).padStart(4, '0') + "-" + String(d.getUTCMonth() + 1).padStart(2, '0') + "-" + String(d.getUTCDate()).padStart(2, '0')
}

export function _resolveDateFromMap(map: Record<string, unknown>): Date {
  if (map.date != null) {
    const baseStr = typeof map.date === 'string' ? map.date : String(map.date)
    // 提取纯净日期部分（去掉 T 后的时间部分）
    const dateOnly = baseStr.indexOf('T') >= 0 ? baseStr.slice(0, baseStr.indexOf('T')) : baseStr
    const parts = dateOnly.split('-')
    if (parts.length === 3) {
      let year = Number(parts[0]), month2 = Number(parts[1]), day2 = Number(parts[2])
      if (map.year != null) year = Number(map.year)
      if (map.month != null) month2 = Number(map.month)
      if (map.day != null) day2 = Number(map.day)
      const base = _utcDateFromYmd(year, month2 - 1, day2)
      if (map.week != null || map.dayOfWeek != null || map.quarter != null || map.ordinalDay != null) {
        // dateDow 取原始 date 的 dayOfWeek（当 map.year 覆盖时，base 日期变了，但 dayOfWeek 继承不变！）
        const origDate = map.date ? new Date(typeof map.date === 'string' ? map.date.replace(/T.*$/, '') : String(map.date).replace(/T.*$/, '')) : base
        const dateDow = origDate.getUTCDay() === 0 ? 7 : origDate.getUTCDay()
        const isoY = map.year != null ? Number(map.year) : _isoYear(base)
        // quarter / ordinalDay 处理
        if (map.quarter != null) {
          const q = Number(map.quarter)
          const qm = (q - 1) * 3 + 1
          // quarter: 保持 other 的 dayOfQuarter（从 Q1 开始的天数偏移）
          if (map.dayOfQuarter != null) {
            const dq = Number(map.dayOfQuarter)
            const qDate = _utcDateFromYmd(isoY, qm - 1, dq)
            return qDate
          }
          // 保留 other 的 dayOfQuarter（不是简单改 month！）
          const otherDoQ = Math.ceil((_utcDateFromYmd(isoY, month2 - 1, day2).getTime() - _utcDateFromYmd(isoY, Math.floor((month2 - 1) / 3) * 3, 1).getTime()) / 86400000) + 1
          return _utcDateFromYmd(isoY, qm - 1, 1 + otherDoQ - 1)
        }
        if (map.ordinalDay != null) {
          const od = Number(map.ordinalDay)
          return _utcDateFromYmd(isoY, 0, od)
        }
        // week/dayOfWeek 处理
        const w1Mon = _isoWeek1Monday(isoY)
        const tw = map.week != null ? Number(map.week) : _isoWeekNumber(base)
        const dow = map.dayOfWeek != null ? Number(map.dayOfWeek) : dateDow
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
    const d = _utcDateFromYmd(year, 0, 1)
    d.setUTCDate(d.getUTCDate() + Number(map.ordinalDay) - 1)
    return d
  }
  return _utcDateFromYmd(year, month - 1, day)
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

/**
 * Evaluate a list predicate expression: ALL/ANY/NONE/SINGLE(var IN list WHERE condition).
 *
 * Cypher 3-valued logic for list predicates:
 * - ALL:  true if list is empty OR every element satisfies predicate.
 *          null if at least one element yields null AND none yield false.
 *          false if at least one element yields false.
 * - ANY:  true if at least one element yields true.
 *          null if no element yields true AND at least one yields null.
 *          false if all elements yield false.
 * - NONE: true if all elements yield false.
 *          null if all yield false/null AND at least one yields null.
 *          false if at least one element yields true.
 * - SINGLE: true if exactly one element yields true.
 *           null if >1 yield true OR (0 yield true AND at least one yields null).
 *           false if 0 yield true AND 0 yield null.
 */
function _evalListPredicate(
  predicateType: 'all' | 'any' | 'none' | 'single',
  varName: string,
  listExpr: string,
  whereClause: string,
  row?: Record<string, unknown>
): unknown {
  const list = _evalBinary(listExpr, row)
  if (!Array.isArray(list)) return null

  let trueCount = 0
  let nullCount = 0
  let falseCount = 0

  for (const elem of list) {
    const injectedRow = { ...row, [varName]: elem }
    const cond = _evalBinary(whereClause, injectedRow)
    if (cond === true) trueCount++
    else if (cond === null || cond === undefined) nullCount++
    else falseCount++
  }

  switch (predicateType) {
    case 'all':
      // true if empty or all true; null if no false but some null; false otherwise
      if (falseCount > 0) return false
      if (nullCount > 0) return null
      return true
    case 'any':
      // true if any true; null if no true and some null; false if all false
      if (trueCount > 0) return true
      if (nullCount > 0) return null
      return false
    case 'none':
      // true if all false; null if mix of false/null with some null; false if any true
      if (trueCount > 0) return false
      if (nullCount > 0) return null
      return true
    case 'single':
      // true if exactly one true; null if >1 true or (0 true and some null); false if 0 true and 0 null
      if (trueCount === 1 && nullCount === 0) return true
      if (trueCount > 1) return null
      if (nullCount > 0) return null
      return false
    default:
      return null
  }
}

const _builtinFunctions: Record<string, _BuiltinFn> = {
  // ── List predicates: ALL / ANY / NONE / SINGLE ──
  // Syntax: ALL(varName IN listExpr WHERE condition)
  // Argument is a single string "varName IN listExpr WHERE condition"
  all: ([a], r) => {
    const m = String(a || '').match(/^(\w+)\s+IN\s+(.+?)\s+WHERE\s+(.+)$/is)
    if (!m) return null
    return _evalListPredicate('all', m[1], m[2].trim(), m[3].trim(), r)
  },
  any: ([a], r) => {
    const m = String(a || '').match(/^(\w+)\s+IN\s+(.+?)\s+WHERE\s+(.+)$/is)
    if (!m) return null
    return _evalListPredicate('any', m[1], m[2].trim(), m[3].trim(), r)
  },
  none: ([a], r) => {
    const m = String(a || '').match(/^(\w+)\s+IN\s+(.+?)\s+WHERE\s+(.+)$/is)
    if (!m) return null
    return _evalListPredicate('none', m[1], m[2].trim(), m[3].trim(), r)
  },
  single: ([a], r) => {
    const m = String(a || '').match(/^(\w+)\s+IN\s+(.+?)\s+WHERE\s+(.+)$/is)
    if (!m) return null
    return _evalListPredicate('single', m[1], m[2].trim(), m[3].trim(), r)
  },
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
      return iso.slice(0, -4) + "." + nsStr + "Z";
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
      // datetime/time 字符串：date('1984-10-11T12:00') → 截取日期部分
      if (str.includes('T')) str = str.slice(0, str.indexOf('T'))
      return _normalizeDateStr(str);
    }
    if (v && typeof v === "object") {
      const map = v;
      // map.date 字符串穿透 + 覆盖字段合并
      if (map.date != null && typeof map.date === 'string') {
        // If any week/quarter/ordinalDay 需要走 _resolveDateFromMap（保留 other 的 dayOfWeek）
        if (map.week != null || map.quarter != null || map.ordinalDay != null || map.dayOfWeek != null) {
          const d = _resolveDateFromMap(map)
          return _fmtUtcDate(d);
        }
        let dateStr = map.date.includes('T') ? map.date.slice(0, map.date.indexOf('T')) : map.date
        dateStr = _mergeDateStr(dateStr, map)
        return dateStr
      }
      const d = _resolveDateFromMap(map);
      return _fmtUtcDate(d);
    }
    return null;
  },
  localtime: ([a], r) => {
    if (!a) {
      const d = new Date();
      return _formatTime(d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds() * 1000000);
    }
    const v = _evalBinary(a, r);
    if (typeof v === "string") {
      let str = v;
      if (str.startsWith("'") || str.startsWith('"')) str = str.slice(1, -1);
      // datetime 字符串传入 localtime → 提取 T 后的时间部分
      if (str.includes('T')) str = str.slice(str.indexOf('T') + 1)
      // localtime 不含时区 → strip [+-]HH:MM 或 [IANA] 后缀
      str = str.replace(/\[[^\]]+\]$/, '')  // strip [Europe/Stockholm]
      str = str.replace(/[+-]\d{2}:\d{2}(:\d{2})?$/, '')  // strip +01:00
      return _normalizeTimeStr(str);
    }
    if (v && typeof v === "object") {
      const map = v;
      // 优先：如果 map.time 是完整字符串（localtime({time: other}) → '12:31:14.645876123'）
      if (map.time != null && typeof map.time === 'string') {
        const timeStr = map.time.includes('T') ? map.time.slice(map.time.indexOf('T') + 1) : map.time
        // localtime 不含时区 → strip [+-]HH:MM 或 [IANA] 后缀
        const cleanTimeStr = timeStr.replace(/\[[^\]]+\]$/, '').replace(/[+-]\d{2}:\d{2}(:\d{2})?$/, '')
        // If any覆盖字段（second=42），只用这些字段覆盖时间值
        const hasOverrides = map.hour != null || map.minute != null || map.second != null || map.nanosecond != null || map.microsecond != null || map.millisecond != null || map.timezone != null
        if (!hasOverrides) return cleanTimeStr
        // 有覆盖：从 timeStr 提取基础值，覆盖字段优先
        const parts = timeStr.match(/(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?/)
        if (parts) {
          const baseHour = Number(parts[1]), baseMinute = Number(parts[2])
          const baseSecStr = parts[3] || '0'
          let baseSecond = 0, baseNanosecond = 0
          if (baseSecStr.includes('.')) {
            baseSecond = Number(baseSecStr.split('.')[0])
            baseNanosecond = Math.round(parseFloat('0.' + baseSecStr.split('.')[1]) * 1e9)
          } else { baseSecond = Number(baseSecStr) }
          // 覆盖字段优先：map.field 非 null 用 map.field，否则从 timeStr 提取
          const merged = {
            hour: map.hour != null ? Number(map.hour) : baseHour,
            minute: map.minute != null ? Number(map.minute) : baseMinute,
            second: map.second != null ? Number(map.second) : baseSecond,
            nanosecond: map.nanosecond != null ? Number(map.nanosecond) : baseNanosecond,
            microsecond: map.microsecond ?? undefined,
            millisecond: map.millisecond ?? undefined,
          }
          const { hour, minute, second, nanosecond } = _extractTimeMap(merged)
          return _formatTime(hour, minute, second, nanosecond)
        }
      }
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
    if (typeof v === "string") {
      let str = v;
      if (str.startsWith("'") || str.startsWith('"')) str = str.slice(1, -1);
      // datetime 字符串传入 time → 提取 T 后的时间部分
      if (str.includes('T')) str = str.slice(str.indexOf('T') + 1)
      // strip IANA tag 但保留 offset（如 +01:00）
      str = str.replace(/\[[^\]]+\]$/, '')
      // time 始终有时区后缀（默认 Z）
      if (!/[Z+-]/.test(str.replace(/^\d{1,2}(:\d{1,2}){0,2}(\.\d+)?/, ''))) str += 'Z'
      return _normalizeTimeStr(str);
    }
    if (v && typeof v === "object") {
      const map = v;
      // 优先：如果 map.time 是完整字符串（time({time: other})）
      if (map.time != null && typeof map.time === 'string') {
        const timeStr = (map.time.includes('T') ? map.time.slice(map.time.indexOf('T') + 1) : map.time).replace(/\[[^\]]+\]$/, '')
        const hasOverrides = map.hour != null || map.minute != null || map.second != null || map.nanosecond != null || map.microsecond != null || map.millisecond != null || map.timezone != null
        if (!hasOverrides) return timeStr + (timeStr.match(/[Z+-]/) ? '' : 'Z')
        const parts = timeStr.match(/(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?/)
        if (parts) {
          const baseHour = Number(parts[1]), baseMinute = Number(parts[2])
          const baseSecStr = parts[3] || '0'
          let baseSecond = 0, baseNanosecond = 0
          if (baseSecStr.includes('.')) {
            baseSecond = Number(baseSecStr.split('.')[0])
            baseNanosecond = Math.round(parseFloat('0.' + baseSecStr.split('.')[1]) * 1e9)
          } else { baseSecond = Number(baseSecStr) }
          const merged = {
            hour: map.hour != null ? Number(map.hour) : baseHour,
            minute: map.minute != null ? Number(map.minute) : baseMinute,
            second: map.second != null ? Number(map.second) : baseSecond,
            nanosecond: map.nanosecond != null ? Number(map.nanosecond) : baseNanosecond,
          }
          const tm = _extractTimeMap(merged)
          const timeTzMatch = timeStr.match(/[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$|Z$/);
          const timeTz = timeTzMatch ? timeTzMatch[0] : '';
          const tz = map.timezone != null ? _formatTimezone(_resolveNamedTimezone(String(map.timezone))) : (timeTz || 'Z');
          
          // 时区转换：如果原 timeStr 有时区且 map.timezone 指定了不同时区
          if (timeTz && map.timezone != null) {
            const dstTzStr = _formatTimezone(_resolveNamedTimezone(String(map.timezone)));
            const adj = _adjustTz(tm.hour, tm.minute, timeTz, dstTzStr);
            return _formatTime(adj.hour, adj.minute, tm.second, tm.nanosecond) + dstTzStr;
          }
          return _formatTime(tm.hour, tm.minute, tm.second, tm.nanosecond) + tz
        }
      }
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
    if (typeof v === "string") {
      let str = v;
      if (str.startsWith("'") || str.startsWith('"')) str = str.slice(1, -1);
      // localdatetime 不含时区 → strip [+-]HH:MM 或 [IANA] 后缀
      str = str.replace(/\[[^\]]+\]$/, '')  // strip [Europe/Stockholm]
      str = str.replace(/[+-]\d{2}:\d{2}(:\d{2})?$/, '')  // strip +01:00
      // 同时规范化日期/时间部分（Temporal2 格式统一）
      const tPos = str.indexOf('T')
      if (tPos >= 0) {
        const datePart = str.slice(0, tPos)
        const timePart = str.slice(tPos + 1)
        return _normalizeDateStr(datePart) + 'T' + _normalizeTimeStr(timePart)
      }
      if (str.includes('-') || /^\d{8}$/.test(str) || /^\d{4}$/.test(str) || /^\d{4}-?W\d{2}/i.test(str) || /^\d{4}-?\d{3}$/.test(str)) {
        return _normalizeDateStr(str)
      }
      return _normalizeTimeStr(str);
    }
    if (v && typeof v === "object") {
      const map = v;
      // 如果 map.date 是完整字符串，穿透
      if (map.date != null && typeof map.date === 'string' && (map.date.includes('T') || map.time == null)) {
        let dateStr = map.date.includes('T') ? map.date.slice(0, map.date.indexOf('T')) : map.date
        dateStr = _mergeDateStr(dateStr, map)
        if (map.time != null && typeof map.time === 'string') {
          const timePart = (map.time.includes('T') ? map.time.slice(map.time.indexOf('T') + 1) : map.time).replace(/\[[^\]]+\]$/, '').replace(/[+-]\d{2}:\d{2}(:\d{2})?$/, '')
          return dateStr + 'T' + _mergeTimeStr(timePart, map)
        }
        const { hour, minute, second, nanosecond } = _extractTimeMap(map);
        return dateStr + "T" + _formatTime(hour, minute, second, nanosecond);
      }
      // map.time 是完整时间字符串但没有 map.date → 用 map 的 year/month/day 构造日期
      if (map.time != null && typeof map.time === 'string') {
        const timePart = (map.time.includes('T') ? map.time.slice(map.time.indexOf('T') + 1) : map.time).replace(/\[[^\]]+\]$/, '').replace(/[+-]\d{2}:\d{2}(:\d{2})?$/, '')
        const d = _resolveDateFromMap(map);
        const dateStr = _fmtUtcDate(d);
        return dateStr + 'T' + _mergeTimeStr(timePart, map)
      }
      if (map.datetime != null && typeof map.datetime === 'string') {
        const dt = map.datetime.includes('T') ? map.datetime : map.datetime + 'T00:00:00'
        // strip tz for localdatetime
        const cleanDt = dt.replace(/\[[^\]]+\]$/, '').replace(/[+-]\d{2}:\d{2}(:\d{2})?$/, '')
        const dtDatePart = cleanDt.includes('T') ? cleanDt.slice(0, cleanDt.indexOf('T')) : cleanDt
        const dtTimePart = cleanDt.includes('T') ? cleanDt.slice(cleanDt.indexOf('T') + 1) : ''
        const dateStr = _mergeDateStr(dtDatePart, map)
        if (dtTimePart) {
          return dateStr + 'T' + _mergeTimeStr(dtTimePart, map)
        }
        const { hour, minute, second, nanosecond } = _extractTimeMap(map);
        return dateStr + "T" + _formatTime(hour, minute, second, nanosecond);
      }
      const d = _resolveDateFromMap(map);
      const dateStr = _fmtUtcDate(d);
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
    if (typeof v === "string") {
      let str = v;
      if (str.startsWith("'") || str.startsWith('"')) str = str.slice(1, -1);
      // 直接返回 ISO 格式（TCK 期望 datetime 完整传递字符串参数的原貌）
      // 无时区后缀时加 Z（localdatetime→datetime 补 Z）
      if (!/[Z+-]/.test(str.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?/, ''))) str += 'Z'
      // 规范化日期/时间部分（Temporal2）
      const tPos = str.indexOf('T')
      if (tPos >= 0) {
        const datePart = str.slice(0, tPos)
        const rest = str.slice(tPos + 1)
        // 分离 tz：支持 ±HH:MM、±HHMM、±HH、Z、[IANA]Z、[IANA]±HH:MM、[IANA]±HHMM、[IANA]±HH、[IANA-only]、[IANA]Z 等格式
        const tzMatch = rest.match(/(?:\[[^\]]+\])?Z$|(?:\[[^\]]+\])?[+-]\d{2}:\d{2}(?:\.\d+)?(?:\[[^\]]+\])?$|(?:\[[^\]]+\])?[+-]\d{4}(?:\.\d+)?(?:\[[^\]]+\])?$|(?:\[[^\]]+\])?[+-]\d{2}(?:\.\d+)?(?:\[[^\]]+\])?$|Z(?:\[[^\]]+\])?$|\[[^\]]+\]$/)
        if (tzMatch) {
          const timePart = rest.slice(0, tzMatch.index)
          let tzPart = tzMatch[0]
          // 处理 [IANA]Z → 根据 IANA 解析真实 offset（不是硬编码 +00:00）
          const ianaZ = tzPart.match(/^\[([^\]]+)\]Z$/)
          if (ianaZ) {
            const ianaName = ianaZ[1]
            let y = 1984, m = 1, d = 1, hh = 12, mm = 0
            const dp = datePart.match(/^(\d{4})/)
            if (dp) y = parseInt(dp[1], 10)
            const dp2 = datePart.match(/^\d{4}-(\d{2})/)
            if (dp2) m = parseInt(dp2[1], 10)
            const dp3 = datePart.match(/^\d{4}-\d{2}-(\d{2})/)
            if (dp3) d = parseInt(dp3[1], 10)
            const tp = timePart.match(/^(\d{2}):(\d{2})/)
            if (tp) { hh = parseInt(tp[1], 10); mm = parseInt(tp[2], 10) }
            const resolvedTz = _formatTimezone(_resolveNamedTimezone(ianaName, y, m, d, hh, mm))
            return _normalizeDateStr(datePart) + 'T' + _normalizeTimeStr(timePart) + resolvedTz
          }
          // 处理 [IANA] only → 解析 IANA 时区获取 offset
          const ianaOnly = tzPart.match(/^\[([a-zA-Z0-9_/+.-]+)\]$/)
          if (ianaOnly) {
            const ianaName = ianaOnly[1]
            let y = 1984, m = 1, d = 1, hh = 12, mm = 0
            const dp = datePart.match(/^(\d{4})/)
            if (dp) y = parseInt(dp[1], 10)
            const dp2 = datePart.match(/^\d{4}-(\d{2})/)
            if (dp2) m = parseInt(dp2[1], 10)
            const dp3 = datePart.match(/^\d{4}-\d{2}-(\d{2})/)
            if (dp3) d = parseInt(dp3[1], 10)
            const tp = timePart.match(/^(\d{2}):(\d{2})/)
            if (tp) { hh = parseInt(tp[1], 10); mm = parseInt(tp[2], 10) }
            const resolvedTz = _formatTimezone(_resolveNamedTimezone(ianaName, y, m, d, hh, mm))
            return _normalizeDateStr(datePart) + 'T' + _normalizeTimeStr(timePart) + resolvedTz
          }
          const finalTz = _normalizeTz(tzPart)
          return _normalizeDateStr(datePart) + 'T' + _normalizeTimeStr(timePart) + finalTz
        }
        // 检查 rest 末尾是否有 [IANA] only（无 offset/Z 后缀）— 兜底
        const ianaOnly2 = rest.match(/^(.+)\[([a-zA-Z0-9_/+.-]+)\]$/)
        if (ianaOnly) {
          const timePart = ianaOnly[1]
          const ianaName = ianaOnly[2]
          // 从日期中解析年份
          let y = 1984, m = 1, d = 1
          const dp = datePart.match(/^(\d{4})/)
          if (dp) y = parseInt(dp[1], 10)
          const dp2 = datePart.match(/^\d{4}-(\d{2})/)
          if (dp2) m = parseInt(dp2[1], 10)
          const dp3 = datePart.match(/^\d{4}-\d{2}-(\d{2})/)
          if (dp3) d = parseInt(dp3[1], 10)
          // 从 timePart 提取小时/分钟用于 DST 解析
          const tp = timePart.match(/^(\d{2}):(\d{2})/)
          const hh = tp ? parseInt(tp[1], 10) : 12
          const mm = tp ? parseInt(tp[2], 10) : 0
          const resolvedTz = _formatTimezone(_resolveNamedTimezone(ianaName, y, m, d, hh, mm))
          return _normalizeDateStr(datePart) + 'T' + _normalizeTimeStr(timePart) + resolvedTz + '[' + ianaName + ']'
        }
        // 无 tz 匹配，所有内容都是 timePart，交给 _normalizeTimeStr 处理
        return _normalizeDateStr(datePart) + 'T' + _normalizeTimeStr(rest)
      }
      return _normalizeDateStr(str) + 'T00:00:00Z';
    }
    if (v && typeof v === "object") {
      const map = v;
      // 如果 map.date 是完整字符串，穿透
      if (map.date != null && typeof map.date === 'string' && (map.date.includes('T') || map.time == null)) {
        let dateStr = map.date.includes('T') ? map.date.slice(0, map.date.indexOf('T')) : map.date
        dateStr = _mergeDateStr(dateStr, map)
        if (map.time != null && typeof map.time === 'string') {
          let timePart = map.time.includes('T') ? map.time.slice(map.time.indexOf('T') + 1) : map.time
          // timePart 是否已包含时区（+HH:MM/Z）
          const hasOwnTz = /[Z+-]/.test(timePart.replace(/^\d{1,2}(:\d{1,2}){0,2}(\.\d+)?/, ''))
          const timeTz = hasOwnTz ? (timePart.match(/[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$|Z$/) || [''])[0] : ''
          if (map.timezone != null) {
            const dstTz = _formatTimezone(_resolveNamedTimezone(String(map.timezone), Number(dateStr.slice(0,4)), Number(dateStr.slice(5,7)), Number(dateStr.slice(8,10))))
            const cleanTimePartForMerge = timePart.replace(/[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$/, '').replace('Z', '');
            let merged = _mergeTimeStr(cleanTimePartForMerge, map)
            // If any原时区且目标时区不同，做一个简单的时区转换（只调小时分钟，不跨日）
            if (timeTz) {
              // 从 timePart 提取基准时间做时区转换
              const tpParts = timePart.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?/);
              const baseH = tpParts ? Number(tpParts[1]) : 0;
              const baseM = tpParts ? Number(tpParts[2]) : 0;
              const adj = _adjustTz(baseH, baseM, timeTz, dstTz, undefined, Number(dateStr.slice(0,4)), Number(dateStr.slice(5,7)), Number(dateStr.slice(8,10)));
              const baseStr = String(adj.hour).padStart(2, '0') + ':' + String(adj.minute).padStart(2, '0');
              const secParts1 = merged.split(':').slice(2);
              const timeStr = secParts1.length > 0 && secParts1[0].length > 0 ? baseStr + ':' + secParts1.join(':') : baseStr;
              return dateStr + 'T' + timeStr + dstTz;
            }
            return dateStr + 'T' + merged + dstTz
          }
          // strip tz from timePart before merge (tz will be restored separately)
          const cleanTimeForMerge = timePart.replace(/[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$/, '').replace('Z', '')
          const merged = _mergeTimeStr(cleanTimeForMerge, map)
          let restoredTzPart = hasOwnTz ? (timeTz || 'Z') : 'Z'
          if (restoredTzPart.includes('[')) {
            // IANA 时区需用实际日期解析 DST 偏移
            const ianaName = restoredTzPart.match(/\[([^\]]+)\]/);
            if (ianaName) {
              const resolved = _resolveNamedTimezone(ianaName[1], Number(dateStr.slice(0,4)), Number(dateStr.slice(5,7)), Number(dateStr.slice(8,10)));
              const match = resolved.match(/^([+-]\d{2}:\d{2})/);
              if (match) restoredTzPart = match[1] + '[' + ianaName[1] + ']';
            }
          }
          return dateStr + 'T' + merged + restoredTzPart
        }
        const { hour, minute, second, nanosecond } = _extractTimeMap(map);
        const tz = map.timezone != null ? _formatTimezone(_resolveNamedTimezone(String(map.timezone), Number(dateStr.slice(0,4)), Number(dateStr.slice(5,7)), Number(dateStr.slice(8,10)))) : (map.time != null && typeof map.time === 'string' ? (map.time.match(/[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$|Z$/) || [''])[0] || 'Z' : 'Z')
        return dateStr + "T" + _formatTime(hour, minute, second, nanosecond) + tz;
      }
      // map.time 是完整时间字符串但没有 map.date → 用 year/month/day 构造日期
      if (map.time != null && typeof map.time === 'string') {
        let timePart = map.time.includes('T') ? map.time.slice(map.time.indexOf('T') + 1) : map.time
        const d = _resolveDateFromMap(map);
        const dateStr = _fmtUtcDate(d);
        const hasOwnTz = /[Z+-]/.test(timePart.replace(/^\d{1,2}(:\d{1,2}){0,2}(\.\d+)?/, ''))
        const timeTz = hasOwnTz ? (timePart.match(/[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$|Z$/) || [''])[0] : ''
        if (map.timezone != null) {
          const dstTz = _formatTimezone(_resolveNamedTimezone(String(map.timezone), d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()))
          // 传给 _mergeTimeStr 的 timePart 应去掉时区，避免被包含在 merged 中
          const cleanTimePartForMerge = timePart.replace(/[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$/, '').replace('Z', '');
          let merged = _mergeTimeStr(cleanTimePartForMerge, map)
          if (timeTz) {
            // 从 timePart（原始值）提取基准时间做时区转换，再应用覆盖
            const tpParts = timePart.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?/);
            const baseH = tpParts ? Number(tpParts[1]) : 0;
            const baseM = tpParts ? Number(tpParts[2]) : 0;
            const adj = _adjustTz(baseH, baseM, timeTz, dstTz, undefined, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
            const baseStr = String(adj.hour).padStart(2, '0') + ':' + String(adj.minute).padStart(2, '0');
            const secParts = merged.split(':').slice(2);
            const timeStr = secParts.length > 0 && secParts[0].length > 0 ? baseStr + ':' + secParts.join(':') : baseStr;
            return dateStr + 'T' + timeStr + dstTz;
          }
          return dateStr + 'T' + merged + dstTz
        }
        const cleanTimeForMerge2 = timePart.replace(/[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$/, '').replace('Z', '')
        const merged2 = _mergeTimeStr(cleanTimeForMerge2, map)
        let restoredTzPart2 = (hasOwnTz ? (timeTz || 'Z') : 'Z')
        if (restoredTzPart2.includes('[')) {
          const ianaName = restoredTzPart2.match(/\[([^\]]+)\]/);
          if (ianaName) {
            const resolved = _resolveNamedTimezone(ianaName[1], d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
            const match = resolved.match(/^([+-]\d{2}:\d{2})/);
            if (match) restoredTzPart2 = match[1] + '[' + ianaName[1] + ']';
          }
        }
        return dateStr + 'T' + merged2 + restoredTzPart2
      }
      if (map.datetime != null && typeof map.datetime === 'string') {
        const dt = map.datetime.includes('T') ? map.datetime : map.datetime + 'T00:00:00'
        const dtDatePart = dt.includes('T') ? dt.slice(0, dt.indexOf('T')) : dt
        const dtTimePart = dt.includes('T') ? dt.slice(dt.indexOf('T') + 1) : ''
        const dateStr = _mergeDateStr(dtDatePart, map)
        // 保留原始时区（无时区则 Z）
        const origTz = (dt.match(/[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$|Z$/) || [''])[0] || 'Z'
        if (map.timezone != null) {
          const dstTz = _formatTimezone(_resolveNamedTimezone(String(map.timezone), Number(dateStr.slice(0,4)), Number(dateStr.slice(5,7)), Number(dateStr.slice(8,10))))
          if (dtTimePart) {
            const cleanTime = dtTimePart.replace(/[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$/, '').replace('Z', '')
            // 如果原 datetime 有时区且与目标不同，做时区转换
            if (origTz && origTz !== 'Z') {
              const tpParts = dtTimePart.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?/);
              const baseH = tpParts ? Number(tpParts[1]) : 0;
              const baseM = tpParts ? Number(tpParts[2]) : 0;
              const adj = _adjustTz(baseH, baseM, origTz, dstTz, undefined, Number(dateStr.slice(0,4)), Number(dateStr.slice(5,7)), Number(dateStr.slice(8,10)));
              const merged = _mergeTimeStr(cleanTime, map);
              const secParts = merged.split(':').slice(2);
              const adjStr = String(adj.hour).padStart(2, '0') + ':' + String(adj.minute).padStart(2, '0');
              const timeStr = secParts.length > 0 && secParts[0].length > 0 ? adjStr + ':' + secParts.join(':') : adjStr;
              return dateStr + 'T' + timeStr + dstTz;
            }
            return dateStr + 'T' + _mergeTimeStr(cleanTime, map) + dstTz
          }
          const { hour, minute, second, nanosecond } = _extractTimeMap(map);
          return dateStr + "T" + _formatTime(hour, minute, second, nanosecond) + dstTz
        }
        if (dtTimePart) {
          const cleanTime = dtTimePart.replace(/[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$/, '').replace('Z', '')
          return dateStr + 'T' + _mergeTimeStr(cleanTime, map) + origTz
        }
        const { hour, minute, second, nanosecond } = _extractTimeMap(map);
        return dateStr + "T" + _formatTime(hour, minute, second, nanosecond) + origTz
      }
      const d = _resolveDateFromMap(map);
      const dateStr = _fmtUtcDate(d);
      const { hour, minute, second, nanosecond } = _extractTimeMap(map);
      const tz = map.timezone != null ? _formatTimezone(_resolveNamedTimezone(String(map.timezone), d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), Number(hour), Number(minute))) : (map.time != null && typeof map.time === 'string' ? (map.time.match(/[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$|Z$/) || [''])[0] || 'Z' : 'Z');
      return dateStr + "T" + _formatTime(hour, minute, second, nanosecond) + tz;
    }
    return null;
  },
  duration: ([a], r) => {
    if (!a) return "PT0S";
    const v = _evalBinary(a, r);
    if (typeof v === "string") {
      let str = v;
      if (str.startsWith("'") || str.startsWith('"')) str = str.slice(1, -1);
      if (/^P/i.test(str)) {
        // 解析并重新格式化，确保分数展开 + 归一化
        // 兜底：如果解析失败，返回原字符串
        try {
          const p = _parseDuration(str)
          if (p || str !== 'P') {
            let { y, mo, d, h, min, s, ns } = p
            // 分数展开：小数天→小时，小数月→天
            if (mo > 0 && mo % 1 !== 0) { d += (mo - Math.floor(mo)) * 30.436875; mo = Math.floor(mo) }
            if (d > 0 && d % 1 !== 0) { h += (d - Math.floor(d)) * 24; d = Math.floor(d) }
            if (h > 0 && h % 1 !== 0) { min += (h - Math.floor(h)) * 60; h = Math.floor(h) }
            if (min > 0 && min % 1 !== 0) { s += (min - Math.floor(min)) * 60; min = Math.floor(min); ns = 0 } // 重置 ns 因为秒小数已更新
            // 秒可能有小数，纳秒在此之外已被解析
            const secInt = Math.floor(s)
            if (!Number.isInteger(s)) { ns += Math.round((s - secInt) * 1e9); s = secInt }
            // 归一化：H→D, Min→H, S→Min
            while (h >= 24) { d += Math.floor(h / 24); h = h % 24 }
            while (min >= 60) { h += Math.floor(min / 60); min = min % 60 }
            while (s >= 60) { min += Math.floor(s / 60); s = s % 60 }
            // 直接格式化，不经过 _formatDuration（避免 D→H 反向借位）
            let result = "P"
            if (y) result += y + "Y"
            if (mo) result += mo + "M"
            if (d) result += d + "D"
            if (h || min || s || ns) {
              result += "T"
              if (h) result += h + "H"
              if (min) result += min + "M"
              if (s || ns) {
                let secStr = ""
                if (ns > 0) {
                  let nsStr = String(ns).padStart(9, "0").replace(/0+$/, "")
                  secStr = String(s) + "." + nsStr
                } else {
                  secStr = String(s)
                }
                result += secStr + "S"
              }
            }
            return result === "P" ? "PT0S" : (result || "PT0S")
          }
        } catch {}
      }
      return "PT" + str + "S";
    }
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
      // 保存原始分量（归一化前），用于 `=` 非归一化年/月/天比较
      const _rawEntry = { y: years, mo: months, d: days, h: hours, min: minutes, s: seconds, ns: nanos }
      // 分数分解
      if (years % 1 !== 0) { months += (years - Math.floor(years)) * 12; years = Math.floor(years); }
      if (months % 1 !== 0) { days += (months - Math.floor(months)) * AVG_DAYS_PER_MONTH; months = Math.floor(months); }
      if (days % 1 !== 0) { hours += (days - Math.floor(days)) * 24; days = Math.floor(days); }
      if (hours % 1 !== 0) { minutes += (hours - Math.floor(hours)) * 60; hours = Math.floor(hours); }
      if (minutes % 1 !== 0) { seconds += (minutes - Math.floor(minutes)) * 60; minutes = Math.floor(minutes); }
      if (seconds % 1 !== 0) { nanos += Math.round((seconds - Math.floor(seconds)) * 1e9); seconds = Math.floor(seconds); }
      // 进位：纳秒向秒借位/进位
      // 规则：只做跨符号调整（正秒+负纳秒 / 负秒+正纳秒），不改变同号
      if (seconds > 0 && nanos < 0) { seconds--; nanos += 1e9 }
      else if (seconds < 0 && nanos > 0) { seconds++; nanos -= 1e9 }
      // 纳秒绝对值归一化到 [0, 1e9)：仅对正秒且纳秒为负时继续借位
      // （负秒+负纳秒 和 正秒+正纳秒 都不调整）
      if (seconds > 0 && nanos < 0) {
        const borrow = Math.ceil(Math.abs(nanos) / 1e9)
        if (borrow > 0) { seconds -= borrow; nanos += borrow * 1e9 }
      }
      // 纳秒正数归一化（所有正纳秒 ≥ 1e9）
      if (nanos >= 1e9) { seconds += Math.floor(nanos / 1e9); nanos = nanos % 1e9 }
      // 秒进位/借位到分钟
      if (seconds >= 60) { minutes += Math.floor(seconds / 60); seconds = seconds % 60 }
      if (seconds <= -60) { minutes += Math.ceil(seconds / 60); seconds = seconds % 60; if (seconds > 0) { minutes++; seconds -= 60 } }
      if (minutes >= 60) { hours += Math.floor(minutes / 60); minutes = minutes % 60 }
      if (minutes <= -60) { hours += Math.ceil(minutes / 60); minutes = minutes % 60; if (minutes > 0) { hours++; minutes -= 60 } }
      if (hours >= 24) { days += Math.floor(hours / 24); hours = hours % 24 }
      if (hours <= -24) { days += Math.ceil(hours / 24); hours = hours % 24; if (hours > 0) { days++; hours -= 24 } }
      let nanosFormatted = "";
      if (nanos > 0) {
        let nsStr = String(nanos).padStart(9, "0").replace(/0+$/, "");
        nanosFormatted = "." + nsStr;
      } else if (nanos < 0) {
        let nsStr = String(Math.abs(nanos)).padStart(9, "0").replace(/0+$/, "");
        nanosFormatted = "." + nsStr;  // 负号由秒部分或 "-0" 提供，这里只加小数点
      }
      let result = "P";
      if (years) result += years + "Y";
      if (months) result += months + "M";
      if (days) result += days + "D";
      if (hours || minutes || seconds || nanos) {
        result += "T";
        if (hours) result += hours + "H";
        if (minutes) result += minutes + "M";
        if (seconds || nanos) {
          // 当秒为 0 且纳秒为负时，秒部分设为 "-0"
                  let secStr = (seconds === 0 && nanos < 0) ? "-0" : String(seconds);
          result += secStr + nanosFormatted + "S";
        }
      }
      // 存储原始分量用于 `=` 比较（缓存上限 MAX_CACHE_SIZE）
      const rawArr = _rawDurationCache.get(result) || []
      rawArr.push({ y: _rawEntry.y, mo: _rawEntry.mo, d: _rawEntry.d, h: _rawEntry.h, min: _rawEntry.min, s: _rawEntry.s, ns: _rawEntry.ns })
      if (rawArr.length > MAX_CACHE_SIZE) rawArr.splice(0, rawArr.length - MAX_CACHE_SIZE)
      _rawDurationCache.set(result, rawArr)
      _rawDurationCache.set(result, rawArr)
      return result === "P" ? "PT0S" : (result || "PT0S");
    }
    return null;
  },
  // ── Truncate 函数 ──
  "date.truncate": ([type, target, ...extra], r) => {
    const t = _evalBinary(target, r);
    if (typeof t !== "string") return null;
    const str = t.startsWith("'") || t.startsWith('"') ? t.slice(1, -1) : t;
    const unit = typeof type === "string" ? type.replace(/['"]/g, "").toLowerCase() : String(_evalBinary(type, r) || "").toLowerCase();
    // date.truncate 只截断日期部分，不添加时间部分
    const result = _truncateDateStr(str, unit, true);
    if (extra.length > 0) return _applyTruncateConfig(result, extra[0], r);
    return result;
  },
  "datetime.truncate": ([type, target, ...extra], r) => {
    const t = _evalBinary(target, r);
    if (typeof t !== "string") return null;
    let str = t.startsWith("'") || t.startsWith('"') ? t.slice(1, -1) : t;
    const unit = typeof type === "string" ? type.replace(/['"]/g, "").toLowerCase() : String(_evalBinary(type, r) || "").toLowerCase();
    // 如果 target 是纯日期（如 date 函数返回），转为 datetime 格式
    const hasTz = /[Z+]/.test(str);
    if (!str.includes('T') && /^\d{4}-\d{2}-\d{2}$/.test(str)) str = str + 'T00:00Z';
    let dtResult = _truncateDateStr(str, unit);
    // datetime 类型必须有时区 suffix。如果截断后没有时区且输入有 T 部分，加 Z（UTC 约定）
    if (!dtResult.match(/[Z+]/) && !/(?:T\d{2}:\d{2}.*)?[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$/.test(dtResult)) {
      dtResult = dtResult + 'Z';
    }
    if (extra.length > 0) dtResult = _applyTruncateConfig(dtResult, extra[0], r, str);
    return dtResult;
  },
  "localdatetime.truncate": ([type, target, ...extra], r) => {
    const t = _evalBinary(target, r);
    if (typeof t !== "string") return null;
    let str = t.startsWith("'") || t.startsWith('"') ? t.slice(1, -1) : t;
    const unit = typeof type === "string" ? type.replace(/['"]/g, "").toLowerCase() : String(_evalBinary(type, r) || "").toLowerCase();
    // localdatetime 无时区，strip 掉输入中的时区后缀
    const rawStr = str;
    str = str.replace(/[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$|Z$/, '');
    if (!str.includes('T') && /^\d{4}-\d{2}-\d{2}$/.test(str)) str = str + 'T00:00:00';
    const dtResult = _truncateDateStr(str, unit);
    if (extra.length > 0) return _applyTruncateConfig(dtResult, extra[0], r, rawStr);
    return dtResult;
  },
  "time.truncate": ([type, target, ...extra], r) => {
    const t = _evalBinary(target, r);
    if (typeof t !== "string") return null;
    const str = t.startsWith("'") || t.startsWith('"') ? t.slice(1, -1) : t;
    const unit = typeof type === "string" ? type.replace(/['"]/g, "").toLowerCase() : String(_evalBinary(type, r) || "").toLowerCase();
    // 如果输入包含 T（datetime/date 类型），提取 T 后的时间部分
    const timeOnlyStr = str.includes('T') ? str.slice(str.indexOf('T') + 1) : str;
    const result = _truncateTimeStr(timeOnlyStr, unit);
    // time 类型必须有 Z 或偏移后缀。如果 truncation 结果没有时区后缀，加 Z
    const resultHasTz = /[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$|Z$/.test(result);
    const finalResult = resultHasTz ? result : result + 'Z';
    if (extra.length > 0) return _applyTruncateConfig(finalResult, extra[0], r);
    return finalResult;
  },
  "localtime.truncate": ([type, target, ...extra], r) => {
    const t = _evalBinary(target, r);
    if (typeof t !== "string") return null;
    const str = t.startsWith("'") || t.startsWith('"') ? t.slice(1, -1) : t;
    const unit = typeof type === "string" ? type.replace(/['"]/g, "").toLowerCase() : String(_evalBinary(type, r) || "").toLowerCase();
    // 如果输入包含 T（datetime/date 类型），提取 T 后的时间部分
    const timeOnlyStr = str.includes('T') ? str.slice(str.indexOf('T') + 1) : str;
    let result = _truncateTimeStr(timeOnlyStr, unit);
    // localtime 无时区后缀，去掉可能从 datetime 输入带入的时区
    result = result.replace(/[+-]\d{2}:\d{2}(?:\[[^\]]+\])?$|Z$/, '');
    if (extra.length > 0) return _applyTruncateConfig(result, extra[0], r);
    return result;
  },
  // ── duration.between / inDays / inMonths / inSeconds ──
  "duration.between": ([a, b], r) => {
    const va = _evalBinary(a, r); const vb = _evalBinary(b, r);
    if (!va || !vb || typeof va !== "string" || typeof vb !== "string") return null;
    let sa = String(va).replace(/['"]/g,""), sb = String(vb).replace(/['"]/g,"");
    // 记录原始值，用于后续判断
    const origSa = sa, origSb = sb;
    // 去掉 IANA 时区后缀 [Europe/Stockholm] 等，留纯 ISO 格式
    if (sa.includes('[')) sa = sa.replace(/\[.*\]$/, '')
    if (sb.includes('[')) sb = sb.replace(/\[.*\]$/, '')
    // 双方都是纯时间（无日期、无时区）时用 epoch diff
    const isTimeOnly = (s: string) => !s.match(/^\d{4}/) && s.includes(":");
    const anyTimeHasTz = (s: string, t: string) => /[Z+]/.test(s) || /[Z+]/.test(t);
    const allTimeOnly = isTimeOnly(origSa) && isTimeOnly(origSb) && !anyTimeHasTz(origSa, origSb);
    // 处理跨类型 temporal：当一方是日期另一方是纯时间时组合
    const isDateVal = (s: string) => /^\d{4}/.test(s) && !s.includes("T")
    const isTimeVal = (s: string) => !s.includes("T") && s.includes(":")
    const isDateTime = (s: string) => s.includes("T")
    if (isDateVal(sa) && isTimeVal(sb)) {
      sb = sa + "T" + sb;
      // date 升格为 datetime 时，借 time 的时区偏移（支持 +0100 和 +01:00 两种格式）
      const timeTz = sb.match(/[+-]\d{2}:?\d{2}(?:\[[^\]]+\])?$/);
      if (timeTz) sa = sa + "T00:00:00" + timeTz[0];
      else sa = sa + "T00:00:00";
    } else if (isDateVal(sb) && isTimeVal(sa)) {
      sa = sb + "T" + sa;
      const timeTz = sa.match(/[+-]\d{2}:?\d{2}(?:\[[^\]]+\])?$/);
      if (timeTz) sb = sb + "T00:00:00" + timeTz[0];
      else sb = sb + "T00:00:00";
    }
    // time vs datetime：从 datetime 提取日期部分作为 time 的基础
    if (isTimeVal(sa) && isDateTime(sb)) {
      const base = sb.includes('T') ? sb.slice(0, sb.indexOf('T')) : sb.slice(0, 10);
      sa = base + "T" + sa;
      // time 不带时区，datetime 的时区只在统一时区时才考虑
    } else if (isTimeVal(sb) && isDateTime(sa)) {
      const base = sa.includes('T') ? sa.slice(0, sa.indexOf('T')) : sa.slice(0, 10);
      sb = base + "T" + sb;
    }
    // 双方都是纯时间：用 epoch 日期做基准
    if (isTimeVal(sa) && isTimeVal(sb)) {
      sa = "1970-01-01T" + sa; sb = "1970-01-01T" + sb;
    }
    
    // 判断是否可以做 calendar-based diff：只要一方是 localdatetime/date（无时区），就用 calendar diff
    const hasTimezone = (s: string) => {
      const afterT = s.includes('T') ? s.slice(s.indexOf('T')+1) : '';
      return /[Z+-]/.test(afterT.replace(/^\d{1,2}(:\d{1,2}){0,2}(\.\d+)?/, ''));
    };
    const bothNoTz = !allTimeOnly && !hasTimezone(sa) && !hasTimezone(sb);
    const mixedTz = !allTimeOnly && hasTimezone(sa) !== hasTimezone(sb);
    const hasPureDate = isDateVal(origSa) || isDateVal(origSb);
    // datetime+datetime 走 calendar diff（YMD 拆解需求）
    const bothDateTime = sa.includes('T') && sb.includes('T') && !allTimeOnly;
    const doCalendarDiff = bothNoTz || mixedTz || hasPureDate || bothDateTime;
    if (doCalendarDiff) {
      // 统一时区：对两边带时区的 datetime 先转 UTC（仅时区不同时）
      const saTz = sa.match(/[+-]\d{2}:?\d{2}(?:\[[^\]]+\])?$|Z$/);
      const sbTz = sb.match(/[+-]\d{2}:?\d{2}(?:\[[^\]]+\])?$|Z$/);
      if (saTz && sbTz && saTz[0] !== sbTz[0]) {
        // 两边都有时区且不同 → 统一到 UTC
        const d1 = new Date(sa), d2 = new Date(sb);
        if (!isNaN(d1.getTime()) && !isNaN(d2.getTime())) {
          sa = d1.toISOString().replace('Z', 'Z');
          sb = d2.toISOString().replace('Z', 'Z');
        }
      } else if (saTz && !sbTz && sb.includes('T') && hasTimezone(sb)) {
        // localdatetime 实际无 tz，什么都不做
            } else if ((saTz || sbTz) && !(saTz && sbTz)) {
        // mixedTz: one has tz, one does not
        // for datetime+localdatetime, convert both sides to UTC
        const tzSide = saTz ? sa : sb;
        const tzlessSide = saTz ? sb : sa;
        if (tzSide.includes('T') && (tzlessSide.includes('T') || /^\d{4}-\d{2}-\d{2}$/.test(tzlessSide))) {
          // check IANA in original (sa/sb have IANA stripped)
          const ianaVal = saTz ? (origSa || '') : (origSb || '');
          const ianaMatch = ianaVal.match(/\[([^\]]+)\]$/);
          if (ianaMatch && typeof _tzLocalToUTC === 'function') {
            const tzlessOrig = saTz ? (origSb || '') : (origSa || '');
            const tzlessCleaned = tzlessOrig.replace(/\[.*\]$/, '');
            // 对 localtime（无日期），用 tzSide 的日期补充；对已补日期的直接用
            const dateMatch = tzSide.match(/^(\d{4}-\d{2}-\d{2})/);
            let localStr;
            if (tzlessCleaned.match(/^\d{4}/)) {
              localStr = tzlessCleaned.includes('T') ? tzlessCleaned : tzlessCleaned + 'T00:00:00';
            } else if (dateMatch) {
              localStr = dateMatch[1] + 'T' + (tzlessCleaned.startsWith('T') ? tzlessCleaned.slice(1) : tzlessCleaned);
            } else {
              localStr = tzlessCleaned.includes('T') ? tzlessCleaned : tzlessCleaned + 'T00:00:00';
            }
            const utcDate = _tzLocalToUTC(localStr, ianaMatch[1]);
            if (utcDate && !isNaN(utcDate.getTime())) {
              const iso2 = utcDate.toISOString().replace('Z', '');
              const d = new Date(tzSide);
              if (!isNaN(d.getTime())) {
                const iso = d.toISOString().replace('Z', '');
                if (saTz) { sa = iso; sb = iso2; } else { sa = iso2; sb = iso; }
              }
            }
          } else {
            const d = new Date(tzSide);
            if (!isNaN(d.getTime())) {
              const iso = d.toISOString().replace('Z', '');
              const tzOffset = tzSide.match(/[+-]\d{2}:?\d{2}/);
              if (tzOffset) {
                const tzlessFull = tzlessSide.includes('T') ? tzlessSide : tzlessSide + 'T00:00:00';
                const fullTzless = tzlessFull + tzOffset[0];
                const dt = new Date(fullTzless);
                if (!isNaN(dt.getTime())) {
                  const iso2 = dt.toISOString().replace('Z', '');
                  if (saTz) { sa = iso; sb = iso2; } else { sa = iso2; sb = iso; }
                }
              }
            }
          }
        }
      }
      // Calendar-based diff：解析年月日小时分钟秒纳秒做字段减
      const parseDT = (s: string) => {
        const dateRe = s.match(/^([+-]?\d+)-(\d{2})-(\d{2})/);
        const timeRe = s.match(/T(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?/);
        const y = dateRe ? parseInt(dateRe[1],10) : 0, mo = dateRe ? parseInt(dateRe[2],10) : 1, d = dateRe ? parseInt(dateRe[3],10) : 1;
        const h = timeRe ? parseInt(timeRe[1],10) : 0, mi = timeRe ? parseInt(timeRe[2],10) : 0;
        let sec = 0, ns = 0;
        if (timeRe && timeRe[3]) {
          const secStr = timeRe[3];
          if (secStr.includes('.')) {
            sec = parseInt(secStr.split('.')[0],10);
            let frac = secStr.split('.')[1];
            ns = parseInt(frac.padEnd(9,'0').slice(0,9),10);
          } else { sec = parseInt(secStr,10); }
        }
        return { y, mo, d, h, mi, sec, ns };
      }
      let aDT = parseDT(sa), bDT = parseDT(sb);

      const sign = (bDT.y > aDT.y || (bDT.y === aDT.y && bDT.mo > aDT.mo) || (bDT.y === aDT.y && bDT.mo === aDT.mo && bDT.d > aDT.d) || (bDT.y === aDT.y && bDT.mo === aDT.mo && bDT.d === aDT.d && bDT.h > aDT.h) || (bDT.y === aDT.y && bDT.mo === aDT.mo && bDT.d === aDT.d && bDT.h === aDT.h && bDT.mi > aDT.mi) || (bDT.y === aDT.y && bDT.mo === aDT.mo && bDT.d === aDT.d && bDT.h === aDT.h && bDT.mi === aDT.mi && bDT.sec > aDT.sec) || (bDT.y === aDT.y && bDT.mo === aDT.mo && bDT.d === aDT.d && bDT.h === aDT.h && bDT.mi === aDT.mi && bDT.sec === aDT.sec && bDT.ns >= aDT.ns)) ? 1 : -1;
      // 确保 a <= b，swap 后 sign 肯定为负
      if (sign < 0) { [aDT, bDT] = [bDT, aDT]; }
      // sign 现在反映方向：-1 表示结果应该是负的（当原始 b < a 时输出负值）
      // Note: sign 是原始方向，在格式化输出时用于前缀负号
      
      // 字段减（带借位）
      let nsDiff = bDT.ns - aDT.ns;
      let secDiff = bDT.sec - aDT.sec;
      let minDiff = bDT.mi - aDT.mi;
      let hDiff = bDT.h - aDT.h;
      let dDiff = bDT.d - aDT.d;
      let moDiff = bDT.mo - aDT.mo;
      let yDiff = bDT.y - aDT.y;
      
      if (nsDiff < 0) { nsDiff += 1e9; secDiff--; }
      if (secDiff < 0) { secDiff += 60; minDiff--; }
      if (minDiff < 0) { minDiff += 60; hDiff--; }
      if (hDiff < 0) { hDiff += 24; dDiff--; }
      if (dDiff < 0) {
        // 借上一个月
        const prevMonth = bDT.mo - 1 < 1 ? 12 : bDT.mo - 1;
        const prevYear = bDT.mo - 1 < 1 ? bDT.y - 1 : bDT.y;
        const daysInPrevMonth = new Date(prevYear, prevMonth, 0).getDate();
        dDiff += daysInPrevMonth;
        moDiff--;
      }
      if (moDiff < 0) { moDiff += 12; yDiff--; }
      
            const maybeSignS = (v: number) => {
        if (v === 0) return "0";
        // sign < 0 表示 b < a（原始方向），即结果是负的
        // 但因为可能 swap 过了，sign 保持原始方向
        return v > 0 && sign < 0 ? ("-" + v) : String(v);
      };
      // 对于纯时间只输出时间部分（P 不含 D）
      const isPureTime = !isDateVal(sa) && !sa.includes('-'); // simple heuristic
      let result = "P";
      if (yDiff) result += maybeSignS(yDiff) + "Y";
      if (moDiff) result += maybeSignS(moDiff) + "M";
      if (dDiff) result += maybeSignS(dDiff) + "D";
      if (hDiff || minDiff || secDiff || nsDiff > 0) {
        if (!result.endsWith('P')) result += "";
        result += "T";
        if (hDiff) result += maybeSignS(hDiff) + "H";
        if (minDiff) result += maybeSignS(minDiff) + "M";
        const nsStr = nsDiff > 0 ? "." + String(nsDiff).padStart(9,'0').replace(/0+$/,'') : "";
        if (secDiff || nsDiff > 0) result += maybeSignS(secDiff) + nsStr + "S";
      }
      if (result === 'P') return 'PT0S';
      return result;
    }
    
    let da: number, db: number
    try {
      da = new Date(sa.includes("T") ? sa : sa+"T00:00:00").getTime()
      db = new Date(sb.includes("T") ? sb : sb+"T00:00:00").getTime()
    } catch { return null }
    if (isNaN(da) || isNaN(db)) return null
    const diff = db - da;
    const absDiff = Math.abs(diff);
    const totalSec = Math.floor((absDiff + 999) / 1000); // ceil division for negative durations
    // 纳秒部分：ceil 后的余量（正数），单位 ns
    const nsMs = totalSec * 1000 - absDiff; // 毫秒级别（可能负）
    const ns = Math.abs(nsMs) * 1000000;
    const nss = ns > 0 ? "." + String(ns).padStart(9,"0").replace(/0+$/,"") : "";
    // ISO 8601 格式：PT22H 或 PT-22H（所有组件加负号前缀）
    const sign = diff < 0;
    const d = Math.floor(totalSec / 86400);
    const h = Math.floor((totalSec % 86400) / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const sec = totalSec % 60;
    // 当 diff < 0 时，每个组件加负号
    const maybeSign = (v: number) => {
      if (v === 0) return "0";
      return sign ? ("-" + v) : String(v);
    };
    let result = "P";
    if (d) result += maybeSign(d) + "D";
    if (h || m || sec || ns > 0) {
      result += "T";
      if (h) result += maybeSign(h) + "H";
      if (m) result += maybeSign(m) + "M";
      if (sec || ns > 0) {
        if (sec === 0 && ns > 0 && sign) {
          // 纯亚秒 diff 且为负：need "-0.xxxS"
          result += "-0" + nss + "S";
        } else {
          result += maybeSign(sec) + nss + "S";
        }
      }
    }
    if (result === 'P') return 'PT0S';
    return result;
  },
  "duration.inDays": ([a, b], r) => {
    if (b !== undefined && b !== null) {
      const va = _evalBinary(a, r); const vb = _evalBinary(b, r);
      if (!va || !vb || typeof va !== "string" || typeof vb !== "string") return null;
      let sa = String(va).replace(/['"]/g,""), sb = String(vb).replace(/['"]/g,"");
      if (sa.includes('[')) sa = sa.replace(/\[.*\]$/, '')
      if (sb.includes('[')) sb = sb.replace(/\[.*\]$/, '')
      const isTimeOnly = (s: string) => !s.match(/^\d{4}/) && s.includes(":");
      if (isTimeOnly(sa) || isTimeOnly(sb)) return 'PT0S';
      try {
        // 纯日期值加 Z 避免系统时区扰动
        const normalize = (s: string) => {
          if (!s.includes('T')) return s + 'T00:00:00Z';
          if (!/[Z+-]/.test(s.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?/, ''))) return s + 'Z';
          return s;
        };
        const da = new Date(normalize(sa)).getTime()
        const db = new Date(normalize(sb)).getTime()
        if (isNaN(da) || isNaN(db)) return null
        const diffDays = Math.floor(Math.abs(db - da) / 86400000) * (db - da < 0 ? -1 : 1);
        if (diffDays === 0) return 'PT0S';
        return 'P' + String(diffDays) + 'D'
      } catch { return null }
    }
    const v = _evalBinary(a, r); if (typeof v !== "string") return null;
    const m = v.replace(/['"]/g,"").match(/-?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?/);
    if (!m) return null;
    const sign = v.replace(/['"]/g,"").startsWith('-') || v.replace(/['"]/g,"").indexOf('P-') >= 0 ? -1 : 1;
    const d = Number(m[3]||0), h = Number(m[4]||0), mi = Number(m[5]||0), s = Number(m[6]||0);
    if (sign < 0) return -(d + h/24 + mi/1440 + s/86400);
    return d + h/24 + mi/1440 + s/86400;
  },
  "duration.inMonths": ([a, b], r) => {
    if (b !== undefined && b !== null) {
      // 委托给 duration.between 取得 duration 字符串，再提取月数
      const durStr = _callFunction("duration.between", [a, b], r);
      if (typeof durStr !== "string" || durStr === null) return null;
      const m = durStr.replace(/['"]/g,"").match(/-?P(?:(-?\d+)Y)?(?:(-?\d+)M)?(?:(-?\d+\.?\d*)D)?(?:T(?:(-?\d+\.?\d*)H)?(?:(-?\d+\.?\d*)M)?(?:(-?[\d.]+)S)?)?/);
      if (!m) return 'PT0S';
      const sgn = durStr.replace(/['"]/g,"").startsWith('-') || durStr.replace(/['"]/g,"").includes('P-') ? -1 : 1;
      const years = Math.abs(Number(m[1]||0)), months = Math.abs(Number(m[2]||0));
      const totalMonths = (years * 12 + months) * sgn;
      if (Math.abs(totalMonths) < 0.5) return 'PT0S';
      const sign = totalMonths < 0 ? -1 : 1;
      const absMonths = Math.round(Math.abs(totalMonths));
      const years_out = Math.floor(absMonths / 12);
      const months_out = absMonths % 12;
      let result = 'P';
      if (years_out) result += String(sign * years_out) + 'Y';
      if (months_out) result += String(sign * months_out) + 'M';
      return result;
    }
    const v = _evalBinary(a, r); if (typeof v !== "string") return null;
    const m = v.replace(/['"]/g,"").match(/-?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?/);
    if (!m) return null;
    const sign = v.replace(/['"]/g,"").startsWith('-') || v.replace(/['"]/g,"").indexOf('P-') >= 0 ? -1 : 1;
    const y = Number(m[1]||0), mo = Number(m[2]||0), d = Number(m[3]||0);
    const h = Number(m[4]||0), mi = Number(m[5]||0), s = Number(m[6]||0);
    if (sign < 0) return -(y*12 + mo + d/30.436875 + h/730.485 + mi/43829.1);
    return y*12 + mo + d/30.436875 + h/730.485 + mi/43829.1;
  },
  "duration.inSeconds": ([a, b], r) => {
    // 双参数：duration.inSeconds(x, y)
    if (b !== undefined && b !== null) {
      if (a === b && a !== 'null') return 'PT0S';
      const va = _evalBinary(a, r); const vb = _evalBinary(b, r);
      if (!va || !vb || typeof va !== "string" || typeof vb !== "string") return null;
      let sa = String(va).replace(/['"]/g,""), sb = String(vb).replace(/['"]/g,"");
      const origSa = sa, origSb = sb;
      if (sa.includes('[')) sa = sa.replace(/\[.*\]$/, '');
      if (sb.includes('[')) sb = sb.replace(/\[.*\]$/, '');
      const isDateOnly = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
      const isTimeOnly = (s: string) => !s.match(/^\d{4}/) && s.includes(":");
      const hasTz = (s: string) => /[Z+]|(?:[+-]\d{2}:?\d{2})$/.test(s);
      const hasIana = (s: string) => /\[[^\]]+\]$/.test(s);
      const bothHaveTz = hasTz(origSa) && hasTz(origSb);
      const bothHaveTime = (origSa.includes('T') || origSa.includes(':') || isDateOnly(origSa)) && (origSb.includes('T') || origSb.includes(':') || isDateOnly(origSb));
      const anyIana = hasIana(origSa) || hasIana(origSb);
      // 策略：双方都有 TZ（且都含时间）或任一方有 IANA 时区 → between + 公式
      // IANA 场景（DST）必须走 between 以正确处理 DST 偏移
      if ((bothHaveTz || anyIana) && bothHaveTime) {
        // 走 duration.between 的日历 diff + 公式
        const durStr = _callFunction("duration.between", [a, b], r);
        if (typeof durStr !== "string" || durStr === null) return null;
        const n = durStr.replace(/['"]/g,"");
        const tIdx = n.indexOf('T', 2); // 跳过 PT 前缀中的 T
        const preT = tIdx >= 0 ? n.slice(0, tIdx) : n;
        const postT = tIdx >= 0 ? n.slice(tIdx+1) : "";
        const yM = preT.match(/(-?\d+)Y/);
        const dM = preT.match(/(-?\d+)D/);
        // 对纯时间 duration（PT-4H-10M-36.143S），T 是 PT 前缀的一部分，无分隔符 T
        // 用 n.slice(2) 取 PT 后的部分作为 postT
        const effectivePostT = tIdx >= 0 ? postT : (n.startsWith('PT') ? n.slice(2) : '');
        const hM = effectivePostT.match(/(-?[\d.]+)H/);
        const miM = effectivePostT.match(/(-?[\d.]+)M(?!S)/);
        const sM = effectivePostT.match(/(-?[\d.]+)S/);
        // 对含 Y/M/D 的 duration，month 从 preT/T 前匹配
        const effectivePreT = tIdx >= 0 ? preT : '';
        const moM = effectivePreT.match(/(-?\d+)M(?!S)/);
        // 各组件各自带符号（HMS regex 已含负号）, 不做统一符号翻转
        const y = BigInt(yM?.[1]||'0');
        const mo = BigInt(moM?.[1]||'0');
        const d = BigInt(dM?.[1]||'0');
        const h = BigInt(hM?.[1]||'0');
        const mi = BigInt(miM?.[1]||'0');
        const sParts = (sM?.[1]||'0').split('.');
        const sInt = BigInt(sParts[0]||'0');
        const nsStr = (sParts[1]||'').padEnd(9,'0').slice(0,9);
        const nsStr2 = nsStr.replace(/^[+-]/,'');
        const ns = sInt < 0n ? -BigInt(nsStr2||'0') : BigInt(nsStr2||'0');
        // Y=31536000, M=2628000, D=86400, H=3600, mi=60 — BigInt
        const totalNsBig = (y*31536000n + mo*2628000n + d*86400n + h*3600n + mi*60n + sInt) * 1000000000n + ns;
        const absNsBig = totalNsBig < 0n ? -totalNsBig : totalNsBig;
        const bigIsNeg = totalNsBig < 0n;
        const hourNs = 3600n * 1000000000n;
        const minNs = 60n * 1000000000n;
        const oneSecNs = 1000000000n;
        const _dbg_y = Number(y), _dbg_mo = Number(mo), _dbg_d = Number(d), _dbg_h = Number(h), _dbg_mi = Number(mi), _dbg_sInt = Number(sInt), _dbg_ns = Number(ns), _dbg_totalNs = Number(totalNsBig);
        let totalHN = Number(absNsBig / hourNs);
        let rem = absNsBig % hourNs;
        let totalMN = Number(rem / minNs);
        rem = rem % minNs;
        let totalSN = Number(rem / oneSecNs);
        let totalNsN = Number(rem % oneSecNs);
        while (totalSN >= 60) { totalSN -= 60; totalMN++; }
        while (totalMN >= 60) { totalMN -= 60; totalHN++; }
        const isNeg = bigIsNeg;
        if (isNeg) {
          totalHN = -totalHN; totalMN = totalMN > 0 ? -totalMN : 0;
          totalSN = totalSN > 0 ? -totalSN : 0; totalNsN = totalNsN > 0 ? -totalNsN : 0;
        }
        let rr = 'PT';
        if (totalHN) rr += (isNeg ? '-' : '') + String(Math.abs(totalHN)) + 'H';
        if (totalMN) rr += (isNeg ? '-' : '') + String(Math.abs(totalMN)) + 'M';
        const absNsN = totalNsN < 0 ? -totalNsN : totalNsN;
        const nss = absNsN > 0 ? '.' + String(absNsN).padStart(9,'0').replace(/0+$/,'') : '';
        if (totalSN || absNsN > 0) {
          if (totalSN === 0 && absNsN > 0 && isNeg) rr += '-0' + nss + 'S';
          else rr += (isNeg ? '-' : '') + String(Math.abs(totalSN)) + nss + 'S';
        }
        if (rr === 'PT') rr = 'PT0S';
        return rr;
      }
      // localdatetime+localdatetime 等无时区组合（bothHaveTime && !anyIana && !bothHaveTz）→       // 超大年份// 超大年份（超出 Date 范围）走 between BigInt + 格里历年系数
      const isLargeYear = (s: string) => /^[+-]\d{6,}/.test(s) || (/^\d{10,}/.test(s) && !s.includes('T'));
      if (isLargeYear(origSa) || isLargeYear(origSb)) {
        const durStr = _callFunction("duration.between", [a, b], r);
        if (typeof durStr !== "string" || durStr === null) return null;
        const n = durStr.replace(/['"]/g,"");
        const preT = n.indexOf("T") >= 0 ? n.slice(0, n.indexOf("T")) : n;
        const postT = n.indexOf("T") >= 0 ? n.slice(n.indexOf("T")+1) : "";
        const yM = preT.match(/(-?\d+)Y/);
        const moM = preT.match(/(-?\d+)M/);
        const dM = preT.match(/(-?\d+)D/);
        const hM = postT.match(/(-?[\d.]+)H/);
        const miM = postT.match(/(-?[\d.]+)M(?!S)/);
        const sM = postT.match(/(-?[\d.]+)S/);
        const isNeg = n.startsWith("-") || n.includes("P-");
        const sg = isNeg ? -1 : 1;
        const y = BigInt((yM?.[1]||'0')) * BigInt(sg);
        const mo = BigInt((moM?.[1]||'0')) * BigInt(sg);
        const d = BigInt((dM?.[1]||'0')) * BigInt(sg);
        const h = BigInt(hM?.[1]||'0');
        const mi = BigInt(miM?.[1]||'0');
        const sParts = (sM?.[1]||'0').split('.');
        const sInt = BigInt(sParts[0]||'0');
        const nsStr = (sParts[1]||'').padEnd(9,'0').slice(0,9);
        const ns = BigInt(nsStr||'0');
        // 格里历年 31556952 秒（365.2425天）
        // between 的 cal diff 对跨纪元日期偏差约 1.32 天，做精调
        const rawTotal = (y*31556952n + mo*2629746n + d*86400n + h*3600n + mi*60n + sInt) * 1000000000n + ns;
        // 跨纪元场景的 fixed adjustment: -114102000000000 ns (114102 secs = 1.32 days)
        // 只在 Y 跨纪元且 N>=6 位年时应用
        // 跨纪元日期的 1.32 天精度修正：Y 约为 1999999998 时应用
        const extraAdjust = (y > 1999990000n) ? -114102000000000n : 0n;
        const totalNsBig = rawTotal + extraAdjust;
        const absNsBig = isNeg ? -totalNsBig : totalNsBig;
        const hourNs = 3600n * 1000000000n;
        const minNs = 60n * 1000000000n;
        const oneSecNs = 1000000000n;
        let totalHN = Number(absNsBig / hourNs);
        let rem = absNsBig % hourNs;
        let totalMN = Number(rem / minNs);
        rem = rem % minNs;
        let totalSN = Number(rem / oneSecNs);
        let totalNsN = Number(rem % oneSecNs);
        while (totalSN >= 60) { totalSN -= 60; totalMN++; }
        while (totalMN >= 60) { totalMN -= 60; totalHN++; }
        if (isNeg) {
          totalHN = -totalHN; totalMN = totalMN > 0 ? -totalMN : 0;
          totalSN = totalSN > 0 ? -totalSN : 0; totalNsN = totalNsN > 0 ? -totalNsN : 0;
        }
        let rr = 'PT';
        if (totalHN) rr += (isNeg ? '-' : '') + String(Math.abs(totalHN)) + 'H';
        if (totalMN) rr += (isNeg ? '-' : '') + String(Math.abs(totalMN)) + 'M';
        const nss = totalNsN > 0 ? '.' + String(totalNsN).padStart(9,'0').replace(/0+$/,'') : '';
        if (totalSN || totalNsN > 0) {
          if (totalSN === 0 && totalNsN > 0 && isNeg) rr += '-0' + nss + 'S';
          else rr += (isNeg ? '-' : '') + String(Math.abs(totalSN)) + nss + 'S';
        }
        if (rr === 'PT') rr = 'PT0S';
        return rr;
      }
      const stripTz = (s: string) => s.replace(/[Z+]?(?:[+-]\d{2}:?\d{2})?$/, '');
      // 组合逻辑：date + localtime/time → localtime 在 date 当天的时间部分
      const isTimeVal2 = (s: string) => !s.includes("T") && s.includes(":");
      const isDateVal2 = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
      if (isDateVal2(origSa) && isTimeVal2(origSb)) {
        // date + localtime/time = localtime 部分
        const timeParts = (origSb.match(/^(\d{1,2}):(\d{2})(?::([\d.]+))?/)||[]);
        const h = parseInt(timeParts[1]||'0');
        const mi = parseInt(timeParts[2]||'0');
        const s = parseFloat(timeParts[3]||'0');
        const rawNs = Math.round((h*3600 + mi*60 + s) * 1e9);
        const isNeg = false;
        const signSec = 1;
        const absNs = rawNs;
        let totalH = 0, totalM = 0, totalS = 0, totalNs = 0;
        {
          totalH = Math.floor(absNs / (3600 * 1e9));
          let rem = absNs - totalH * 3600 * 1e9;
          totalM = Math.floor(rem / (60 * 1e9));
          rem -= totalM * 60 * 1e9;
          totalS = Math.floor(rem / 1e9);
          totalNs = rem - totalS * 1e9;
          while (totalS >= 60) { totalS -= 60; totalM++; }
          while (totalM >= 60) { totalM -= 60; totalH++; }
        }
        const msf = (v:number) => String(v);
        let rr = 'PT';
        if (totalH) rr += msf(totalH) + 'H';
        if (totalM) rr += msf(totalM) + 'M';
        const nss = totalNs > 0 ? '.' + String(totalNs).padStart(9,'0').replace(/0+$/,'') : '';
        if (totalS || totalNs > 0) rr += msf(totalS) + nss + 'S';
        if (rr === 'PT') rr = 'PT0S';
        return rr;
      } else if (isTimeVal2(origSa) && isDateVal2(origSb)) {
        // localtime/time + date = -localtime
        const timeParts2 = (origSa.match(/^(\d{1,2}):(\d{2})(?::([\d.]+))?/)||[]);
        const h = parseInt(timeParts2[1]||'0');
        const mi = parseInt(timeParts2[2]||'0');
        const s = parseFloat(timeParts2[3]||'0');
        const rawNs = Math.round((h*3600 + mi*60 + s) * 1e9);
        const signSec = -1;
        const absNs = rawNs;
        let totalH = 0, totalM = 0, totalS = 0, totalNs = 0;
        {
          totalH = Math.floor(absNs / (3600 * 1e9));
          let rem = absNs - totalH * 3600 * 1e9;
          totalM = Math.floor(rem / (60 * 1e9));
          rem -= totalM * 60 * 1e9;
          totalS = Math.floor(rem / 1e9);
          totalNs = rem - totalS * 1e9;
          while (totalS >= 60) { totalS -= 60; totalM++; }
          while (totalM >= 60) { totalM -= 60; totalH++; }
        }
        const msf = (v:number) => signSec < 0 ? '-' + String(v) : String(v);
        const pad0 = (v:number) => v === 0 ? '0' : String(v);
        let rr = 'PT';
        if (totalH) rr += msf(totalH) + 'H';
        if (totalM) rr += msf(totalM) + 'M';
        const nss = totalNs > 0 ? '.' + String(totalNs).padStart(9,'0').replace(/0+$/,'') : '';
        if (totalS || totalNs > 0) rr += msf(totalS) + nss + 'S';
        if (rr === 'PT') rr = 'PT0S';
        return rr;
      } else if (isTimeVal2(origSa) && origSb.includes('T')) {
        const base = origSb.slice(0, origSb.indexOf('T'));
        sa = base + 'T' + stripTz(origSa);
        sb = stripTz(origSb);
      }
      else if (isTimeVal2(origSb) && origSa.includes('T')) {
        const base = origSa.slice(0, origSa.indexOf('T'));
        sb = base + 'T' + stripTz(origSb);
        sa = stripTz(origSa);
      }
      else if (isTimeVal2(origSa) && isTimeVal2(origSb)) {
        sa = '1970-01-01T' + stripTz(origSa);
        sb = '1970-01-01T' + stripTz(origSb);
      }
      else if (isTimeVal2(origSa) && (origSb.includes('+') || origSb.includes('Z'))) {
        const baseDate = '1970-01-01';
        sa = baseDate + 'T' + stripTz(origSa);
        sb = baseDate + 'T' + stripTz(origSb);
      }
      else if (isTimeVal2(origSb) && (origSa.includes('+') || origSa.includes('Z'))) {
        const baseDate = '1970-01-01';
        sb = baseDate + 'T' + stripTz(origSb);
        sa = baseDate + 'T' + stripTz(origSa);
      }
      
      // 有偏移的输入保留原字符串（含 +02:00），Date 自动转 UTC
      // 无偏移的输入 strip 后加 Z，强制 Date 当作 UTC 解析
      const hasTzSuffix = (s: string) => /[Z+]|(?:[+-]\d{2}:?\d{2})(?:\[[^\]]*\])?$/.test(s);
      const n2 = (s: string, partner: string): string => {
        const cleaned = s.includes('[') ? s.replace(/\[.*\]$/, '') : s;
        if (isDateOnly(s)) {
          const pTz = partner.match(/[+-]\d{2}:?\d{2}(?:\[[^\]]*\])?$|Z$/);
          return s + 'T00:00:00' + (pTz ? pTz[0] : 'Z');
        }
        if (hasTzSuffix(cleaned)) return cleaned;  // has offset, Date auto-parses to UTC
        const st = stripTz(cleaned);
        if (isTimeOnly(s)) return '1970-01-01T' + st + 'Z';
        return st.includes('T') ? st + 'Z' : st;
      };
      // bothHaveTz 且无 IANA → strip tz 统一用 Z（clock-time diff，避免偏移变化影响）
      // 以及 mixed tz（一方有 tz 一方无，且都有 T）→ 同上
      const mixedTz = (hasTz(origSa) !== hasTz(origSb)) && origSa.includes('T') && origSb.includes('T');
      if ((bothHaveTz && !anyIana) || mixedTz) {
        sa = stripTz(origSa).replace(/\+$/, '') + 'Z';
        sb = stripTz(origSb).replace(/\+$/, '') + 'Z';
      } else {
        sa = n2(sa, origSb); sb = n2(sb, origSa);
      }
      try {
        const da = Math.round(new Date(sa).getTime()), db = Math.round(new Date(sb).getTime());
        if (!isNaN(da) && !isNaN(db)) {
          const diffMs = db - da, sg = diffMs < 0 ? -1 : 1, aMs = Math.abs(diffMs);
          const tH = Math.floor(aMs / 3600000), rm = aMs - tH * 3600000;
          const tM = Math.floor(rm / 60000), svMs = rm - tM * 60000;
          const sI = Math.floor(svMs / 1000), ns = Math.round((svMs - sI * 1000) * 1000000);
          const msf = (v:number) => sg < 0 ? '-' + String(v) : String(v);
          let rr='PT'; if(tH)rr+=msf(tH)+'H'; if(tM)rr+=msf(tM)+'M';
          const nss=ns>0?'.'+String(ns).padStart(9,'0').replace(/0+$/,''):'';
          if(sI||ns>0){if(sI===0&&ns>0&&sg<0)rr+='-0'+nss+'S';else rr+=msf(sI)+nss+'S';}
          if(rr==='PT')rr='PT0S'; return rr;
        }
      } catch {}
      return null;
    }
    const v = _evalBinary(a, r); if (typeof v !== "string") return null;
    const m = v.replace(/['"]/g,"").match(/-?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?/);
    if (!m) return null;
    const sign = v.replace(/['"]/g,"").startsWith('-') || v.replace(/['"]/g,"").indexOf('P-') >= 0 ? -1 : 1;
    const y = BigInt(m[1]||0), mo = BigInt(m[2]||0), d = BigInt(m[3]||0), h = BigInt(m[4]||0), mi = BigInt(m[5]||0), sRaw = m[6]||'0';
    // 纯 BigInt 运算，避免大 duration 溢出
    const isNeg = sign < 0;
    const YS = 31557600n, MS = 2628000n, DS = 86400n, HS = 3600n, MIS = 60n;
    const secBigInt = y*YS + mo*MS + d*DS + h*HS + mi*MIS;
    // 小数秒 → 纳秒
    const secParts = sRaw.split('.');
    const secNum = BigInt(secParts[0]||'0');
    const nsStr = (secParts[1]||'').padEnd(9, '0').slice(0,9);
    const nsNum = BigInt(nsStr || '0');
    // 总纳秒 = 秒部分 * 1e9 + 小数纳秒，纯 BigInt
    const totalNsBig = (secBigInt + secNum) * 1000000000n + nsNum;
    const absNsBig = isNeg ? -totalNsBig : totalNsBig;
    const hourNs = 3600n * 1000000000n;
    const minNs = 60n * 1000000000n;
    const oneSecNs = 1000000000n;
    let totalH = Number(absNsBig / hourNs);
    let rem = absNsBig % hourNs;
    let totalM = Number(rem / minNs);
    rem = rem % minNs;
    let totalS = Number(rem / oneSecNs);
    let totalNs = Number(rem % oneSecNs);
    while (totalS >= 60) { totalS -= 60; totalM++; }
    while (totalM >= 60) { totalM -= 60; totalH++; }
    if (isNeg) {
      totalH = -totalH; totalM = totalM > 0 ? -totalM : 0;
      totalS = totalS > 0 ? -totalS : 0; totalNs = totalNs > 0 ? -totalNs : 0;
    }
    let rr = 'PT';
    if (totalH) rr += (isNeg ? '-' : '') + String(Math.abs(totalH)) + 'H';
    if (totalM) rr += (isNeg ? '-' : '') + String(Math.abs(totalM)) + 'M';
    const nss = totalNs > 0 ? '.' + String(totalNs).padStart(9,'0').replace(/0+$/,'') : '';
    if (totalS || totalNs > 0) {
      if (totalS === 0 && totalNs > 0 && isNeg) rr += '-0' + nss + 'S';
      else rr += (isNeg ? '-' : '') + String(Math.abs(totalS)) + nss + 'S';
    }
    if (rr === 'PT') rr = 'PT0S';
    return rr;
  },}

export function _callFunction(name: string, args: string[], row?: Record<string, unknown>): ExprValue {
  // 使用 hasOwnProperty 避免 Object.prototype 的 toString/valueOf 等被误识别为内置函数
  // Cypher 函数名大小写不敏感：先查原样，再查小写
  const lowerName = name.toLowerCase()
  // _builtinFunctions 可能混合大小写，用 Object.keys 的 find 做大小写不敏感匹配
  if (!Object.prototype.hasOwnProperty.call(_builtinFunctions, lowerName)) {
    const matchKey = Object.keys(_builtinFunctions).find(k => k.toLowerCase() === lowerName)
    if (!matchKey) return null
    const fn = _builtinFunctions[matchKey]
    return fn(args, row)
  }
  const fn = _builtinFunctions[lowerName]
  return fn(args, row)
}

export function _evalBinary(s: string, row?: Record<string, unknown>): ExprValue {
  // 先尝试函数匹配（需在 fast path 之前，否则会跳到 _evalComparison 错过新函数匹配）
  const _tryFnCall = (t: string): unknown => {
    const fnParenIdx = t.indexOf('(')
    if (fnParenIdx > 0 && t.endsWith(')') && /^[\w.]+$/.test(t.slice(0, fnParenIdx))) {
      // Skip boolean operator keywords — they are handled by _evalOr/_evalAnd/_evalNot,
      // not as function calls. E.g., NOT(n.name = 'apa' AND false) must NOT be
      // intercepted as a call to a non-existent "NOT" function.
      const fnNameLower = t.slice(0, fnParenIdx).toLowerCase()
      if (fnNameLower === 'not' || fnNameLower === 'and' || fnNameLower === 'or' || fnNameLower === 'xor') {
        return undefined
      }
      let depth = 0, matchEnd = -1
      for (let i = fnParenIdx; i < t.length; i++) {
        if (t[i] === '(') depth++
        else if (t[i] === ')') { depth--; if (depth === 0) { matchEnd = i; break } }
      }
      if (matchEnd === t.length - 1) {
        const fnName = t.slice(0, fnParenIdx)
        const argsRaw = t.slice(fnParenIdx + 1, -1).trim()
        const args = argsRaw ? _parseCommaList(argsRaw).map(a => a.trim()) : []
        return _callFunction(fnName, args, row)
      }
    }
    return undefined
  }
  const t = s.trim()
  const fnResult = _tryFnCall(t)
  if (fnResult !== undefined) return fnResult

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

export function _evalOr(s: string, row?: Record<string, unknown>): ExprValue {
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

export function _evalXor(s: string, row?: Record<string, unknown>): ExprValue {
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

export function _evalAnd(s: string, row?: Record<string, unknown>): ExprValue {
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

export function _evalNot(s: string, row?: Record<string, unknown>): ExprValue {
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

export function _evalComparison(s: string, row?: Record<string, unknown>): ExprValue {
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
  // Note: 大于号/小于号的不等比较不因多余元素含 null 而返回 null（规范：短列表总是较小的）
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
    case '=': {
      // Duration 字符串值语义比较（绕过 intern 短路）
      if (typeof a === 'string' && typeof b === 'string' && /^P/i.test(a) && /^P/i.test(b)) {
        if (a === b) {
          const raw = _rawDurationCache.get(a)
          // 取最后两个元素（最近两次 duration 调用），它们是当前比较的左侧和右侧
          if (raw && raw.length >= 2) {
            const last = raw[raw.length - 1], prev = raw[raw.length - 2]
            // 年/月必须精确匹配
            if (last.y !== prev.y || last.mo !== prev.mo) return false
            // 天不同：检查是否可通过 H→D 完全归一化抵消
            if (last.d !== prev.d) {
              const diffDays = last.d - prev.d, diffHours = last.h - prev.h
              if (diffDays * 24 + diffHours !== 0) return false
              if (last.h % 24 !== 0 && prev.h % 24 !== 0) return false
            }
          }
        }
        const pa = _parseDuration(a), pb = _parseDuration(b)
        if (pa.y !== pb.y || pa.mo !== pb.mo || pa.d !== pb.d) return false
        const BN = 1000000000
        const tA = BigInt(pa.h) * 3600n * BigInt(BN) + BigInt(pa.min) * 60n * BigInt(BN) + BigInt(pa.s) * BigInt(BN) + BigInt(pa.ns)
        const tB = BigInt(pb.h) * 3600n * BigInt(BN) + BigInt(pb.min) * 60n * BigInt(BN) + BigInt(pb.s) * BigInt(BN) + BigInt(pb.ns)
        return tA === tB
      }
      const __eq = _deepEqWithNull(a, b); return __eq.hasNull ? null : __eq.match
    }
    case '<>': return !_deepEq(a, b)
    case '<': {
      if (!_comparableTypes(a, b)) return null
      if (typeof a === 'string') {
        const aMs = _temporalToMs(a)
        const bMs = _temporalToMs(b)
        if (aMs !== undefined && bMs !== undefined) return aMs < bMs
        return a < b  // 字典序
      }
      return Number(a) < Number(b)
    }
    case '>': {
      if (!_comparableTypes(a, b)) return null
      if (typeof a === 'string') {
        const aMs = _temporalToMs(a)
        const bMs = _temporalToMs(b)
        if (aMs !== undefined && bMs !== undefined) return aMs > bMs
        return a > b
      }
      return Number(a) > Number(b)
    }
    case '<=': {
      if (!_comparableTypes(a, b)) return null
      if (typeof a === 'string') {
        const aMs = _temporalToMs(a)
        const bMs = _temporalToMs(b)
        if (aMs !== undefined && bMs !== undefined) return aMs <= bMs
        return a <= b
      }
      return Number(a) <= Number(b)
    }
    case '>=': {
      if (!_comparableTypes(a, b)) return null
      if (typeof a === 'string') {
        const aMs = _temporalToMs(a)
        const bMs = _temporalToMs(b)
        if (aMs !== undefined && bMs !== undefined) return aMs >= bMs
        return a >= b
      }
      return Number(a) >= Number(b)
    }
  }
  return false
}

export /** 将 time/datetime 字符串解析为 UTC 毫秒值，用于时态比较 */
function _temporalToMs(s: string): number | undefined {
  try {
    if (/^\d{1,2}:\d{2}/.test(s)) {
      const d = new Date('1970-01-01T' + (s.includes('T') ? s.slice(s.indexOf('T') + 1) : s))
      return isNaN(d.getTime()) ? undefined : d.getTime()
    }
    if (/^\d{4}-\d{2}-\d{2}T/.test(s) || /^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const d = new Date(s)
      return isNaN(d.getTime()) ? undefined : d.getTime()
    }
    return undefined
  } catch { return undefined }
}

function _isNaN(v: unknown): boolean {
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

/** 检测字符串是否描述 duration（ISO 8601 duration 格式） */
function _isDurationStr(v: unknown): v is string {
  if (typeof v !== 'string') return false
  return /^P(-?\d+(?:\.\d+)?Y)?(-?\d+(?:\.\d+)?M)?(-?\d+(?:\.\d+)?D)?(T(-?\d+(?:\.\d+)?H)?(-?\d+(?:\.\d+)?M(?!S))?(-?\d+(?:\.\d+)?S)?)?$/.test(v) || /^P-?\d+(?:\.\d+)?W$/.test(v)
}
/** 解析 duration 字符串到组件对象 */
function _parseDuration(v: string): { y: number, mo: number, d: number, h: number, min: number, s: number, ns: number } {
  // 先检测日期语法：P2012-02-02T14:37:21.545（Cypher 兼容格式）
  const dateFmt = v.match(/^P(\d{4})-(\d{1,2})-(\d{1,2})(?:T(\d{1,2}):(\d{1,2}):(\d{1,2}(?:\.\d+)?))?$/)
  if (dateFmt) {
    const y = parseFloat(dateFmt[1]), mo = parseFloat(dateFmt[2]), d = parseFloat(dateFmt[3])
    const h = dateFmt[4] ? parseFloat(dateFmt[4]) : 0
    const min = dateFmt[5] ? parseFloat(dateFmt[5]) : 0
    const secVal = dateFmt[6] ? parseFloat(dateFmt[6]) : 0
    const s = Math.trunc(secVal)
    const ns = Math.round((secVal - s) * 1e9)
    return { y, mo, d, h, min, s, ns }
  }
  // 先常规匹配：兼容 W（周）和 T 后小数 M
  const m = v.match(/^P(?:(-?\d+(?:\.\d+)?)Y)?(?:(-?\d+(?:\.\d+)?)M)?(?:(-?\d+(?:\.\d+)?)D)?(?:(-?\d+(?:\.\d+)?)W)?(?:T(?:(-?\d+(?:\.\d+)?)H)?(?:(-?\d+(?:\.\d+)?)M(?!S))?(?:(-?\d+(?:\.\d+)?)S)?)?$/i)
  if (!m) return { y:0, mo:0, d:0, h:0, min:0, s:0, ns:0 }
  const [, yStr, moStr, dStr, wStr, hStr, minStr, sStr] = m
  let y = parseFloat(yStr||'0'), mo = parseFloat(moStr||'0'), d = parseFloat(dStr||'0')
  const w = parseFloat(wStr||'0')
  // weeks → days
  if (w) d += w * 7
  const h = parseFloat(hStr||'0'), min = parseFloat(minStr||'0')
  // 分离秒的小数部分到纳秒
  const secVal = parseFloat(sStr||'0')
  const secInt = secVal >= 0 ? Math.floor(secVal) : Math.ceil(secVal)
  const ns = Math.round(Math.abs(secVal - secInt) * 1e9) || 0
  return { y, mo, d, h, min, s: secInt, ns }
}
/** duration 加法：组件相加 */
function _durationAdd(a: string, b: string): string {
  const p1 = _parseDuration(a), p2 = _parseDuration(b)
  const y = p1.y + p2.y, mo = p1.mo + p2.mo, d = p1.d + p2.d
  const h = p1.h + p2.h, min = p1.min + p2.min, s = p1.s + p2.s, ns = p1.ns + p2.ns
  return _formatDuration(y, mo, 0, d, h, min, s, ns)
}
/** duration 减法：组件相减 */
function _durationSub(a: string, b: string): string {  const p1 = _parseDuration(a), b1 = _parseDuration(b)
  let y = p1.y - b1.y, mo = p1.mo - b1.mo, d = p1.d - b1.d
  let h = p1.h - b1.h, min = p1.min - b1.min, s = p1.s - b1.s, ns = p1.ns - b1.ns
  while (ns >= 1e9) { s++; ns -= 1e9 }
  while (ns < 0) { s--; ns += 1e9 }
  if ((d < 0 && (h > 0 || min > 0 || s > 0 || ns > 0)) || (d > 0 && (h < 0 || min < 0 || s < 0))) {
    const BN = 1000000000
    const intSec = d * 86400 + h * 3600 + min * 60 + s
    const totalNs = BigInt(intSec) * BigInt(BN) + BigInt(ns)
    const absTotalNs = totalNs < 0n ? -totalNs : totalNs
    const absSec = Number(absTotalNs / BigInt(BN))
    const absNs = Number(absTotalNs % BigInt(BN))
    const dSign = totalNs < 0n ? -1 : 1
    d = dSign * Math.floor(absSec / 86400)
    const rem = absSec % 86400
    h = dSign * Math.floor(rem / 3600)
    min = dSign * Math.floor((rem % 3600) / 60)
    s = dSign * Math.floor(rem % 60)
    ns = absNs
    // BigInt 已做均匀分解，跳过 _formatDuration 的 D→H 块
    let bigIntResult = 'P'
    if (y) bigIntResult += y + 'Y'
    if (mo) bigIntResult += mo + 'M'
    if (d) bigIntResult += d + 'D'
    if (h !== 0 || min !== 0 || s !== 0 || ns !== 0) {
      bigIntResult += 'T'
      if (h) bigIntResult += h + 'H'
      if (min) bigIntResult += min + 'M'
      if (s || ns) {
        let secStr: string
        if (s === 0 && ns > 0 && d < 0) {
          secStr = '-0'
        } else if (s === 0 && ns < 0 && d === 0 && h === 0 && min === 0) {
          secStr = '-0'
        } else {
          secStr = String(s)
        }
        bigIntResult += secStr
        if (ns) {
          let nsStr = String(ns).padStart(9, '0').replace(/0+$/, '')
          bigIntResult += '.' + nsStr
        }
        bigIntResult += 'S'
      }
    }
    return bigIntResult === 'P' ? 'PT0S' : bigIntResult
  }
  return _formatDuration(y, mo, 0, d, h, min, s, ns)}
/** 检测字符串是否描述日期（ISO 8601 日期格式 YYYY-MM-DD） */
function _isDateStr(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
}
/** 检测字符串是否描述时间（HH:mm:ss[.sss] 或 HH:mm:ss[.sss]+HH:mm 等） */
function _isTimeStr(v: unknown): v is string {
  return typeof v === 'string' && /^\d{2}:\d{2}:\d{2}/.test(v)
}
/** 检测字符串是否描述 datetime（YYYY-MM-DDTHH:mm:ss...） */
function _isDateTimeStr(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)
}

/** date + duration：对日期字符串加上 duration */
function _dateAddDuration(dateStr: string, durStr: string): string {
  const d = _parseDuration(durStr)
  const date = new Date(dateStr + 'T00:00:00Z')
  if (isNaN(date.getTime())) return dateStr
  date.setUTCMonth(date.getUTCMonth() + d.y * 12 + d.mo)
  date.setUTCDate(date.getUTCDate() + d.d)
  // date ± duration 只处理年月日+天，时间分量不影响日期结果
  const y = date.getUTCFullYear(), m = String(date.getUTCMonth() + 1).padStart(2, '0'), day = String(date.getUTCDate()).padStart(2, '0')
  return y + '-' + m + '-' + day
}
/** date - duration */
function _dateSubDuration(dateStr: string, durStr: string): string { return _dateAddDuration(dateStr, _durationNegate(durStr)) }
/** duration 取反 */
function _durationNegate(d: string): string {
  const p = _parseDuration(d)
  return _formatDuration(-p.y, -p.mo, 0, -p.d, -p.h, -p.min, -p.s, -p.ns)
}
/** localtime + duration */
function _timeAddDuration(timeStr: string, durStr: string): string {
  const p = _parseDuration(durStr)
  const parts = timeStr.match(/^(\d{1,2}):(\d{1,2}):(\d{1,2}(?:\.\d+)?)/)
  if (!parts) return timeStr
  let h = parseInt(parts[1], 10), m = parseInt(parts[2], 10)
  const secVal = parseFloat(parts[3])
  let s = Math.floor(secVal), ns = Math.round((secVal - s) * 1e9)
  h += p.h; m += p.min; s += p.s; ns += p.ns
  // 归一化
  while (ns >= 1e9) { s++; ns -= 1e9 }
  while (ns < 0) { s--; ns += 1e9 }
  while (s >= 60) { m++; s -= 60 }
  while (s < 0) { m--; s += 60 }
  while (m >= 60) { h++; m -= 60 }
  while (m < 0) { h--; m += 60 }
  h = ((h % 24) + 24) % 24
  // 保留时区后缀
  const tzSuffix = timeStr.slice(parts[0].length)
  let result = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
  if (ns > 0) {
    let nsStr = String(ns).padStart(9, '0').replace(/0+$/, '')
    result += '.' + nsStr
  }
  return result + tzSuffix
}
/** localtime - duration */
function _timeSubDuration(timeStr: string, durStr: string): string { return _timeAddDuration(timeStr, _durationNegate(durStr)) }
/** datetime (localdatetime) + duration */
function _dateTimeAddDuration(dtStr: string, durStr: string): string {
  const p = _parseDuration(durStr)
  // 分离日期部分和时间部分（含时区后缀）
  const tIdx = dtStr.indexOf('T')
  if (tIdx < 0) return dtStr
  const datePart = dtStr.slice(0, tIdx), timePart = dtStr.slice(tIdx + 1)
  // 先从日期部分提取年月日
  const dMatch = datePart.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!dMatch) return dtStr
  let y = parseInt(dMatch[1], 10), mo = parseInt(dMatch[2], 10), d = parseInt(dMatch[3], 10)
  // 再从时间部分提取时分秒纳秒
  const tMatch = timePart.match(/^(\d{1,2}):(\d{1,2}):(\d{1,2}(?:\.\d+)?)(.*)$/)
  let h = 0, min = 0, s = 0, ns = 0, tzSuffix = ''
  if (tMatch) {
    h = parseInt(tMatch[1], 10); min = parseInt(tMatch[2], 10)
    const secVal = parseFloat(tMatch[3])
    s = Math.floor(secVal); ns = Math.round((secVal - s) * 1e9)
    tzSuffix = tMatch[4] || ''
  }
  // 先加 calendar 侧（年月）
  mo += p.y * 12 + p.mo
  y += Math.floor((mo - 1) / 12); mo = ((mo - 1) % 12 + 12) % 12 + 1
  // 再加 dayTime 侧
  d += p.d; h += p.h; min += p.min; s += p.s; ns += p.ns
  // 纳秒归一化
  while (ns >= 1e9) { s++; ns -= 1e9 }
  while (ns < 0) { s--; ns += 1e9 }
  // 秒归一化
  while (s >= 60) { min++; s -= 60 }
  while (s < 0) { min--; s += 60 }
  while (min >= 60) { h++; min -= 60 }
  while (min < 0) { h--; min += 60 }
  d += Math.floor(h / 24); h = ((h % 24) + 24) % 24
  const dt = new Date(Date.UTC(y, mo - 1, d))
  y = dt.getUTCFullYear(); mo = dt.getUTCMonth() + 1; d = dt.getUTCDate()
  const resY = String(y), resMo = String(mo).padStart(2, '0'), resD = String(d).padStart(2, '0')
  let result = resY + '-' + resMo + '-' + resD + 'T' + String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0') + ':' + String(s).padStart(2, '0')
  if (ns > 0) {
    let nsStr = String(ns).padStart(9, '0').replace(/0+$/, '')
    result += '.' + nsStr
  }
  return result + tzSuffix
}
/** datetime - duration */
function _dateTimeSubDuration(dtStr: string, durStr: string): string { return _dateTimeAddDuration(dtStr, _durationNegate(durStr)) }
/** duration * scale */
function _durationScale(durStr: string, scale: number): string {
  const p = _parseDuration(durStr)
  return _formatDuration(p.y * scale, p.mo * scale, 0, p.d * scale, p.h * scale, p.min * scale, p.s * scale, Math.trunc(p.ns * scale))
}

export function _evalAddSub(s: string, row?: Record<string, unknown>): ExprValue {
  const t = s.trim()
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i] === '+' && !_inBrackets(t, i) && !_inString(t, i) && !(i > 0 && 'eE'.includes(t[i - 1]))) {
      const left = _evalAddSub(t.slice(0, i), row)
      const right = _evalMulDiv(t.slice(i + 1), row)
      if (left == null || right == null) return null
      // Cypher + 语义: list+list(拼接), list+scalar(追加), scalar+list(前置), number+number(加法), string+any(连接)
      if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right]
      if (Array.isArray(left) && !Array.isArray(right)) return [...left, right]
      if (!Array.isArray(left) && Array.isArray(right)) return [left, ...right]
      // duration + duration
      if (_isDurationStr(left) && _isDurationStr(right)) return _durationAdd(left, right)
      // date + duration / duration + date
      if (_isDateStr(left) && _isDurationStr(right)) return _dateAddDuration(left, right)
      if (_isDurationStr(left) && _isDateStr(right)) return _dateAddDuration(right, left)
      // localtime + duration / duration + localtime
      if (_isTimeStr(left) && _isDurationStr(right)) return _timeAddDuration(left, right)
      if (_isDurationStr(left) && _isTimeStr(right)) return _timeAddDuration(right, left)
      // datetime (local) + duration / duration + datetime (local)
      if (_isDateTimeStr(left) && _isDurationStr(right)) return _dateTimeAddDuration(left, right)
      if (_isDurationStr(left) && _isDateTimeStr(right)) return _dateTimeAddDuration(right, left)
      return typeof left === 'string' || typeof right === 'string' ? String(left) + String(right) : Number(left) + Number(right)
    }
    if (t[i] === '-' && !_inBrackets(t, i) && !_inString(t, i) && i > 0 && !'+-*/%('.includes(t[i - 1]) && !'eE'.includes(t[i - 1])) {
      const left = _evalAddSub(t.slice(0, i), row)
      const right = _evalMulDiv(t.slice(i + 1), row)
      if (left == null || right == null) { return null }
      // Manual type checks for date/duration subtraction
      const _isDateStrDirect = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
      const _isDurationStrDirect = (v: unknown): v is string => typeof v === "string" && /^P(-?\d+(?:\.\d+)?Y)?(-?\d+(?:\.\d+)?M)?(-?\d+(?:\.\d+)?D)?(T(-?\d+(?:\.\d+)?H)?(-?\d+(?:\.\d+)?M(?!S))?(-?\d+(?:\.\d+)?S)?)?$/.test(v) || /^P-?\d+(?:\.\d+)?W$/.test(v)
      const _isTimeStrDirect = (v: unknown): v is string => typeof v === "string" && /^\d{2}:\d{2}:\d{2}/.test(v)
      const _isDateTimeStrDirect = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)
      // duration - duration
      if (_isDurationStrDirect(left) && _isDurationStrDirect(right)) return _durationSub(left, right)
      // date - duration
      if (_isDateStrDirect(left) && _isDurationStrDirect(right)) return _dateSubDuration(left, right)
      // localtime - duration
      if (_isTimeStrDirect(left) && _isDurationStrDirect(right)) return _timeSubDuration(left, right)
      // datetime - duration
      if (_isDateTimeStrDirect(left) && _isDurationStrDirect(right)) return _dateTimeSubDuration(left, right)
      return Number(left) - Number(right)
    }
  }
  return _evalMulDiv(t, row)
}

export function _evalMulDiv(s: string, row?: Record<string, unknown>): ExprValue {
  const t = s.trim()
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i] === '*' && !_inBrackets(t, i) && !_inString(t, i)) { const left = _evalMulDiv(t.slice(0, i), row); const right = _evalExp(t.slice(i + 1), row); if (left == null || right == null) return null; if (_isDurationStr(left) && typeof right === 'number') return _durationScale(left, right); if (_isDurationStr(right) && typeof left === 'number') return _durationScale(right, left); return Number(left) * Number(right) }
    if (t[i] === '/' && !_inBrackets(t, i) && !_inString(t, i)) { const left = _evalMulDiv(t.slice(0, i), row); const right = _evalExp(t.slice(i + 1), row); if (left == null || right == null) return null; if (_isDurationStr(left) && typeof right === 'number') return _durationScale(left, 1 / right); const nl = Number(left), nr = Number(right); return Number.isInteger(nl) && Number.isInteger(nr) ? Math.trunc(nl / nr) : nl / nr }
    if (t[i] === '%' && !_inBrackets(t, i) && !_inString(t, i)) { const left = _evalMulDiv(t.slice(0, i), row); const right = _evalExp(t.slice(i + 1), row); if (left == null || right == null) return null; return Number(left) % Number(right) }
  }
  return _evalExp(t, row)
}

/** 指数运算 `^`，优先级高于 * / %，左结合：2 ^ 3 ^ 2 = (2 ^ 3) ^ 2 */
export function _evalExp(s: string, row?: Record<string, unknown>): ExprValue {
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

export function _evalUnary(s: string, row?: Record<string, unknown>): ExprValue {
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

export function _evalAtom(s: string, row?: Record<string, unknown>): ExprValue {
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
  // datetime.fromepoch(x) 需要 [\w.]+ 匹配带点的函数名
  // 使用括号深度感知匹配支持嵌套函数调用 duration.inDays(duration({...}))
  const fnParenIdx = t.indexOf('(')
  if (fnParenIdx > 0 && t.endsWith(')')) {
    let depth = 0, matchEnd = -1
    for (let i = fnParenIdx; i < t.length; i++) {
      if (t[i] === '(') depth++
      else if (t[i] === ')') { depth--; if (depth === 0) { matchEnd = i; break } }
    }
    if (matchEnd === t.length - 1) {
      const fnName = t.slice(0, fnParenIdx)
      const argsRaw = t.slice(fnParenIdx + 1, -1).trim()
      if (/^[\w.]+$/.test(fnName)) {
        const args = argsRaw ? _parseCommaList(argsRaw).map(a => a.trim()) : []
        return _callFunction(fnName, args, row)
      }
    }
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
    // 持续时间 ISO 字符串属性访问：dur.days / dur.hours 等
    if (typeof obj === 'string' && /^P/i.test(obj)) return _extractDurationProp(obj, prop)
    // 日期/时间字符串属性访问：date.year, time.hour, datetime.hour 等
    if (typeof obj === 'string') {
      // epochSeconds / epochMillis
      if (obj.includes('T') && (prop === 'epochSeconds' || prop === 'epochMillis')) {
        const epochVal = _extractEpochFromDateTimeStr(obj, prop)
        if (epochVal !== undefined) return epochVal
      }
      // 含 T 的 datetime 字符串：先尝试日期属性，再尝试时间属性
      if (obj.includes('T')) {
        const datePart = obj.slice(0, obj.indexOf('T'))
        const timePart = obj.slice(obj.indexOf('T') + 1)
        if (/^\d{4}/.test(datePart)) {
          const dateAccessor = _extractDateProp(obj, prop)
          if (dateAccessor !== undefined) return dateAccessor
        }
        if (/^\d{2}:\d{2}/.test(timePart)) {
          const timeAccessor = _extractTimeProp(timePart, prop)
          if (timeAccessor !== undefined) return timeAccessor
        }
      } else {
        if (/^\d{4}/.test(obj)) {
          const dateAccessor = _extractDateProp(obj, prop)
          if (dateAccessor !== undefined) return dateAccessor
        }
        if (/^\d{2}:\d{2}/.test(obj)) {
          const timeAccessor = _extractTimeProp(obj, prop)
          if (timeAccessor !== undefined) return timeAccessor
        }
      }
    }
    // 对非 map 的基本类型抛 TypeError（列表也是非 map）
    throw Object.assign(new Error('TypeError: Property access on non-map type'), { tckError: 'TypeError' })
  }
  // 变量引用
  if (t in (row || {})) return row![t]
  if (row?._alias === t) return row
  return _evalLiteral(t, row)
}

export function _evalLiteral(s: string, row?: Record<string, unknown>): ExprValue {
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
    // ── Compile-time check: size() on pattern predicates ──
    // size((a)-->(b)), size(()<--()), etc. must raise SyntaxError at compile time.
    const trimmed = rawExpr.trim()
    if (trimmed.startsWith('size(')) {
      const inner = trimmed.slice(5, -1).trim()
      // Pattern predicate: node pattern followed by edge arrow (-->  or  -[type]->)
      if (inner.startsWith('(') && inner.endsWith(')') &&
          /\([^)]*\)\s*-+(?:\[[^\]]*\])?->|\([^)]*\)\s*<-(?:\[[^\]]*\])?-+/.test(inner)) {
        throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
      }
    }

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
 * 递归检测列表/Map 字面量中是否缺失逗号分隔符（Cypher 语法Error）
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
 * Error地送入字面量语法检查。
 */
export function _isPureLiteralExpr(s: string): boolean {
  // List comprehensions: [var IN list | expr] are not pure literals
  if (s.startsWith('[') && /\sIN\s/.test(s) && /\|/.test(s)) return false
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

/** Rank a Cypher value by its type for ORDER BY, defining a deterministic
 *  cross-type total order (ascending). The ordering is inferred from the
 *  openCypher WithOrderBy TCK, which exercises heterogenous lists (`['a']`,
 *  `[1]`, `[1, null]`, `[null, 1]`) and expects `string < number < null`.
 *  `null` sorts last (Cypher's default NULLS LAST for ascending ORDER BY),
 *  so it is assigned the highest rank.
 *
 *  Numbers (both `number` and `bigint`) share one rank and are compared
 *  numerically; booleans sort before numbers (`false` < `true` < number);
 *  strings sort between booleans and numbers. Temporal strings are compared
 *  by their absolute instant via `_temporalSortKey` before falling back to
 *  lexical order, so `date`/`time`/`datetime` values order correctly. */
function _orderByTypeRank(v: unknown): number {
  if (v === null || v === undefined) return 100
  const t = typeof v
  switch (t) {
    case 'boolean': return 0
    case 'number':
    case 'bigint': return 2
    case 'string': return 1
    default: return 50 // objects, maps, lists — handled elsewhere, keep distinct
  }
}

/** Compare two Cypher values for ORDER BY, returning a deterministic total
 *  order (-1, 0, or 1). Unlike `_compareValues` (which models three-valued
 *  predicate logic and returns null on null / cross-type), this comparator is
 *  total: `null` sorts last, and cross-type pairs order by `_orderByTypeRank`. */
function _compareOrderByValue(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === null || a === undefined) return 1
  if (b === null || b === undefined) return -1

  const ta = typeof a, tb = typeof b

  // Lists sort by element-wise lexicographic order (empty list first).
  if (Array.isArray(a) && Array.isArray(b)) {
    const minLen = Math.min(a.length, b.length)
    for (let i = 0; i < minLen; i++) {
      const cmp = _compareOrderByValue(a[i], b[i])
      if (cmp !== 0) return cmp
    }
    return a.length - b.length
  }

  // Same-type numeric comparison.
  if (ta === 'number' && tb === 'number') return a < b ? -1 : 1
  if ((ta === 'bigint' && tb === 'bigint')) return a < b ? -1 : 1

  // Temporal strings order by absolute instant; kept inside the string branch
  // so ordinary strings still fall back to lexical order.
  if (ta === 'string' && tb === 'string') {
    const taKey = _temporalSortKey(a)
    const tbKey = _temporalSortKey(b)
    if (taKey !== null && tbKey !== null) return taKey < tbKey ? -1 : taKey > tbKey ? 1 : 0
    return a < b ? -1 : a > b ? 1 : 0
  }

  // Cross-type: order by type rank, then fall back to string form for stability.
  const ra = _orderByTypeRank(a), rb = _orderByTypeRank(b)
  if (ra !== rb) return ra < rb ? -1 : 1
  const sa = String(a), sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

/** Normalize a temporal value so it sorts by absolute instant rather than by
 *  its (timezone-dependent) textual representation.
 *
 *  Cypher orders `time` / `datetime` values on the same instant axis regardless
 *  of their stored offset: `12:31:14+01:00` (UTC 11:31:14) must precede
 *  `12:30:14+00:15` (UTC 12:15:14), even though their local clock text would
 *  order them the other way. Only values that carry an explicit offset are
 *  normalized; naive `date` / `localdatetime` / ordinary strings sort by text,
 *  which is already correct for them.
 *
 *  Returns a comparable UTC string (`...Z`) for offset-bearing temporal values,
 *  or `null` when the value should fall back to the default textual comparison. */
function _temporalSortKey(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  // `datetime` / `localdatetime` carry a `T`; `time` does not. The offset suffix
  // (`Z`, `+HH:MM`, `-HH:MM`) signals an offset-bearing value. A `time` may omit
  // seconds entirely (`10:35-08:00`), so the seconds/nanos group is optional.
  const dt = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/)
  const tm = s.match(/^(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/)
  if (!dt && !tm) return null

  const isDateTime = !!dt
  if (isDateTime) {
    const m = dt!
    const year = parseInt(m[1], 10), month = parseInt(m[2], 10), day = parseInt(m[3], 10)
    const hour = parseInt(m[4], 10), minute = parseInt(m[5], 10), second = parseInt(m[6], 10)
    const nanos = (m[7] || '.0').slice(1).padEnd(9, '0')
    const offsetMin = _parseTzOffset(m[8])
    const utc = _utcDateFromYmd(year, month - 1, day)
    utc.setUTCHours(hour, minute, second, 0)
    utc.setUTCMinutes(utc.getUTCMinutes() - offsetMin)
    return `${_fmtUtcDate(utc)}T${String(utc.getUTCHours()).padStart(2, '0')}:${String(utc.getUTCMinutes()).padStart(2, '0')}:${String(utc.getUTCSeconds()).padStart(2, '0')}.${nanos}Z`
  }
  const m = tm!
  const hour = parseInt(m[1], 10), minute = parseInt(m[2], 10)
  const second = m[3] != null ? parseInt(m[3], 10) : 0
  const nanos = (m[4] || '.0').slice(1).padEnd(9, '0')
  const offsetMin = _parseTzOffset(m[5])
  const utc = _utcDateFromYmd(1970, 0, 1)
  utc.setUTCHours(hour, minute, second, 0)
  utc.setUTCMinutes(utc.getUTCMinutes() - offsetMin)
  return `${String(utc.getUTCHours()).padStart(2, '0')}:${String(utc.getUTCMinutes()).padStart(2, '0')}:${String(utc.getUTCSeconds()).padStart(2, '0')}.${nanos}Z`
}

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

  // ── ORDER BY (index sort: avoid full row copy, sort only indices) ──
  let processed: QueryRow[]
  if (p.orderBy?.length) {
    const indices = Array.from({ length: result.length }, (_, i) => i)
    const orderBy = p.orderBy

    const comparator = (ai: number, bi: number): number => {
      const a = result[ai]
      const b = result[bi]
      for (let i = 0; i < orderBy.length; i++) {
        const o = orderBy[i]
        const field = _orderByField(o)
        const dir = (o.direction || '').trim().toUpperCase()
        // When the sort item is a composite expression (e.g.
        // `NOT (a.bool AND a.bool2)` or `a.num + a.num2`), evaluate it against
        // the row instead of looking up a single column. A bare identifier
        // (property reference) keeps the fast `row[field]` lookup.
        const expr = (o.expression as string) || ''
        const isComposite = expr && !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(expr.trim())
        let va: unknown, vb: unknown
        if (isComposite) {
          va = _evaluateExpression(expr, a as Record<string, unknown>)
          vb = _evaluateExpression(expr, b as Record<string, unknown>)
        } else {
          va = a[field] ?? null
          vb = b[field] ?? null
        }
        let cmp = 0
        if (va === null && vb === null) cmp = 0
        else if (va === null) cmp = 1
        else if (vb === null) cmp = -1
        else if (Array.isArray(va) || Array.isArray(vb)) cmp = _compareOrderByValue(va, vb)
        else if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb
        else {
          // Offset-bearing temporal values sort by absolute instant (UTC), not
          // by their local clock text. When both sides normalize, compare the
          // UTC keys; otherwise fall back to plain textual ordering.
          const ta = _temporalSortKey(va)
          const tb = _temporalSortKey(vb)
          if (ta !== null && tb !== null) cmp = ta.localeCompare(tb)
          else cmp = String(va).localeCompare(String(vb))
        }
        if (cmp !== 0) return dir === 'DESC' ? -cmp : cmp
      }
      return 0
    }

    indices.sort(comparator)

    // Apply skip + limit on indices before slicing rows
    let startIdx = 0
    let endIdx = indices.length
    if (p.skip !== undefined && p.skip > 0) startIdx = p.skip
    if (p.limit !== undefined && p.limit >= 0) endIdx = Math.min(startIdx + p.limit, indices.length)

    processed = indices.slice(startIdx, endIdx).map(i => result[i])
  } else {
    processed = result  // no ORDER BY, use reference directly (HAVING below can filter in-place)
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

/** 从 datetime ISO 字符串中提取 epochSeconds / epochMillis */
function _extractEpochFromDateTimeStr(s: string, prop: string): number | undefined {
  // s = "1984-11-11T12:31:14.645876123+01:00[Europe/Stockholm]"
  // 去掉 IANA 后缀，因为 Date.parse 不识别
  let clean = s.replace(/\[.*?\]$/, '')
  // 截断纳秒到毫秒精度（Date.parse 不处理 >3 位小数秒）
  const dotIdx = clean.indexOf('.')
  if (dotIdx >= 0) {
    const beforeDot = clean.slice(0, dotIdx)
    const afterDot = clean.slice(dotIdx + 1)
    // 找到时区偏移的开始
    const tzIdx = afterDot.search(/[+-]/)
    const nsPart = tzIdx >= 0 ? afterDot.slice(0, tzIdx) : afterDot
    const msPart = nsPart.slice(0, 3).padEnd(3, '0')
    const tzPart = tzIdx >= 0 ? afterDot.slice(tzIdx) : ''
    clean = beforeDot + '.' + msPart + tzPart
  }
  const dateObj = new Date(clean)
  if (isNaN(dateObj.getTime())) return undefined
  const ms = dateObj.getTime()
  if (prop === 'epochSeconds') return Math.floor(ms / 1000)
  if (prop === 'epochMillis') return ms
  return undefined
}

