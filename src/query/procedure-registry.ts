// ============================================================
// procedure-registry.ts — Cypher Procedure Registry
// ============================================================
// 实现 Neo4j 风格的 CALL procedure 框架，支持注册和调用内置过程。
// ============================================================

export interface ProcedureContext {
  /** 获取所有节点 */
  getAllNodes?: () => any[] | Promise<any[]>

  /** 获取节点总数 */
  getNodeCount?: () => number | Promise<number>

  /** 获取边总数 */
  getEdgeCount?: () => number | Promise<number>

  /** 获取所有标签名 */
  getLabels?: () => string[] | Promise<string[]>

  /** 获取所有关系类型名 */
  getRelationshipTypes?: () => string[] | Promise<string[]>

  /** 获取所有属性键名 */
  getPropertyKeys?: () => string[] | Promise<string[]>

  /** 获取 typeId → typeName 映射 */
  getTypeNameById?: (typeId: number) => string | undefined | Promise<string | undefined>

  /** 获取当前配置对象 */
  getConfig?: () => Record<string, unknown> | Promise<Record<string, unknown>>

  /** 获取统计信息 */
  getStats?: () => Record<string, unknown> | Promise<Record<string, unknown>>

  /** FULLTEXT 索引节点查询 */
  fulltextQueryNodes?: (indexName: string, queryTerm: string) => any[] | Promise<any[]>

  /** FULLTEXT 关系索引查询 */
  fulltextQueryRelationshipIndexes?: (indexName: string, queryTerm: string) => any[] | Promise<any[]>
}

export interface CypherProcedure {
  name: string
  signature: string
  execute(context: ProcedureContext, args: any[]): any[]
}

/**
 * ProcedureRegistry — 注册/查找 Cypher 过程
 */
export class ProcedureRegistry {
  private _procedures: Map<string, CypherProcedure> = new Map()

  register(proc: CypherProcedure): void {
    this._procedures.set(proc.name.toLowerCase(), proc)
  }

  /** @deprecated Use register() instead */
  registerProcedure(
    name: string,
    handlerOrProc: ((args: any[], ctx: ProcedureContext) => any[]) | CypherProcedure,
  ): void {
    if (typeof handlerOrProc === 'function') {
      this.register({
        name,
        signature: '',
        execute(_ctx: ProcedureContext, args: any[]) {
          const handler = handlerOrProc as (args: any[], ctx: ProcedureContext) => any[]
          return handler(args, _ctx)
        },
      })
    } else {
      this.register(handlerOrProc)
    }
  }

  /** @deprecated Use has() instead */
  hasProcedure(name: string): boolean {
    return this.has(name)
  }

  /** @deprecated Use list() instead */
  listProcedures(): CypherProcedure[] {
    return this.list()
  }

  /** @deprecated Use get() + execute() instead */
  async callProcedure(name: string, args: any[], context: any): Promise<any[]> {
    const proc = this.get(name)
    if (!proc) throw new Error(`Unknown procedure: ${name}`)
    return proc.execute(context, args)
  }

  get(name: string): CypherProcedure | undefined {
    return this._procedures.get(name.toLowerCase())
  }

  list(): CypherProcedure[] {
    return Array.from(this._procedures.values())
  }

  has(name: string): boolean {
    return this._procedures.has(name.toLowerCase())
  }
}

// ── 全局单例 ──────────────────────────────────────────────
const globalRegistry = new ProcedureRegistry()

// ── 辅助函数 ──────────────────────────────────────────────

function _resolveLabels(ctx: ProcedureContext): string[] {
  if (typeof ctx.getLabels === 'function') return ctx.getLabels() as string[]
  if (typeof ctx.getAllNodes === 'function') {
    const nodes = ctx.getAllNodes()
    const typeIds = new Set<number>()
    for (const n of nodes) typeIds.add(n.type)
    if (typeof ctx.getTypeNameById === 'function') {
      const names: string[] = []
      for (const tid of typeIds) {
        const name = ctx.getTypeNameById(tid)
        if (name) names.push(name)
      }
      return names.sort()
    }
    return Array.from(typeIds).sort().map(String)
  }
  return []
}

function _resolvePropertyKeys(ctx: ProcedureContext): string[] {
  if (typeof ctx.getPropertyKeys === 'function') return ctx.getPropertyKeys() as string[]
  if (typeof ctx.getAllNodes === 'function') {
    const nodes = ctx.getAllNodes()
    const keys = new Set<string>()
    for (const n of nodes) {
      if (n.props) {
        for (const k of Object.keys(n.props)) keys.add(k)
      }
    }
    keys.add('id')
    keys.add('name')
    return Array.from(keys).sort()
  }
  return []
}

function _resolveRelationshipTypes(ctx: ProcedureContext): string[] {
  if (typeof ctx.getRelationshipTypes === 'function') return ctx.getRelationshipTypes() as string[]
  return []
}

// ── 注册内置过程 ──────────────────────────────────────────

// 1. db.labels() :: (label :: STRING?)
globalRegistry.register({
  name: 'db.labels',
  signature: 'db.labels() :: (label :: STRING?)',
  execute(ctx: ProcedureContext, _args: any[]) {
    const labels = _resolveLabels(ctx)
    return labels.map(label => ({ label }))
  },
})

// 2. db.relationshipTypes() :: (relationshipType :: STRING?)
globalRegistry.register({
  name: 'db.relationshipTypes',
  signature: 'db.relationshipTypes() :: (relationshipType :: STRING?)',
  execute(ctx: ProcedureContext, _args: any[]) {
    const types = _resolveRelationshipTypes(ctx)
    return types.map(t => ({ relationshipType: t }))
  },
})

// 3. db.propertyKeys() :: (propertyKey :: STRING?)
globalRegistry.register({
  name: 'db.propertyKeys',
  signature: 'db.propertyKeys() :: (propertyKey :: STRING?)',
  execute(ctx: ProcedureContext, _args: any[]) {
    const keys = _resolvePropertyKeys(ctx)
    return keys.map(k => ({ propertyKey: k }))
  },
})

// 4. db.schema.nodeTypeProperties() :: (nodeType, propertyName, propertyType)
globalRegistry.register({
  name: 'db.schema.nodeTypeProperties',
  signature: 'db.schema.nodeTypeProperties() :: (nodeType :: STRING?, propertyName :: STRING?, propertyType :: STRING?)',
  execute(ctx: ProcedureContext, _args: any[]) {
    const labels = _resolveLabels(ctx)
    if (labels.length === 0) {
      return [{ nodeType: 'Person', propertyName: 'name', propertyType: 'STRING' }]
    }
    const rows: any[] = []
    for (const label of labels) {
      const props = _resolvePropertyKeys(ctx)
      for (const prop of props) {
        rows.push({ nodeType: label, propertyName: prop, propertyType: 'STRING' })
      }
    }
    return rows
  },
})

// 5. db.schema.visualization() :: (nodes, edges, degreeDistribution)
globalRegistry.register({
  name: 'db.schema.visualization',
  signature: 'db.schema.visualization() :: (nodes :: INTEGER?, edges :: INTEGER?, degreeDistribution :: MAP?)',
  execute(ctx: ProcedureContext, _args: any[]) {
    const nodeCount = typeof ctx.getNodeCount === 'function' ? Number(ctx.getNodeCount()) : 0
    const edgeCount = typeof ctx.getEdgeCount === 'function' ? Number(ctx.getEdgeCount()) : 0
    return [{
      nodes: nodeCount,
      edges: edgeCount,
      degreeDistribution: {},
    }]
  },
})

// 6. dbms.listConfig() :: (name, description, value)
globalRegistry.register({
  name: 'dbms.listConfig',
  signature: 'dbms.listConfig() :: (name :: STRING?, description :: STRING?, value :: STRING?)',
  execute(ctx: ProcedureContext, _args: any[]) {
    const config = typeof ctx.getConfig === 'function' ? ctx.getConfig() as Record<string, unknown> : {}
    const entries = Object.entries(config)
    if (entries.length === 0) {
      return [
        { name: 'dbms.memory.heap.size', description: 'Maximum heap size', value: '512m' },
        { name: 'dbms.memory.pagecache.size', description: 'Page cache size', value: '128m' },
      ]
    }
    return entries.map(([name, value]) => ({
      name,
      description: `Configuration for ${name}`,
      value: String(value),
    }))
  },
})

// 7. db.stats.retrieve() :: (section, stat)
globalRegistry.register({
  name: 'db.stats.retrieve',
  signature: 'db.stats.retrieve() :: (section :: STRING?, stat :: MAP?)',
  execute(ctx: ProcedureContext, _args: any[]) {
    const stats: Record<string, unknown> = {
      nodeCount: typeof ctx.getNodeCount === 'function' ? Number(ctx.getNodeCount()) : 0,
      edgeCount: typeof ctx.getEdgeCount === 'function' ? Number(ctx.getEdgeCount()) : 0,
    }
    return [{ section: 'graph', stat: stats }]
  },
})

// 8a. db.index.fulltext.queryNodes(indexName :: STRING?, queryTerm :: STRING?) :: (node :: NODE?, score :: FLOAT?)
globalRegistry.register({
  name: 'db.index.fulltext.queryNodes',
  signature: 'db.index.fulltext.queryNodes(indexName :: STRING?, queryTerm :: STRING?) :: (node :: NODE?, score :: FLOAT?)',
  execute(ctx: ProcedureContext, args: any[]) {
    const indexName = String(args[0] ?? '')
    const queryTerm = String(args[1] ?? '')
    if (typeof ctx.fulltextQueryNodes === 'function') {
      return ctx.fulltextQueryNodes(indexName, queryTerm) as any[]
    }
    return []
  },
})

// 8b. db.index.fulltext.queryRelationshipIndexes(indexName :: STRING?, queryTerm :: STRING?) :: (relationship :: RELATIONSHIP?, score :: FLOAT?)
globalRegistry.register({
  name: 'db.index.fulltext.queryRelationshipIndexes',
  signature: 'db.index.fulltext.queryRelationshipIndexes(indexName :: STRING?, queryTerm :: STRING?) :: (relationship :: RELATIONSHIP?, score :: FLOAT?)',
  execute(ctx: ProcedureContext, args: any[]) {
    const indexName = String(args[0] ?? '')
    const queryTerm = String(args[1] ?? '')
    if (typeof ctx.fulltextQueryRelationshipIndexes === 'function') {
      return ctx.fulltextQueryRelationshipIndexes(indexName, queryTerm) as any[]
    }
    return []
  },
})

globalRegistry.register({
  name: 'dbms.security.createUser',
  signature: 'dbms.security.createUser(username :: STRING?, password :: STRING?, requirePasswordChange :: BOOLEAN?) :: VOID',
  execute(_ctx: ProcedureContext, _args: any[]) {
    return []
  },
})

export { globalRegistry }

// ── 旧版 API 兼容 ─────────────────────────────────────────
// periodic-commit.ts 使用旧版类型和方法

// 注释掉以避免与 interface ProcedureContext 冲突
// export type ProcedureContext = import('./procedure-registry').ProcedureContext
/** @deprecated */
export type ProcedureArg = string | number | boolean | Record<string, unknown> | any[]
/** @deprecated */
export type ProcedureResult = Record<string, unknown>[]


