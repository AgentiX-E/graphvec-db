/**
 * graphql-adapter.ts — GraphQL Schema 实现（支持 Query + Mutation + Subscription）
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
 * 暴露 Subscription 根字段（GAP-25）：
 *   - nodeCreated: SubscriptionEvent
 *   - nodeUpdated: SubscriptionEvent
 *   - nodeDeleted: SubscriptionEvent
 *   - edgeCreated: SubscriptionEvent
 *   - edgeUpdated: SubscriptionEvent
 *   - edgeDeleted: SubscriptionEvent
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

// ── Subscription 类型 (GAP-25) ────────────────────────────

export enum SubscriptionEventType {
  NODE_CREATED = 'nodeCreated',
  NODE_UPDATED = 'nodeUpdated',
  NODE_DELETED = 'nodeDeleted',
  EDGE_CREATED = 'edgeCreated',
  EDGE_UPDATED = 'edgeUpdated',
  EDGE_DELETED = 'edgeDeleted',
}

export interface SubscriptionResolver {
  /** 订阅事件的 SSE 主题名 */
  sseEvent: string
  /** 获取订阅参数配置 */
  getSubscribeArgs?: () => { events: string }
}

/**
 * Subscription 解析器映射
 * key = GraphQL 字段名, value = 对应的 SSE 事件类型
 */
export interface SubscriptionResolvers {
  /** 获取指定 subscription 字段对应的 SSE 事件名 */
  getSSEEvent: (fieldName: string) => string | null
  /** 列出所有支持的 subscription 字段 */
  listFields: () => string[]
  /** 获取订阅参数 */
  getSubscribeOptions: (fieldName: string) => { events: string }
}

/**
 * 默认 Subscription 解析器
 */
export const DEFAULT_SUBSCRIPTION_RESOLVERS: SubscriptionResolvers = {
  getSSEEvent(fieldName: string): string | null {
    const map: Record<string, string> = {
      nodeCreated: 'node:created',
      nodeUpdated: 'node:updated',
      nodeDeleted: 'node:deleted',
      edgeCreated: 'edge:created',
      edgeUpdated: 'edge:updated',
      edgeDeleted: 'edge:deleted',
    }
    return map[fieldName] ?? null
  },

  listFields(): string[] {
    return [
      'nodeCreated',
      'nodeUpdated',
      'nodeDeleted',
      'edgeCreated',
      'edgeUpdated',
      'edgeDeleted',
    ]
  },

  getSubscribeOptions(fieldName: string): { events: string } {
    const eventMap: Record<string, string> = {
      nodeCreated: 'node:created',
      nodeUpdated: 'node:updated',
      nodeDeleted: 'node:deleted',
      edgeCreated: 'edge:created',
      edgeUpdated: 'edge:updated',
      edgeDeleted: 'edge:deleted',
    }
    const event = eventMap[fieldName] ?? ''
    return { events: event }
  },
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
  /** Subscription 解析器 (GAP-25) */
  private subscriptionResolvers: SubscriptionResolvers | null

  constructor(
    resolvers: ResolverMap,
    mutationResolvers?: MutationResolvers,
    subscriptionResolvers?: SubscriptionResolvers,
  ) {
    this.resolvers = resolvers
    this.mutationResolvers = mutationResolvers ?? null
    this.subscriptionResolvers = subscriptionResolvers ?? null
  }

  /**
   * 获取当前操作类型的 resolvers
   */
  get MutationResolvers(): MutationResolvers | null {
    return this.mutationResolvers
  }

  /**
   * 获取 Subscription 解析器
   */
  get SubscriptionResolvers(): SubscriptionResolvers | null {
    return this.subscriptionResolvers
  }

  /**
   * 执行 GraphQL 查询、mutation 或 subscription
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
   *
   * 支持的 subscription 格式（GAP-25，需要 subscriptionResolvers）：
   *   { nodeCreated { type timestamp nodeId data } }
   *   { edgesCreated { data { src dst type } } }
   */
  async execute(query: string): Promise<Record<string, unknown>> {
    const trimmed = query.trim()

    // 检测操作类型前缀
    const operationType = this._detectOperationType(trimmed)

    // 外层的 { ... }
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      return this._parseOperation(trimmed.slice(1, -1).trim(), operationType)
    }

    throw new Error(`Invalid GraphQL query: must be wrapped in braces`)
  }

  /**
   * 获取 Schema 定义字符串（SDL），包含 mutation 和 subscription 类型
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

    if (this.subscriptionResolvers) {
      sdl += `
type Subscription {
  nodeCreated(events: String): SubscriptionEvent
  nodeUpdated(events: String): SubscriptionEvent
  nodeDeleted(events: String): SubscriptionEvent
  edgeCreated(events: String): SubscriptionEvent
  edgeUpdated(events: String): SubscriptionEvent
  edgeDeleted(events: String): SubscriptionEvent
}

type SubscriptionEvent {
  type: String!
  timestamp: Float!
  nodeId: String!
  data: JSON!
}
`
    }

    return sdl
  }

  // ── 操作类型检测 ───────────────────────────────────

  /**
   * 检测操作类型：query / mutation / subscription
   * 通过检查操作中的字段名来判断
   */
  private _detectOperationType(query: string): 'query' | 'mutation' | 'subscription' {
    // 显式操作类型前缀
    if (query.startsWith('mutation')) return 'mutation'
    if (query.startsWith('subscription')) return 'subscription'
    if (query.startsWith('query')) return 'query'

    // 从字段名推断 - 提取括号前的第一个词
    // 对于 { nodeCreated { ... } } 这种没有操作类型前缀的写法
    if (query.startsWith('{')) {
      const inner = query.slice(1).trim()
      const fieldMatch = inner.match(/^(\w+)/)
      if (fieldMatch) {
        const fieldName = fieldMatch[1]
        // 检查是否属于 subscription 字段
        if (this.subscriptionResolvers) {
          const subsFields = this.subscriptionResolvers.listFields()
          if (subsFields.includes(fieldName)) {
            return 'subscription'
          }
        }
        // 检查是否属于 mutation 字段
        if (this.mutationResolvers) {
          const mutationFields = ['createNode', 'createEdge', 'updateNode', 'deleteNode', 'deleteEdge']
          if (mutationFields.includes(fieldName)) {
            return 'mutation'
          }
        }
      }
    }

    return 'query'
  }

  // ── 解析器 ────────────────────────────────────────────

  /**
   * 解析单个操作：`nodes(label: "Person", limit: 10) { id name }`
   *
   * 返回格式：{ nodes: [ { id: 1, name: ... }, ... ] }
   */
  private async _parseOperation(
    op: string,
    operationType: 'query' | 'mutation' | 'subscription' = 'query',
  ): Promise<Record<string, unknown>> {
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
      const value = await this._resolveField(fieldName, args, subFields, operationType)
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

      // 跳过嵌套选择
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
   * 根据字段名和操作类型调用对应的 resolver
   */
  private async _resolveField(
    fieldName: string,
    args: Record<string, unknown>,
    subFields: string[],
    operationType: 'query' | 'mutation' | 'subscription' = 'query',
  ): Promise<unknown> {
    // ── Subscription (GAP-25) ──
    if (operationType === 'subscription' && this.subscriptionResolvers) {
      const sseEvent = this.subscriptionResolvers.getSSEEvent(fieldName)
      if (sseEvent) {
        // 返回 SSE 配置信息，供调用方在 GraphQLSubscription 中订阅
        return {
          _subscriptionEvent: sseEvent,
          _options: this.subscriptionResolvers.getSubscribeOptions(fieldName),
        }
      }
    }

    // 获取底层 resolver 函数并执行
    const resolver = await this._getResolver(fieldName)
    if (!resolver) {
      throw new Error(`Unknown field: ${fieldName}`)
    }

    const raw = await resolver(args, subFields)
    return raw
  }

  /**
   * 获取 resolver 函数
   */
  private async _getResolver(
    fieldName: string,
  ): Promise<((args: Record<string, unknown>, subFields: string[]) => unknown) | null> {
    // Query resolvers
    switch (fieldName) {
      case 'nodes':
        return async (args: Record<string, unknown>, subFields: string[]) => {
          const raw = await this.resolvers.nodes({
            label: args.label as string | undefined,
            limit: args.limit as number | undefined,
          })
          return this._projectFields(raw, subFields)
        }
      case 'edges':
        return async (args: Record<string, unknown>, subFields: string[]) => {
          const raw = await this.resolvers.edges({
            type: args.type as string | undefined,
          })
          return this._projectFields(raw, subFields)
        }
      case 'query':
        return async (args: Record<string, unknown>) => {
          return this.resolvers.query({
            cypher: args.cypher as string,
          })
        }
    }

    // Mutation resolvers
    if (this.mutationResolvers) {
      switch (fieldName) {
        case 'createNode':
          return async (args: Record<string, unknown>) => {
            return this.mutationResolvers!.createNode({
              name: args.name as string,
              type: args.type as number | undefined,
              props: args.props as Record<string, unknown> | undefined,
            })
          }
        case 'createEdge':
          return async (args: Record<string, unknown>) => {
            return this.mutationResolvers!.createEdge({
              src: args.src as number,
              dst: args.dst as number,
              type: args.type as number,
              props: args.props as Record<string, unknown> | undefined,
            })
          }
        case 'updateNode':
          return async (args: Record<string, unknown>) => {
            return this.mutationResolvers!.updateNode({
              id: args.id as number,
              name: args.name as string | undefined,
              props: args.props as Record<string, unknown> | undefined,
            })
          }
        case 'deleteNode':
          return async (args: Record<string, unknown>) => {
            return this.mutationResolvers!.deleteNode({
              id: args.id as number,
            })
          }
        case 'deleteEdge':
          return async (args: Record<string, unknown>) => {
            return this.mutationResolvers!.deleteEdge({
              src: args.src as number,
              dst: args.dst as number,
              type: args.type as number,
            })
          }
      }
    }

    return null
  }

  /**
   * 对结果进行字段投影（根据 subFields 过滤）
   */
  private _projectFields(raw: unknown, subFields: string[]): unknown {
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
}
