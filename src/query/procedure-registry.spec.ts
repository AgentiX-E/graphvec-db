// ============================================================
// procedure-registry.spec.ts — Cypher Procedure Registry Tests
// ============================================================

import { ProcedureRegistry, globalRegistry } from './procedure-registry'
import { parseQuery, _executeQuery } from './query-engine'

// ── Test only图数据 ──────────────────────────────────────────

const testGraph = [
  { _id: 'p1', _label: 'Person', name: 'Alice', age: 30 },
  { _id: 'p2', _label: 'Person', name: 'Bob', age: 25 },
  { _id: 'p3', _label: 'Pet', name: 'Whiskers', type: 'cat' },
  { _id: 'p4', _label: 'Pet', name: 'Buddy', type: 'dog' },
]

// ── 1. Registry 基础 API ──────────────────────────────────

describe('ProcedureRegistry', function() {
  it('register — 注册和获取过程', function() {
    const registry = new ProcedureRegistry()
    const proc = {
      name: 'my.test',
      signature: 'my.test() :: (x :: INTEGER?)',
      execute() { return [] },
    }
    registry.register(proc)

    expect(registry.has('my.test')).toBe(true)
    expect(registry.has('MY.TEST')).toBe(true) // case insensitive
    expect(registry.get('my.test')).toBe(proc)
    expect(registry.get('my.test')).toBeDefined()
  })

  it('get — 不存在的返回 undefined', function() {
    const registry = new ProcedureRegistry()
    expect(registry.get('nonexistent')).toBeUndefined()
    expect(registry.has('nonexistent')).toBe(false)
  })

  it('list — 列出所有已注册过程', function() {
    const registry = new ProcedureRegistry()
    registry.register({
      name: 'a.proc',
      signature: 'a.proc() :: (x :: ANY?)',
      execute() { return [] },
    })
    registry.register({
      name: 'b.proc',
      signature: 'b.proc() :: (y :: ANY?)',
      execute() { return [] },
    })
    const list = registry.list()
    expect(list.length).toBe(2)
    expect(list.map(p => p.name).sort()).toEqual(['a.proc', 'b.proc'])
  })
})

// ── 2. 内置过程 — 全局注册 ────────────────────────────────

describe('内置 Procedure — globalRegistry', function() {
  it('globalRegistry 包含所有 8+ 个内置过程', function() {
    const list = globalRegistry.list()
    const names = list.map(p => p.name)

    expect(names).toContain('db.labels')
    expect(names).toContain('db.relationshipTypes')
    expect(names).toContain('db.propertyKeys')
    expect(names).toContain('db.schema.nodeTypeProperties')
    expect(names).toContain('db.schema.visualization')
    expect(names).toContain('dbms.listConfig')
    expect(names).toContain('db.stats.retrieve')
    expect(names).toContain('db.index.fulltext.queryNodes')
    expect(names).toContain('db.index.fulltext.queryRelationshipIndexes')

    // 至少 9 个
    expect(list.length).toBeGreaterThanOrEqual(9)
  })
})

// ── 3. 解析和执行 ──────────────────────────────────────────

describe('CALL procedure — 解析与执行', function() {
  it('解析 CALL db.labels()', function() {
    const plan = parseQuery('CALL db.labels()')
    expect(plan.type).toBe('CALL')
    expect(plan.callProcedure).toBeDefined()
    if (plan.callProcedure) {
      expect(plan.callProcedure.name).toBe('db.labels')
      expect(plan.callProcedure.args).toEqual([])
    }
  })

  it('解析 CALL db.labels() YIELD label', function() {
    const plan = parseQuery('CALL db.labels() YIELD label')
    expect(plan.type).toBe('CALL')
    expect(plan.callProcedure).toBeDefined()
    if (plan.callProcedure) {
      expect(plan.callProcedure.yieldItems).toBeDefined()
      expect(plan.callProcedure.yieldItems!.length).toBe(1)
      expect(plan.callProcedure.yieldItems![0].name).toBe('label')
    }
  })

  it('解析 CALL db.index.fulltext.queryNodes()', function() {
    const plan = parseQuery('CALL db.index.fulltext.queryNodes("idx", "term") YIELD node, score')
    expect(plan.type).toBe('CALL')
    if (plan.callProcedure) {
      expect(plan.callProcedure.name).toBe('db.index.fulltext.queryNodes')
      expect(plan.callProcedure.args).toEqual(['idx', 'term'])
      expect(plan.callProcedure.yieldItems!.map((y: { name: string }) => y.name)).toEqual(['node', 'score'])
    }
  })

  it('执行 CALL db.labels() — 返回 label 列表', async function() {
    const result = await _executeQuery(
      parseQuery('CALL db.labels()'),
      testGraph,
    ) as any[]
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBeGreaterThanOrEqual(2)
    const labels = result.map((r: { label: string }) => r.label).sort()
    expect(labels).toContain('Person')
    expect(labels).toContain('Pet')
  })

  it('执行 CALL db.labels() YIELD label — 返回 label 列', async function() {
    const result = await _executeQuery(
      parseQuery('CALL db.labels() YIELD label'),
      testGraph,
    ) as any[]
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBeGreaterThanOrEqual(2)
    // 只应该有 label 字段
    for (const row of result) {
      expect(Object.keys(row)).toEqual(['label'])
    }
  })

  it('YIELD 过滤不存在的列 — 报错', async function() {
    await expect(
      _executeQuery(
        parseQuery('CALL db.labels() YIELD nonExistentColumn'),
        testGraph,
      )
    ).rejects.toThrow(/Invalid YIELD field/)
  })

  it('调用不存在的 procedure — 报错', async function() {
    await expect(
      _executeQuery(
        parseQuery('CALL some.nonexistent.procedure()'),
        testGraph,
      )
    ).rejects.toThrow(/Unknown procedure/)
  })
})

// ── 4. 高级 YIELD 测试 ────────────────────────────────────

describe('CALL procedure — YIELD 高级场景', function() {
  it('YIELD label AS lbl — 别名', async function() {
    const result = await _executeQuery(
      parseQuery('CALL db.labels() YIELD label AS lbl'),
      testGraph,
    ) as any[]
    expect(result.length).toBeGreaterThanOrEqual(2)
    for (const row of result) {
      expect(Object.keys(row)).toEqual(['lbl'])
      expect(typeof row.lbl).toBe('string')
    }
  })
})

// ── 5. 更多内置过程 ──────────────────────────────────────

describe('其他内置 Procedure', function() {
  it('db.stats.retrieve() — 返回统计Info', async function() {
    const result = await _executeQuery(
      parseQuery('CALL db.stats.retrieve()'),
      testGraph,
    ) as any[]
    expect(result.length).toBe(1)
    expect(result[0].section).toBe('graph')
    expect(result[0].stat).toBeDefined()
    expect(result[0].stat.nodeCount).toBe(4)
  })

  it('db.schema.visualization() — 返回拓扑Info', async function() {
    const result = await _executeQuery(
      parseQuery('CALL db.schema.visualization()'),
      testGraph,
    ) as any[]
    expect(result.length).toBe(1)
    // The active executor path returns a detail map: nodes and relationships
    // as arrays of label/type descriptors (see query-engine.spec.ts).
    const schema = result[0]
    expect(Array.isArray(schema.nodes)).toBe(true)
    expect(Array.isArray(schema.relationships)).toBe(true)
    const nodeNames = schema.nodes.map((n: any) => n.name)
    expect(nodeNames).toContain('Person')
    expect(nodeNames).toContain('Pet')
  })

  it('dbms.listConfig() — 返回配置Info', async function() {
    const result = await _executeQuery(
      parseQuery('CALL dbms.listConfig()'),
      testGraph,
    ) as any[]
    expect(result.length).toBeGreaterThanOrEqual(1)
    expect(result[0].name).toBeDefined()
    expect(result[0].description).toBeDefined()
    expect(result[0].value).toBeDefined()
  })

  it('db.index.fulltext.queryNodes() — 空结果', async function() {
    const result = await _executeQuery(
      parseQuery('CALL db.index.fulltext.queryNodes("idx", "term")'),
      testGraph,
    ) as any[]
    expect(result).toEqual([])
  })
})

// ── 3. ProcedureRegistry 兼容 API（deprecated 方法） ──────

describe('ProcedureRegistry compatibility API', function() {
  it('registerProcedure with a function handler', function() {
    const registry = new ProcedureRegistry()
    registry.registerProcedure('compat.fn', (args: any[]) => [{ got: args }])
    expect(registry.hasProcedure('compat.fn')).toBe(true)
    expect(registry.get('compat.fn')).toBeDefined()
  })

  it('registerProcedure with a procedure object', function() {
    const registry = new ProcedureRegistry()
    const proc = { name: 'compat.obj', signature: '', execute: () => [] }
    registry.registerProcedure('ignored', proc)
    expect(registry.get('compat.obj')).toBe(proc)
  })

  it('listProcedures returns all registered procedures', function() {
    const registry = new ProcedureRegistry()
    registry.register({ name: 'compat.list', signature: '', execute: () => [] })
    expect(registry.listProcedures().map(p => p.name)).toContain('compat.list')
  })

  it('callProcedure executes a registered procedure', async function() {
    const registry = new ProcedureRegistry()
    registry.register({
      name: 'compat.call',
      signature: '',
      execute: (ctx: any, args: any[]) => [{ ctxProvided: !!ctx, args }],
    })
    const result = await registry.callProcedure('compat.call', [1, 2], { marker: true })
    expect(result[0].ctxProvided).toBe(true)
    expect(result[0].args).toEqual([1, 2])
  })

  it('callProcedure throws for unknown procedure', async function() {
    const registry = new ProcedureRegistry()
    await expect(registry.callProcedure('nope', [], {})).rejects.toThrow(
      /Unknown procedure/,
    )
  })

  it('unregister removes a procedure', function() {
    const registry = new ProcedureRegistry()
    registry.register({ name: 'compat.rm', signature: '', execute: () => [] })
    expect(registry.has('compat.rm')).toBe(true)
    registry.unregister('compat.rm')
    expect(registry.has('compat.rm')).toBe(false)
  })
})

// ── 4. 内置 procedure 的 fallback 分支（通过 ctx 触发） ──────

describe('built-in procedure execute fallback branches', function() {
  it('db.labels resolves labels via getAllNodes + getTypeNameById', function() {
    const proc = globalRegistry.get('db.labels')!
    const ctx = {
      getAllNodes: () => [
        { type: 2, props: {} },
        { type: 2, props: {} },
        { type: 7, props: {} },
      ],
      getTypeNameById: (id: number) => (id === 2 ? 'Person' : id === 7 ? 'Pet' : undefined),
    }
    const result = proc.execute(ctx as any, []) as Array<{ label: string }>
    expect(result.map(r => r.label)).toEqual(['Person', 'Pet'])
  })

  it('db.labels resolves labels via getAllNodes without getTypeNameById', function() {
    const proc = globalRegistry.get('db.labels')!
    const ctx = {
      getAllNodes: () => [{ type: 2 }, { type: 7 }],
    }
    const result = proc.execute(ctx as any, []) as Array<{ label: string }>
    // Falls back to stringified type ids.
    expect(result.map(r => r.label).sort()).toEqual(['2', '7'])
  })

  it('db.relationshipTypes returns configured types', function() {
    const proc = globalRegistry.get('db.relationshipTypes')!
    const ctx = { getRelationshipTypes: () => ['KNOWS', 'LIKES'] }
    const result = proc.execute(ctx as any, []) as Array<{ relationshipType: string }>
    expect(result.map(r => r.relationshipType)).toEqual(['KNOWS', 'LIKES'])
  })

  it('db.relationshipTypes returns empty when no resolver present', function() {
    const proc = globalRegistry.get('db.relationshipTypes')!
    const result = proc.execute({} as any, []) as Array<{ relationshipType: string }>
    expect(result).toEqual([])
  })

  it('db.propertyKeys resolves keys via getAllNodes props (plus id/name)', function() {
    const proc = globalRegistry.get('db.propertyKeys')!
    const ctx = {
      getAllNodes: () => [
        { props: { age: 30, name: 'Alice' } },
        { props: { age: 25 } },
      ],
    }
    const result = proc.execute(ctx as any, []) as Array<{ propertyKey: string }>
    const keys = result.map(r => r.propertyKey)
    expect(keys).toContain('age')
    expect(keys).toContain('name')
    expect(keys).toContain('id')
  })

  it('db.schema.nodeTypeProperties returns fallback Person row when no labels', function() {
    const proc = globalRegistry.get('db.schema.nodeTypeProperties')!
    const result = proc.execute({} as any, []) as any[]
    expect(result.length).toBe(1)
    expect(result[0].nodeType).toBe('Person')
    expect(result[0].propertyName).toBe('name')
  })

  it('db.schema.nodeTypeProperties enumerates properties per label', function() {
    const proc = globalRegistry.get('db.schema.nodeTypeProperties')!
    const ctx = {
      getLabels: () => ['Person'],
      getPropertyKeys: () => ['name', 'age'],
    }
    const result = proc.execute(ctx as any, []) as any[]
    expect(result.length).toBe(2)
    for (const row of result) {
      expect(row.nodeType).toBe('Person')
      expect(['name', 'age']).toContain(row.propertyName)
      expect(row.propertyType).toBe('STRING')
    }
  })

  it('db.index.fulltext.queryRelationshipIndexes delegates to ctx', function() {
    const proc = globalRegistry.get('db.index.fulltext.queryRelationshipIndexes')!
    const ctx = {
      fulltextQueryRelationshipIndexes: (idx: string, term: string) => [
        { relationship: { _id: 'r1' }, score: 0.9 },
      ],
    }
    const result = proc.execute(ctx as any, ['idx', 'term']) as any[]
    expect(result).toHaveLength(1)
    expect(result[0].score).toBe(0.9)
  })

  it('db.index.fulltext.queryNodes delegates to ctx', function() {
    const proc = globalRegistry.get('db.index.fulltext.queryNodes')!
    const ctx = {
      fulltextQueryNodes: (idx: string, term: string) => [{ node: { _id: 'n1' }, score: 0.8 }],
    }
    const result = proc.execute(ctx as any, ['idx', 'term']) as any[]
    expect(result).toHaveLength(1)
    expect(result[0].score).toBe(0.8)
  })

  it('dbms.security.createUser returns empty result', function() {
    const proc = globalRegistry.get('dbms.security.createUser')!
    const result = proc.execute({} as any, ['u', 'p', true]) as any[]
    expect(result).toEqual([])
  })

  it('db.schema.visualization falls back to 0 counts without getNodeCount', function() {
    const proc = globalRegistry.get('db.schema.visualization')!
    const result = proc.execute({} as any, []) as any[]
    expect(result).toHaveLength(1)
    expect(result[0].nodes).toBe(0)
    expect(result[0].edges).toBe(0)
  })

  it('dbms.listConfig enumerates non-empty config entries', function() {
    const proc = globalRegistry.get('dbms.listConfig')!
    const ctx = {
      getConfig: () => ({ 'dbms.memory.heap.size': '512m', 'dbms.pagecache': '128m' }),
    }
    const result = proc.execute(ctx as any, []) as any[]
    expect(result.length).toBe(2)
    expect(result[0]).toEqual({
      name: 'dbms.memory.heap.size',
      description: 'Configuration for dbms.memory.heap.size',
      value: '512m',
    })
  })
})
