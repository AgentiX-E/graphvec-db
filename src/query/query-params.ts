/**
 * query-params.ts — 预编译参数化查询
 *
 * 从 query-engine.ts 拆分。
 * 提供 ParameterizedQuery / cypher / compileCypher。
 */

import { parseQuery } from './query-engine'
import type { QueryPlan } from './query-types'

// ── 缓存 ──
const _compileCache = new Map<string, string[]>()

// ── 参数工具函数（与 query-engine.ts 共享） ──

/**
 * 安全地转义字符串值，防止 Cypher 注入。
 */
function escapeString(val: string): string {
  const cleaned = val.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
  if (cleaned.includes("'") && !cleaned.includes('"')) {
    return `"${cleaned}"`
  }
  if (cleaned.includes("'") && cleaned.includes('"')) {
    const sanitized = cleaned.replace(/['"]/g, '')
    return `'${sanitized}'`
  }
  return `'${cleaned}'`
}

/**
 * 序列化参数值为 Cypher-lite 查询可安全嵌入的字符串。
 */
function serializeParamValue(val: unknown): string {
  if (typeof val === 'string') return escapeString(val)
  if (typeof val === 'number' || typeof val === 'boolean') return String(val)
  if (val === null || val === undefined) return 'null'
  if (Array.isArray(val)) return `[${val.map(serializeParamValue).join(', ')}]`
  return escapeString(JSON.stringify(val))
}

/**
 * 从模板中提取所有 `$var` 参数名称
 */
function _extractParamNames(template: string): string[] {
  const names: string[] = []
  const re = /\$([a-zA-Z_]\w*)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(template)) !== null) {
    names.push(match[1])
  }
  return names
}

/**
 * 将参数值注入到模板中，返回可直接解析的 Cypher-lite 字符串。
 */
function _injectParams(template: string, params: Record<string, unknown>): string {
  const re = /\$([a-zA-Z_]\w*)/g
  return template.replace(re, (_, name: string) => {
    if (!(name in params)) throw new Error(`Missing parameter: $${name}`)
    return serializeParamValue(params[name])
  })
}

// ── 预编译参数化查询类 ──

export class ParameterizedQuery {
  private readonly template: string
  private paramNames: string[] | null = null

  constructor(template: string) {
    this.template = template
  }

  getParamNames(): string[] {
    if (this.paramNames === null) {
      const cached = _compileCache.get(this.template)
      if (cached) {
        this.paramNames = cached
      } else {
        this.paramNames = _extractParamNames(this.template)
        _compileCache.set(this.template, this.paramNames)
      }
    }
    return [...this.paramNames]
  }

  hasParam(name: string): boolean {
    return this.getParamNames().includes(name)
  }

  execute(params: Record<string, unknown>): QueryPlan {
    const paramNames = this.getParamNames()
    if (paramNames.length === 0) return parseQuery(this.template)
    const injected = _injectParams(this.template, params)
    return parseQuery(injected)
  }
}

// ── 便捷函数 ──

export function cypher(template: string, params?: Record<string, unknown>): QueryPlan {
  if (!params || Object.keys(params).length === 0) return parseQuery(template)
  const injected = _injectParams(template, params)
  return parseQuery(injected)
}

export function compileCypher(template: string): ParameterizedQuery {
  return new ParameterizedQuery(template)
}
