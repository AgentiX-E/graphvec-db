/**
 * permission-resolver.spec.ts — Tests for PermissionResolver + wrapEngine
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { PermissionResolver, wrapEngine, type PermissionContext, type GraphEngineOps } from '../security/permission-resolver'
import { RBAC } from '../security/rbac'
import { Role, AuthError } from '../types'

// ── Helpers ───────────────────────────────────────────────

const ADMIN_CTX: PermissionContext = { userId: 'admin-1', role: Role.ADMIN }
const WRITER_CTX: PermissionContext = { userId: 'writer-1', role: Role.WRITER }
const READER_CTX: PermissionContext = { userId: 'reader-1', role: Role.READER }

/** 创建一个模拟的 GraphEngine，记录调用 */
function createMockEngine(): GraphEngineOps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async upsertNode(nodeId: number, data: any) {
      calls.push(`upsertNode(${nodeId})`)
      return { id: nodeId, ...data }
    },
    async deleteNode(nodeId: number) {
      calls.push(`deleteNode(${nodeId})`)
      return true
    },
    async upsertEdge(edgeId: number, data: any) {
      calls.push(`upsertEdge(${edgeId})`)
      return { id: edgeId, ...data }
    },
    async deleteEdge(edgeId: number) {
      calls.push(`deleteEdge(${edgeId})`)
      return true
    },
    async query(cypher: string) {
      calls.push(`query(${cypher})`)
      return { results: [] }
    },
  }
}

describe('PermissionResolver', () => {
  let resolver: PermissionResolver

  beforeEach(() => {
    RBAC.clearAcls()
    resolver = new PermissionResolver()
  })

  afterAll(() => {
    RBAC.clearAcls()
  })

  // ── grant / revoke / check ──

  it('should grant permission and check returns allowed', () => {
    resolver.grant(WRITER_CTX, 'graph_node', undefined, 'create')
    const result = resolver.check(WRITER_CTX, 'create', 'graph_node')
    expect(result.allowed).toBe(true)
  })

  it('should revoke permission and check returns denied', () => {
    resolver.grant(READER_CTX, 'graph_edge', 'edge-42', 'read')
    expect(resolver.check(READER_CTX, 'read', 'graph_edge', 'edge-42').allowed).toBe(true)

    resolver.revoke(READER_CTX, 'graph_edge', 'edge-42')
    // After revoke, fallback to role-based defaults
    expect(resolver.check(READER_CTX, 'read', 'graph_edge', 'edge-42').allowed).toBe(true)
  })

  it('should deny action not granted', () => {
    const result = resolver.check(READER_CTX, 'delete', 'graph_node', 'node-1')
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('delete')
  })

  it('should allow admin for everything', () => {
    const result = resolver.check(ADMIN_CTX, 'delete', 'any-resource', 'any-id')
    expect(result.allowed).toBe(true)
  })

  it('should return reason on denial', () => {
    const result = resolver.check(READER_CTX, 'create', 'graph_node')
    expect(result.allowed).toBe(false)
    expect(result.reason).toBeTruthy()
    expect(result.reason).toContain('reader')
  })

  // ── checkNodeUpsert ──

  it('should allow node upsert with write permission', () => {
    resolver.grant(WRITER_CTX, 'graph_node', undefined, 'create')
    const result = resolver.checkNodeUpsert(WRITER_CTX, 1, { typeId: 1, name: 'test', props: {} })
    expect(result.allowed).toBe(true)
  })

  it('should deny node upsert for reader', () => {
    const result = resolver.checkNodeUpsert(READER_CTX, 1, { typeId: 1, name: 'test' })
    expect(result.allowed).toBe(false)
  })

  it('should allow admin node upsert', () => {
    const result = resolver.checkNodeUpsert(ADMIN_CTX, 1, { typeId: 1, name: 'test' })
    expect(result.allowed).toBe(true)
  })

  // ── checkNodeDelete ──

  it('should allow node delete with permission', () => {
    resolver.grant(WRITER_CTX, 'graph_node', undefined, 'delete')
    const result = resolver.checkNodeDelete(WRITER_CTX, 42)
    expect(result.allowed).toBe(true)
  })

  it('should deny node delete for reader', () => {
    const result = resolver.checkNodeDelete(READER_CTX, 42)
    expect(result.allowed).toBe(false)
  })

  it('should allow admin node delete', () => {
    const result = resolver.checkNodeDelete(ADMIN_CTX, 42)
    expect(result.allowed).toBe(true)
  })

  // ── checkEdgeUpsert ──

  it('should allow edge upsert with permission', () => {
    resolver.grant(WRITER_CTX, 'graph_edge', undefined, 'create')
    const result = resolver.checkEdgeUpsert(WRITER_CTX, 1, { typeId: 1, outNodeId: 1, inNodeId: 2 })
    expect(result.allowed).toBe(true)
  })

  it('should deny edge upsert for reader', () => {
    const result = resolver.checkEdgeUpsert(READER_CTX, 1, { typeId: 1, outNodeId: 1, inNodeId: 2 })
    expect(result.allowed).toBe(false)
  })

  // ── checkQuery ──

  it('should allow query for reader', () => {
    const result = resolver.checkQuery(READER_CTX, 'MATCH (n) RETURN n')
    expect(result.allowed).toBe(true)
  })

  it('should deny query for unauthenticated role', () => {
    const result = resolver.checkQuery({ userId: 'u1', role: 'nonexistent' }, 'MATCH (n) RETURN n')
    expect(result.allowed).toBe(false)
  })

  // ── assertAllowed ──

  it('should throw AuthError for denied result', () => {
    expect(() => resolver.assertAllowed({ allowed: false, reason: 'no access' })).toThrow(AuthError)
    expect(() => resolver.assertAllowed({ allowed: false })).toThrow(AuthError)
  })

  it('should not throw for allowed result', () => {
    expect(() => resolver.assertAllowed({ allowed: true })).not.toThrow()
  })

  // ── getRLS ──

  it('should return RowLevelSecurity instance', () => {
    const rls = resolver.getRLS()
    expect(rls).toBeDefined()
    expect(typeof rls.addPolicy).toBe('function')
  })
})

// ──────────────────────────────────────────
// wrapEngine
// ──────────────────────────────────────────

describe('wrapEngine', () => {
  let resolver: PermissionResolver

  beforeEach(() => {
    RBAC.clearAcls()
    resolver = new PermissionResolver()
  })

  afterAll(() => {
    RBAC.clearAcls()
  })

  // ── Basic wrapping ──

  it('should wrap engine and preserve methods', () => {
    const engine = createMockEngine()
    const guardian = wrapEngine(engine, resolver)

    expect(guardian._engine).toBe(engine)
    expect(guardian._resolver).toBe(resolver)
    expect(typeof guardian.upsertNode).toBe('function')
    expect(typeof guardian.deleteNode).toBe('function')
    expect(typeof guardian.upsertEdge).toBe('function')
    expect(typeof guardian.deleteEdge).toBe('function')
    expect(typeof guardian.query).toBe('function')
    expect(typeof guardian.grant).toBe('function')
    expect(typeof guardian.revoke).toBe('function')
    expect(typeof guardian.check).toBe('function')
  })

  // ── Grant / Revoke / Check on Guardian ──

  it('should grant, check, and revoke via guardian', () => {
    const engine = createMockEngine()
    const guardian = wrapEngine(engine, resolver)

    guardian.grant(WRITER_CTX, 'graph_node', 'node-1', 'create')
    expect(guardian.check(WRITER_CTX, 'create', 'graph_node', 'node-1').allowed).toBe(true)
  })

  it('should check via guardian and get denial', () => {
    const engine = createMockEngine()
    const guardian = wrapEngine(engine, resolver)

    const result = guardian.check(READER_CTX, 'delete', 'graph_node')
    expect(result.allowed).toBe(false)
  })

  // ── Guarded operations (with ctx) ──

  it('should allow upsertNode when ctx has permission', async () => {
    const engine = createMockEngine()
    const guardian = wrapEngine(engine, resolver)

    resolver.grant(WRITER_CTX, 'graph_node', undefined, 'create')
    await guardian.upsertNode(1, { typeId: 1, name: 'n1' }, WRITER_CTX)

    expect(engine.calls).toContain('upsertNode(1)')
  })

  it('should deny upsertNode when ctx has no permission', async () => {
    const engine = createMockEngine()
    const guardian = wrapEngine(engine, resolver)

    await expect(
      guardian.upsertNode(1, { typeId: 1, name: 'n1' }, READER_CTX),
    ).rejects.toThrow(AuthError)

    expect(engine.calls).not.toContain('upsertNode(1)')
  })

  it('should allow admin upsertNode', async () => {
    const engine = createMockEngine()
    const guardian = wrapEngine(engine, resolver)

    await guardian.upsertNode(1, { typeId: 1, name: 'n1' }, ADMIN_CTX)
    expect(engine.calls).toContain('upsertNode(1)')
  })

  it('should allow deleteNode when ctx has permission', async () => {
    const engine = createMockEngine()
    const guardian = wrapEngine(engine, resolver)
    resolver.grant(WRITER_CTX, 'graph_node', undefined, 'delete')

    const result = await guardian.deleteNode(42, WRITER_CTX)
    expect(result).toBe(true)
    expect(engine.calls).toContain('deleteNode(42)')
  })

  it('should deny deleteNode when ctx has no permission', async () => {
    const engine = createMockEngine()
    const guardian = wrapEngine(engine, resolver)

    await expect(
      guardian.deleteNode(42, READER_CTX),
    ).rejects.toThrow(AuthError)

    expect(engine.calls).not.toContain('deleteNode(42)')
  })

  it('should allow upsertEdge when ctx has permission', async () => {
    const engine = createMockEngine()
    const guardian = wrapEngine(engine, resolver)
    resolver.grant(WRITER_CTX, 'graph_edge', undefined, 'create')

    await guardian.upsertEdge(1, { typeId: 1, outNodeId: 1, inNodeId: 2 }, WRITER_CTX)
    expect(engine.calls).toContain('upsertEdge(1)')
  })

  it('should deny upsertEdge for reader', async () => {
    const engine = createMockEngine()
    const guardian = wrapEngine(engine, resolver)

    await expect(
      guardian.upsertEdge(1, { typeId: 1, outNodeId: 1, inNodeId: 2 }, READER_CTX),
    ).rejects.toThrow(AuthError)

    expect(engine.calls).not.toContain('upsertEdge(1)')
  })

  it('should allow query for reader via guardian', async () => {
    const engine = createMockEngine()
    const guardian = wrapEngine(engine, resolver)

    const result = await guardian.query('MATCH (n) RETURN n', {}, READER_CTX)
    expect(result).toEqual({ results: [] })
    expect(engine.calls).toContain('query(MATCH (n) RETURN n)')
  })

  it('should deny query for unauthorized role', async () => {
    const engine = createMockEngine()
    const guardian = wrapEngine(engine, resolver)
    const noPermsCtx: PermissionContext = { userId: 'u1', role: 'nonexistent' }

    await expect(
      guardian.query('MATCH (n) RETURN n', {}, noPermsCtx),
    ).rejects.toThrow(AuthError)

    expect(engine.calls).not.toContain('query(MATCH (n) RETURN n)')
  })

  // ── No ctx = skip permission check (backward compat) ──

  it('should skip permission check when no ctx provided (backward compat)', async () => {
    const engine = createMockEngine()
    const guardian = wrapEngine(engine, resolver)

    const result = await guardian.upsertNode(1, { typeId: 1, name: 'n1' })
    expect(result).toBeDefined()
    expect(engine.calls).toContain('upsertNode(1)')
  })

  it('should skip permission check on deleteNode without ctx', async () => {
    const engine = createMockEngine()
    const guardian = wrapEngine(engine, resolver)

    const result = await guardian.deleteNode(42)
    expect(result).toBe(true)
    expect(engine.calls).toContain('deleteNode(42)')
  })

  it('should skip permission check on query without ctx', async () => {
    const engine = createMockEngine()
    const guardian = wrapEngine(engine, resolver)

    const result = await guardian.query('MATCH (n) RETURN n')
    expect(result).toBeDefined()
    expect(engine.calls).toContain('query(MATCH (n) RETURN n)')
  })

  // ── RLS integration ──

  it('should have getRLS method on guardian', () => {
    const engine = createMockEngine()
    const guardian = wrapEngine(engine, resolver)

    const rls = guardian.getRLS()
    expect(rls).toBeDefined()
    expect(typeof rls.addPolicy).toBe('function')
  })

  // ── Error scenarios ──

  it('should propagate AuthError from permission check with 403 status', async () => {
    const engine = createMockEngine()
    const guardian = wrapEngine(engine, resolver)

    try {
      await guardian.upsertNode(1, { typeId: 1, name: 'n1' }, READER_CTX)
      expect.fail('Should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(AuthError)
      expect((e as AuthError).statusCode).toBe(403)
    }
  })

  it('should handle missing engine methods gracefully', async () => {
    const partialEngine: GraphEngineOps = {}
    const guardian = wrapEngine(partialEngine, resolver)

    await expect(
      guardian.upsertNode(1, { typeId: 1, name: 'n1' }),
    ).rejects.toThrow('not implemented')
  })

  it('should construct without resolver', () => {
    const engine = createMockEngine()
    const guardian = wrapEngine(engine)

    expect(guardian._resolver).toBeDefined()
    expect(guardian._resolver.getRLS()).toBeDefined()
  })
})
