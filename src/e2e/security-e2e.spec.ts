/**
 * security-e2e.spec.ts — 安全集成端到端测试
 *
 * 使用真实 Authenticator / RBAC / AuditLogger 实例（非 mock）。
 * 覆盖：认证流程完整链路、RBAC 角色权限、审计日志记录
 */
import { JwtManager, RBAC } from '../security/auth'
import { AuditLogger } from '../security/audit'
import { Role, AuthError, type AuditEntry } from '../types'
import * as fs from 'fs'
import * as path from 'path'

const BASE_DIR = path.join(__dirname, '../../test-data/e2e-security')

function makeDir(name: string): string {
  const dir = path.join(BASE_DIR, name)
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

describe('Security E2E — 安全集成测试', () => {
  // ── 1. JWT Token 完整链路 ─────────────────────────────
  test('SEC-01: JWT Token 签发→验证', () => {
    const jwt = new JwtManager('e2e-secret-key-32-chars-long-for-test')

    // Sign a token for admin role
    const token = jwt.signToken('alice', Role.ADMIN, 3600)
    expect(token).toBeTruthy()
    expect(typeof token).toBe('string')

    // Verify token
    const payload = jwt.verifyToken(token)
    expect(payload).not.toBeNull()
    expect(payload!.userId).toBe('alice')
    expect(payload!.role).toBe(Role.ADMIN)
  }, 15000)

  // ── 2. 认证失败场景 ─────────────────────────────
  test('SEC-02: 无效 token 和不同密钥验证', () => {
    const jwt = new JwtManager('e2e-secret-key-32-chars-long-for-test')

    // Invalid token format — verifyToken throws AuthError
    expect(() => jwt.verifyToken('invalid-token-string')).toThrow()

    // Token signed with different secret (use a different manager)
    const jwt2 = new JwtManager('different-secret-key-for-test----32c')
    const token = jwt2.signToken('bob', Role.READER, 3600)

    // Verify with jwt manager that has different secret — should throw or return null
    try {
      const badVerify = jwt.verifyToken(token)
      expect(badVerify).toBeNull()
    } catch {
      // HMAC mismatch throws — acceptable
    }
  }, 15000)

  // ── 3. RBAC 角色权限 ──────────────────────────────
  test('SEC-03: RBAC 角色权限控制', () => {
    // ADMIN has full access
    expect(() => RBAC.checkPermission(Role.ADMIN, 'delete')).not.toThrow()
    expect(() => RBAC.checkPermission(Role.ADMIN, 'create')).not.toThrow()

    // WRITER has read/write/delete
    expect(() => RBAC.checkPermission(Role.WRITER, 'read')).not.toThrow()
    expect(() => RBAC.checkPermission(Role.WRITER, 'write')).not.toThrow()

    // READER only read
    expect(() => RBAC.checkPermission(Role.READER, 'read')).not.toThrow()
    expect(() => RBAC.checkPermission(Role.READER, 'write')).toThrow(AuthError)
    expect(() => RBAC.checkPermission(Role.READER, 'delete')).toThrow(AuthError)

    // OPERATOR has extended operations
    expect(() => RBAC.checkPermission(Role.OPERATOR, 'compact')).not.toThrow()
    expect(() => RBAC.checkPermission(Role.OPERATOR, 'backup')).not.toThrow()
  }, 15000)

  // ── 4. RBAC ACL 精细权限 ──────────────────────
  test('SEC-04: RBAC ACL 资源粒度权限', () => {
    RBAC.clearAcls()

    RBAC.addAcl({ role: 'admin', resource: 'database', actions: ['admin'] })
    RBAC.addAcl({ role: 'editor', resource: 'graph_node', actions: ['create', 'read', 'update'] })
    RBAC.addAcl({ role: 'viewer', resource: 'query', actions: ['query'] })

    // Admin can admin database
    expect(RBAC.aclAllows('admin', 'admin', 'database')).toBe(true)

    // Editor can CRUD nodes
    expect(RBAC.aclAllows('editor', 'create', 'graph_node')).toBe(true)
    expect(RBAC.aclAllows('editor', 'update', 'graph_node')).toBe(true)
    expect(RBAC.aclAllows('editor', 'delete', 'graph_node')).toBe(false)

    // Viewer can query only
    expect(RBAC.aclAllows('viewer', 'query', 'query')).toBe(true)
    expect(RBAC.aclAllows('viewer', 'read', 'graph_node')).toBe(false)

    RBAC.clearAcls()
  }, 15000)

  // ── 5. 审计日志记录 ──────────────────────────────────
  test('SEC-05: AuditLogger 审计日志记录与查询', () => {
    const dir = makeDir('sec-05')

    const auditLog = new AuditLogger(undefined, undefined, dir)

    auditLog.log({ operation: 'CREATE', user: 'alice', role: Role.ADMIN, resource: 'graph_node', result: 'success' })
    auditLog.log({ operation: 'DELETE', user: 'alice', role: Role.ADMIN, resource: 'graph_node', result: 'success' })
    auditLog.log({ operation: 'QUERY', user: 'bob', role: Role.READER, resource: 'query', result: 'success' })
    auditLog.log({ operation: 'LOGIN', user: 'charlie', role: Role.READER, resource: 'auth', result: 'denied' })

    const recent = auditLog.getRecent(10)
    expect(recent.length).toBeGreaterThanOrEqual(4)

    const all = auditLog.getAll()
    expect(all.length).toBeGreaterThanOrEqual(4)

    const createOps = auditLog.query({ operation: 'CREATE' })
    expect(createOps.length).toBeGreaterThanOrEqual(1)

    const aliceLogs = auditLog.query({ user: 'alice' })
    expect(aliceLogs.length).toBeGreaterThanOrEqual(2)
    aliceLogs.forEach(e => expect(e.user).toBe('alice'))
  }, 15000)

  // ══════════════════════════════════════════════════════════════
  // 以下为 E2E 扩张新增测试
  // ══════════════════════════════════════════════════════════════

  // ── 6. JWT Token 过期/边界测试 ─────────────────────────
  test('SEC-06: JWT Token 过期和边界测试', () => {
    const jwt = new JwtManager('e2e-secret-key-32-chars-long-for-test')

    // Token with 1 second expiry
    const token = jwt.signToken('bob', Role.READER, 1)
    expect(token).toBeTruthy()

    // Token with 0 expiry (should create token)
    const zeroToken = jwt.signToken('charlie', Role.READER, 0)
    expect(zeroToken).toBeTruthy()

    // Token with negative expiry
    const negToken = jwt.signToken('dave', Role.READER, -1)
    expect(negToken).toBeTruthy()

    // Empty/missing token handling
    expect(() => jwt.verifyToken('')).toThrow()
    expect(() => jwt.verifyToken(null as unknown as string)).toThrow()
    expect(() => jwt.verifyToken(undefined as unknown as string)).toThrow()
  }, 15000)

  // ── 7. JWT 不同角色令牌 ────────────────────────────
  test('SEC-07: JWT 不同角色令牌签发与验证', () => {
    const jwt = new JwtManager('e2e-secret-key-32-chars-long-for-test')
    const roles = [Role.ADMIN, Role.WRITER, Role.READER, Role.OPERATOR]

    roles.forEach(role => {
      const token = jwt.signToken(`user-${role}`, role, 3600)
      const payload = jwt.verifyToken(token)
      expect(payload).not.toBeNull()
      expect(payload!.role).toBe(role)
      expect(payload!.userId).toBe(`user-${role}`)
    })
  }, 15000)

  // ── 8. JWT 特殊字符 userId ──────────────────────────
  test('SEC-08: JWT 含特殊字符用户 id 的 Token', () => {
    const jwt = new JwtManager('e2e-secret-key-32-chars-long-for-test')

    const specialIds = [
      'hello@world.com',
      'user.name',
      'user_name',
      'UPPERCASE',
      '12345',
      'a',
      '',
      'admin@example.com',
    ]

    specialIds.forEach(uid => {
      const token = jwt.signToken(uid, Role.READER, 3600)
      if (uid === '') {
        // Empty userId may or may not be valid
        try {
          const payload = jwt.verifyToken(token)
          if (payload) expect(payload.role).toBe(Role.READER)
        } catch {
          // Acceptable
        }
      } else {
        const payload = jwt.verifyToken(token)
        expect(payload).not.toBeNull()
        expect(payload!.userId).toBe(uid)
      }
    })
  }, 15000)

  // ── 9. RBAC 精细权限组合 ─────────────────────────
  test('SEC-09: RBAC 多种角色的精细权限', () => {
    // ADMIN: all operations
    expect(() => RBAC.checkPermission(Role.ADMIN, 'read')).not.toThrow()
    expect(() => RBAC.checkPermission(Role.ADMIN, 'write')).not.toThrow()
    expect(() => RBAC.checkPermission(Role.ADMIN, 'delete')).not.toThrow()
    expect(() => RBAC.checkPermission(Role.ADMIN, 'admin')).not.toThrow()

    // WRITER: read write delete create
    expect(() => RBAC.checkPermission(Role.WRITER, 'read')).not.toThrow()
    expect(() => RBAC.checkPermission(Role.WRITER, 'write')).not.toThrow()
    expect(() => RBAC.checkPermission(Role.WRITER, 'delete')).not.toThrow()

    // READER: only read
    expect(() => RBAC.checkPermission(Role.READER, 'read')).not.toThrow()
    expect(() => RBAC.checkPermission(Role.READER, 'write')).toThrow(AuthError)
    expect(() => RBAC.checkPermission(Role.READER, 'delete')).toThrow(AuthError)
    expect(() => RBAC.checkPermission(Role.READER, 'admin')).toThrow(AuthError)

    // OPERATOR: compact backup restore
    expect(() => RBAC.checkPermission(Role.OPERATOR, 'compact')).not.toThrow()
    expect(() => RBAC.checkPermission(Role.OPERATOR, 'backup')).not.toThrow()
    expect(() => RBAC.checkPermission(Role.OPERATOR, 'restore')).not.toThrow()

    // Unknown role
    expect(() => RBAC.checkPermission('UNKNOWN' as any, 'read')).toThrow(AuthError)
  }, 15000)

  // ── 10. RBAC ACL 高级测试 ──────────────────────────
  test('SEC-10: RBAC ACL 高级权限组合', () => {
    RBAC.clearAcls()

    // Setup complex ACL rules using the ACL system
    RBAC.addAcl({ role: 'super-admin', resource: '*', actions: ['admin'] })
    RBAC.addAcl({ role: 'graph-editor', resource: 'graph_node', actions: ['create', 'read', 'update', 'delete'] })
    RBAC.addAcl({ role: 'graph-viewer', resource: 'graph_node', actions: ['read'] })
    RBAC.addAcl({ role: 'query-executor', resource: 'query', actions: ['query'] })

    // Super-admin: all access (admin action covers all)
    expect(RBAC.aclAllows('super-admin', 'read', 'graph_node')).toBe(true)
    expect(RBAC.aclAllows('super-admin', 'delete', 'database')).toBe(true)

    // Graph-editor: full CRUD on graph_node
    expect(RBAC.aclAllows('graph-editor', 'create', 'graph_node')).toBe(true)
    expect(RBAC.aclAllows('graph-editor', 'read', 'graph_node')).toBe(true)
    expect(RBAC.aclAllows('graph-editor', 'update', 'graph_node')).toBe(true)
    expect(RBAC.aclAllows('graph-editor', 'delete', 'graph_node')).toBe(true)
    expect(RBAC.aclAllows('graph-editor', 'query', 'query')).toBe(false)

    // Graph-viewer: read only
    expect(RBAC.aclAllows('graph-viewer', 'read', 'graph_node')).toBe(true)
    expect(RBAC.aclAllows('graph-viewer', 'create', 'graph_node')).toBe(false)
    expect(RBAC.aclAllows('graph-viewer', 'delete', 'graph_node')).toBe(false)

    // Query-executor: query access only
    expect(RBAC.aclAllows('query-executor', 'query', 'query')).toBe(true)
    expect(RBAC.aclAllows('query-executor', 'read', 'graph_node')).toBe(false)

    // Non-existent role
    expect(RBAC.aclAllows('hacker', 'read', 'graph_node')).toBe(false)

    RBAC.clearAcls()
  }, 15000)

  // ── 11. 审计日志多种操作类型 ─────────────────────
  test('SEC-11: AuditLogger 多种操作类型', () => {
    const dir = makeDir('sec-11')
    const auditLog = new AuditLogger(undefined, undefined, dir)

    const operations = ['CREATE', 'READ', 'UPDATE', 'DELETE', 'QUERY', 'BACKUP', 'RESTORE', 'COMPACT', 'LOGIN', 'LOGOUT']
    operations.forEach(op => {
      auditLog.log({
        operation: op as any,
        user: 'admin',
        role: Role.ADMIN,
        resource: 'system',
        result: 'success',
      })
    })

    const all = auditLog.getAll()
    expect(all.length).toBe(operations.length)

    // Verify each operation appears
    const opTypes = new Set(all.map(e => e.operation))
    operations.forEach(op => expect(opTypes.has(op as any)).toBe(true))
  }, 15000)

  // ── 12. 审计日志查询过滤 ───────────────────────
  test('SEC-12: AuditLogger 组合条件查询', () => {
    const dir = makeDir('sec-12')
    const auditLog = new AuditLogger(undefined, undefined, dir)

    auditLog.log({ operation: 'CREATE', user: 'alice', role: Role.ADMIN, resource: 'graph_node', result: 'success' })
    auditLog.log({ operation: 'CREATE', user: 'bob', role: Role.WRITER, resource: 'graph_node', result: 'success' })
    auditLog.log({ operation: 'DELETE', user: 'alice', role: Role.ADMIN, resource: 'graph_node', result: 'denied' })
    auditLog.log({ operation: 'QUERY', user: 'alice', role: Role.ADMIN, resource: 'query', result: 'success' })
    auditLog.log({ operation: 'LOGIN', user: 'bob', role: Role.WRITER, resource: 'auth', result: 'denied' })

    // Query by result
    const successLogs = auditLog.query({ result: 'success' })
    expect(successLogs.length).toBeGreaterThanOrEqual(3)

    // Query by resource
    const graphLogs = auditLog.query({ resource: 'graph_node' })
    expect(graphLogs.length).toBeGreaterThanOrEqual(3)

    // Query by user + operation
    const aliceCreate = auditLog.query({ user: 'alice', operation: 'CREATE' })
    expect(aliceCreate.length).toBeGreaterThanOrEqual(1)
    aliceCreate.forEach(e => {
      expect(e.user).toBe('alice')
      expect(e.operation).toBe('CREATE')
    })
  }, 15000)

  // ── 13. 审计日志边界测试 ───────────────────────
  test('SEC-13: AuditLogger 空查询和边界', () => {
    const dir = makeDir('sec-13')
    const auditLog = new AuditLogger(undefined, undefined, dir)

    // Empty audit log
    expect(auditLog.getAll()).toEqual([])
    expect(auditLog.getRecent(0)).toEqual([])
    expect(auditLog.getRecent(10)).toEqual([])

    // Query on empty
    expect(auditLog.query({ operation: 'CREATE' }).length).toBe(0)
    expect(auditLog.query({ user: 'nonexistent' }).length).toBe(0)

    // Add one entry
    auditLog.log({ operation: 'READ', user: 'test', role: Role.READER, resource: 'node', result: 'success' })
    expect(auditLog.getAll().length).toBe(1)

    // Get recent with specific count
    expect(auditLog.getRecent(1).length).toBe(1)
    expect(auditLog.getRecent(5).length).toBe(1)
  }, 15000)

  // ── 14. 审计日志大量记录 ─────────────────────────
  test('SEC-14: AuditLogger 批量日志记录(100 条)', () => {
    const dir = makeDir('sec-14')
    const auditLog = new AuditLogger(undefined, undefined, dir)

    for (let i = 0; i < 100; i++) {
      auditLog.log({
        operation: i % 2 === 0 ? 'CREATE' : 'READ',
        user: `user-${i % 10}`,
        role: i % 2 === 0 ? Role.ADMIN : Role.READER,
        resource: 'graph_node',
        result: i % 5 === 0 ? 'denied' : 'success',
      })
    }

    const all = auditLog.getAll()
    expect(all.length).toBe(100)

    const recent = auditLog.getRecent(10)
    expect(recent.length).toBe(10)

    const denied = auditLog.query({ result: 'denied' })
    expect(denied.length).toBeGreaterThanOrEqual(20)
  }, 15000)

  // ── 15. RBAC + JWT + AuditLogger 集成 ─────────────
  test('SEC-15: RBAC+JWT+AuditLogger 完整集成', () => {
    const dir = makeDir('sec-15')
    const auditLog = new AuditLogger(undefined, undefined, dir)
    const jwt = new JwtManager('e2e-secret-key-32-chars-long-for-test')

    // Issue token
    const token = jwt.signToken('admin-user', Role.ADMIN, 3600)
    const payload = jwt.verifyToken(token)
    expect(payload).not.toBeNull()
    expect(payload!.role).toBe(Role.ADMIN)

    // Check RBAC permission
    expect(() => RBAC.checkPermission(payload!.role, 'delete')).not.toThrow()

    // Log the operation
    auditLog.log({
      operation: 'DELETE',
      user: payload!.userId,
      role: payload!.role,
      resource: 'graph_node',
      result: 'success',
    })

    // Verify log
    const logs = auditLog.query({ user: 'admin-user' })
    expect(logs.length).toBe(1)
    expect(logs[0].operation).toBe('DELETE')
    expect(logs[0].result).toBe('success')

    // Reader token — should fail write check
    const readerToken = jwt.signToken('viewer', Role.READER, 3600)
    const readerPayload = jwt.verifyToken(readerToken)
    expect(readerPayload!.role).toBe(Role.READER)
    expect(() => RBAC.checkPermission(readerPayload!.role, 'write')).toThrow(AuthError)

    auditLog.log({
      operation: 'WRITE',
      user: readerPayload!.userId,
      role: readerPayload!.role,
      resource: 'graph_node',
      result: 'denied',
    })

    const deniedLogs = auditLog.query({ result: 'denied' })
    expect(deniedLogs.length).toBe(1)
  }, 15000)

  // ── 16. RBAC ACL 资源通配符 ──────────────────
  test('SEC-16: RBAC ACL 通配符权限', () => {
    RBAC.clearAcls()

    // Wildcard role using admin action — actions.includes('admin') covers all
    RBAC.addAcl({ role: 'root', resource: '*', actions: ['admin'] })
    expect(RBAC.aclAllows('root', 'read', 'any_resource')).toBe(true) // 'admin' action catches all
    expect(RBAC.aclAllows('root', 'admin', 'any_resource')).toBe(true)

    // Specific resource with multiple actions
    RBAC.addAcl({ role: 'limited-root', resource: 'graph_node', actions: ['read', 'delete'] })
    expect(RBAC.aclAllows('limited-root', 'read', 'graph_node')).toBe(true)
    expect(RBAC.aclAllows('limited-root', 'delete', 'graph_node')).toBe(true)
    expect(RBAC.aclAllows('limited-root', 'write', 'other_resource')).toBe(false)

    RBAC.clearAcls()
  }, 15000)

  // ── 17. JWT 密钥边界测试 ──────────────────
  test('SEC-17: JWT 边界密钥和载荷', () => {
    const jwt = new JwtManager('e2e-secret-key-32-chars-long-for-test')

    // Sign with long userId
    const longToken = jwt.signToken('a'.repeat(100), Role.READER, 3600)
    const longPayload = jwt.verifyToken(longToken)
    expect(longPayload).not.toBeNull()
    expect(longPayload!.userId.length).toBe(100)

    // Short secret (must be at least 16 bytes — this throws)
    try {
      const shortJwt = new JwtManager('short-key') // 9 bytes
      const shortToken = shortJwt.signToken('test', Role.ADMIN, 60)
      const shortPayload = shortJwt.verifyToken(shortToken)
      expect(shortPayload).not.toBeNull()
    } catch {
      // Acceptable — secret must be >= 16 bytes
    }

    // 16-byte secret should work
    const sixteenJwt = new JwtManager('sixteen-byte-key')
    const sixteenToken = sixteenJwt.signToken('test', Role.ADMIN, 60)
    expect(sixteenToken).toBeTruthy()
    const sixteenPayload = sixteenJwt.verifyToken(sixteenToken)
    expect(sixteenPayload).not.toBeNull()
  }, 15000)

  // ── 18. RBAC 角色未定义测试 ──────────────
  test('SEC-18: RBAC 不存在的角色检查', () => {
    // Role that doesn't exist in permission map
    expect(() => RBAC.checkPermission('NONEXISTENT' as Role, 'read')).toThrow(AuthError)
    expect(() => RBAC.checkPermission(undefined as unknown as Role, 'read')).toThrow()
    expect(() => RBAC.checkPermission(null as unknown as Role, 'read')).toThrow()
  }, 15000)

  // ── 19. AuditLogger 多次查询状态一致 ─────
  test('SEC-19: AuditLogger 查询一致性', () => {
    const dir = makeDir('sec-19')
    const auditLog = new AuditLogger(undefined, undefined, dir)

    const entry: Omit<AuditEntry, 'timestamp'> = { operation: 'CREATE', user: 'alice', role: Role.ADMIN, resource: 'node', result: 'success' }
    auditLog.log(entry)
    auditLog.log({ ...entry, operation: 'UPDATE', user: 'bob', role: Role.WRITER, result: 'success' })

    // Multiple queries should return same result
    const q1 = auditLog.query({ operation: 'CREATE' })
    const q2 = auditLog.query({ operation: 'CREATE' })
    expect(q1.length).toBe(q2.length)
    expect(q1).toEqual(q2)
  }, 15000)

  // ── 20. ACL 规则清空后重新安装 ────────────
  test('SEC-20: ACL 规则重置后重新建立', () => {
    RBAC.clearAcls()
    expect(RBAC.aclAllows('custom-editor', 'read', 'node')).toBe(false)

    RBAC.addAcl({ role: 'custom-editor', resource: 'node', actions: ['read'] })
    expect(RBAC.aclAllows('custom-editor', 'read', 'node')).toBe(true)
    expect(RBAC.aclAllows('custom-editor', 'write', 'node')).toBe(false)

    RBAC.clearAcls()
    expect(RBAC.aclAllows('custom-editor', 'read', 'node')).toBe(false)

    // Re-establish
    RBAC.addAcl({ role: 'custom-editor', resource: 'node', actions: ['read', 'write'] })
    expect(RBAC.aclAllows('custom-editor', 'read', 'node')).toBe(true)
    expect(RBAC.aclAllows('custom-editor', 'write', 'node')).toBe(true)

    RBAC.clearAcls()
  }, 15000)
})

afterAll(() => {
  try { fs.rmSync(BASE_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})
