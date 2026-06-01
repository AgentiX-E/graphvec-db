/**
 * graphql-adapter.ts — GraphQL Schema 实现（支持 Query + Mutation）
 *
 * 纯手动解析的 GraphQL 适配层，不引入 graphql npm 包。
 * 暴露 Query 根字段：
 *   - nodes(label: String, limit: Int): [Node]
 *   - edges(type: String): [Edge]
 *   - query(cypher: String): JSON
 *
 * 暴露 Mutation 根字段：
 *   - createNode(name: String!, type: Int, props: JSON): Node
 *   - createEdge(src: Int!, dst: Int!, type: Int!, props: JSON): Edge
 *   - updateNode(id: Int!, name: String, props: JSON): Node
 *   - deleteNode(id: Int!): Boolean
 *   - deleteEdge(src: Int!, dst: Int!, type: Int!): Boolean
 *
 * 接口设计为可对接任意后端引擎，通过 ResolverMap 注入。
 */

import { NodeRecord, EdgeRecord } from '../types'

// ── Schema 类型定义 ────────────────────────────────────────

export interface GraphQLField {
  name: string
  type: string
  args?: Array<{ name: string; type: string }>
  resolver: (args: Record<string, unknown>, context?: unknown) => unknown | Promise<unknown>
}

export interface ResolverMap {
  nodes: (args: { label?: string; limit?: number }) => NodeRecord[] | Promise<NodeRecord[]>
  edges: (args: { type?: string }) => EdgeRecord[] | Promise<EdgeRecord[]>
  query: (args: { cypher: string }) => unknown | Promise<unknown>
}

// ── Mutation Resolver 类型 ────────────────────────────────

export type NodeInput = { name: string; type?: number; props?: Record<string, unknown> }
export type EdgeInput = { src: number; dst: number; type: number; props?: Record<string, unknown> }
export type NodeUpdateInput = { id: number; name?: string; props?: Record<string, unknown> }
export type DeleteNodeInput = { id: number }
export type DeleteEdgeInput = { src: number; dst: number; type: number }

export interface MutationResolvers {
  createNode: (args: NodeInput) => NodeRecord | Promise<NodeRecord>
  createEdge: (args: EdgeInput) => EdgeRecord | Promise<EdgeRecord>
  updateNode: (args: NodeUpdateInput) => NodeRecord | Promise<NodeRecord>
  deleteNode: (args: DeleteNodeInput) => boolean | Promise<boolean>
  deleteEdge: (args: DeleteEdgeInput) => boolean | Promise<boolean>
}

/**
 * GraphQL 适配器
 *
 * 用法：
 * ```ts
 * const adapter = new GraphQLAdapter(resolvers)
 * const result = adapter.execute('{ nodes(label: "Person", limit: 10) { id name } }')
 * ```
 */
export class GraphQLAdapter {
  private resolvers: ResolverMap
  private mutationResolvers: MutationResolvers | null

  constructor(resolvers: ResolverMap, mutationResolvers?: MutationResolvers) {
    this.resolvers = resolvers
    this.mutationResolvers = mutationResolvers ?? null
  }

  /**
   * 执行 GraphQL 查询或 mutation
   *
   * 支持的查询格式：
   *   { nodes(label: "Person", limit: 10) { id name } }
   *   { edges(type: "RELATED") { src dst } }
   *   { query(cypher: "MATCH (n) RETURN n") }
   *
   * 支持的 mutation 格式（需要 mutationResolvers）：
   *   { createNode(name: "Alice", type: 1) { id name } }
   *   { createEdge(src: 1, dst: 2, type: 10) { src dst type } }
   *   { updateNode(id: 1, name: "Bob") { id name } }
   *   { deleteNode(id: 1) }
   *   { deleteEdge(src: 1, dst: 2, type: 10) }
   */
  async execute(query: string): Promise<Record<string, unknown>> {
    const trimmed = query.trim()

    // 外层的 { ... }
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      return this._parseOperation(trimmed.slice(1, -1).trim())
    }

    throw new Error(`Invalid GraphQL query: must be wrapped in braces`)
  }

  /**
   * 获取 Schema 定义字符串（SDL），包含 mutation 类型
   */
  getSchemaSDL(): string {
    let sdl = `
type Query {
  nodes(label: String, limit: Int): [Node]
  edges(type: String): [Edge]
  query(cypher: String): JSON
}

type Node {
  id: Int!
  type: Int!
  name: String!
  props: JSON
}

type Edge {
  src: Int!
  dst: Int!
  type: Int!
  props: JSON
}

scalar JSON
`

    if (this.mutationResolvers) {
      sdl += `
type Mutation {
  createNode(name: String!, type: Int, props: JSON): Node
  createEdge(src: Int!, dst: Int!, type: Int!, props: JSON): Edge
  updateNode(id: Int!, name: String, props: JSON): Node
  deleteNode(id: Int!): Boolean
  deleteEdge(src: Int!, dst: Int!, type: Int!): Boolean
}
`
    }

    return sdl
  }

  // ── 解析器 ────────────────────────────────────────────

  /**
   * 解析单个操作：`nodes(label: "Person", limit: 10) { id name }`
   *
   * 返回格式：{ nodes: [ { id: 1, name: ... }, ... ] }
   */
  private async _parseOperation(op: string): Promise<Record<string, unknown>> {
    let remaining = op.trim()

    const result: Record<string, unknown> = {}

    while (remaining.length > 0) {
      // 提取字段名
      const fieldMatch = remaining.match(/^(\w+)/)
      if (!fieldMatch) {
        // 跳过空白和无法解析的字符
        remaining = remaining.replace(/^[\s,]+/, '')
        if (remaining.length === 0) break
        throw new Error(`Cannot parse field at: "${remaining.slice(0, 30)}..."`)
      }

      const fieldName = fieldMatch[1]
      remaining = remaining.slice(fieldName.length).trim()

      // 提取参数（括号内）
      let args: Record<string, unknown> = {}
      if (remaining.startsWith('(')) {
        const closeParen = this._findMatchingParen(remaining)
        const argStr = remaining.slice(1, closeParen)
        args = this._parseArgs(argStr)
        remaining = remaining.slice(closeParen + 1).trim()
      }

      // 提取子字段选择（大括号内）
      let subFields: string[] = []
      if (remaining.startsWith('{')) {
        const closeBrace = this._findMatchingBrace(remaining)
        const subStr = remaining.slice(1, closeBrace)
        subFields = this._parseSubFields(subStr)
        remaining = remaining.slice(closeBrace + 1).trim()
      }

      // 调用 resolver
      const value = await this._resolveField(fieldName, args, subFields)
      result[fieldName] = value

      // 跳过逗号
      remaining = remaining.replace(/^,\s*/, '')
    }

    return result
  }

  /**
   * 解析参数列表
   * 例如 `label: "Person", limit: 10` → { label: "Person", limit: 10 }
   */
  private _parseArgs(argStr: string): Record<string, unknown> {
    const args: Record<string, unknown> = {}
    const trimmed = argStr.trim()
    if (!trimmed) return args

    // 按逗号分隔参数
    let remaining = trimmed
    while (remaining.length > 0) {
      remaining = remaining.trim()
      if (remaining.length === 0) break

      const match = remaining.match(/^(\w+)\s*:\s*/)
      if (!match) throw new Error(`Cannot parse argument: "${remaining.slice(0, 20)}..."`)

      const key = match[1]
      remaining = remaining.slice(match[0].length).trim()

      const { value, rest } = this._parseValue(remaining)
      args[key] = value
      remaining = rest.replace(/^,\s*/, '')
    }

    return args
  }

  /**
   * 解析单个 GraphQL 值
   */
  private _parseValue(str: string): { value: unknown; rest: string } {
    str = str.trim()

    if (str.startsWith('"') || str.startsWith("'")) {
      const quote = str[0]
      const endIdx = str.indexOf(quote, 1)
      if (endIdx < 0) throw new Error('Unterminated string')
      return { value: str.slice(1, endIdx), rest: str.slice(endIdx + 1) }
    }

    if (str.startsWith('true') || str.startsWith('false')) {
      const match = str.match(/^(true|false)/)
      return { value: match![1] === 'true', rest: str.slice(match![0].length) }
    }

    if (str.startsWith('null')) {
      return { value: null, rest: str.slice(4) }
    }

    // 数字
    const numMatch = str.match(/^(-?\d+(?:\.\d+)?)/)
    if (numMatch) {
      const raw = numMatch[1]
      return { value: raw.includes('.') ? parseFloat(raw) : parseInt(raw, 10), rest: str.slice(raw.length) }
    }

    throw new Error(`Cannot parse value at: "${str.slice(0, 20)}..."`)
  }

  /**
   * 解析子字段选择
   * 例如 `id name props { key }` → ['id', 'name', 'props']
   * 简化：只取顶层的字段名，忽略嵌套选择
   */
  private _parseSubFields(subStr: string): string[] {
    const fields: string[] = []
    let remaining = subStr.trim()

    while (remaining.length > 0) {
      remaining = remaining.replace(/^[\s,]+/, '')
      if (remaining.length === 0) break

      const match = remaining.match(/^(\w+)/)
      if (!match) break

      const fieldName = match[1]
      fields.push(fieldName)
      remaining = remaining.slice(fieldName.length).trim()

      // 跳过嵌套选择（当前简化版忽略）
      if (remaining.startsWith('{')) {
        const close = this._findMatchingBrace(remaining)
        remaining = remaining.slice(close + 1).trim()
      } else if (remaining.startsWith('(')) {
        const close = this._findMatchingParen(remaining)
        remaining = remaining.slice(close + 1).trim()
      }
    }

    return fields
  }

  /**
   * 查找匹配的闭括号 `)`
   */
  private _findMatchingParen(str: string): number {
    let depth = 0
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '(') depth++
      if (str[i] === ')') {
        depth--
        if (depth === 0) return i
      }
    }
    throw new Error('Unmatched opening parenthesis')
  }

  /**
   * 查找匹配的闭大括号 `}`
   */
  private _findMatchingBrace(str: string): number {
    let depth = 0
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '{') depth++
      if (str[i] === '}') {
        depth--
        if (depth === 0) return i
      }
    }
    throw new Error('Unmatched opening brace')
  }

  /**
   * 根据字段名调用对应的 resolver
   */
  private async _resolveField(
    fieldName: string,
    args: Record<string, unknown>,
    subFields: string[],
  ): Promise<unknown> {
    const resolverMap = await this._getResolver(fieldName)
    if (!resolverMap) {
      throw new Error(`Unknown field: ${fieldName}`)
    }

    const raw = await resolverMap(args)

    // 如果指定了子字段选择，对结果进行投影
    if (subFields.length > 0 && Array.isArray(raw) && raw.length > 0) {
      return raw.map((item: Record<string, unknown>) => {
        const projected: Record<string, unknown> = {}
        for (const f of subFields) {
          if (f in item) projected[f] = item[f]
        }
        return projected
      })
    }

    return raw
  }

  private async _getResolver(fieldName: string): Promise<((args: Record<string, unknown>) => unknown) | null> {
    // Query resolvers
    switch (fieldName) {
      case 'nodes':
        return (args: Record<string, unknown>) => this.resolvers.nodes({
          label: args.label as string | undefined,
          limit: args.limit as number | undefined,
        })
      case 'edges':
        return (args: Record<string, unknown>) => this.resolvers.edges({
          type: args.type as string | undefined,
        })
      case 'query':
        return (args: Record<string, unknown>) => this.resolvers.query({
          cypher: args.cypher as string,
        })
    }

    // Mutation resolvers
    if (this.mutationResolvers) {
      switch (fieldName) {
        case 'createNode':
          return (args: Record<string, unknown>) => this.mutationResolvers!.createNode({
            name: args.name as string,
            type: args.type as number | undefined,
            props: args.props as Record<string, unknown> | undefined,
          })
        case 'createEdge':
          return (args: Record<string, unknown>) => this.mutationResolvers!.createEdge({
            src: args.src as number,
            dst: args.dst as number,
            type: args.type as number,
            props: args.props as Record<string, unknown> | undefined,
          })
        case 'updateNode':
          return (args: Record<string, unknown>) => this.mutationResolvers!.updateNode({
            id: args.id as number,
            name: args.name as string | undefined,
            props: args.props as Record<string, unknown> | undefined,
          })
        case 'deleteNode':
          return (args: Record<string, unknown>) => this.mutationResolvers!.deleteNode({
            id: args.id as number,
          })
        case 'deleteEdge':
          return (args: Record<string, unknown>) => this.mutationResolvers!.deleteEdge({
            src: args.src as number,
            dst: args.dst as number,
            type: args.type as number,
          })
      }
    }

    return null
  }
}
