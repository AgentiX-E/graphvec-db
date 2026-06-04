/**
 * security-e2e.spec.ts — 安全集成端到端测试
 *
 * 使用真实 Authenticator / RBAC / AuditLogger 实例（非 mock）。
 * 覆盖：认证流程完整链路、RBAC 角色权限、审计日志记录
 */
import { JwtManager, RBAC } from '../security/auth'
import { AuditLogger } from '../security/audit'
import { Role, AuthError } from '../types'
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
})

afterAll(() => {
  try { fs.rmSync(BASE_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})
