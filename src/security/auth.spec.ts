// ============================================================
// auth.spec.ts — mTLS 认证引擎 & RBAC 单元测试
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { Authenticator, RBAC, validateAuthConfig, bodySizeLimitMiddleware, BODY_SIZE_LIMIT, BODY_READ_TIMEOUT } from './auth'
import { Role, AuthError, AuthConfig } from '../types'
import * as http from 'http'

// ─── Helpers ──────────────────────────────────────────────────

function makeConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    mode: 'mtls',
    tlsCert: '/tmp/test-cert.pem',
    tlsKey: '/tmp/test-key.pem',
    ...overrides,
  }
}

// ─── Authenticator ────────────────────────────────────────────

describe('Authenticator', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('constructor', () => {
    it('throws if mode is not mtls', () => {
      expect(() => new Authenticator({ mode: 'basic' as any, tlsCert: '/c', tlsKey: '/k' }))
        .toThrow('only mTLS mode is supported')
    })

    it('throws if tlsCert or tlsKey is missing', () => {
      expect(() => new Authenticator({ mode: 'mtls' } as any))
        .toThrow('tlsCert and tlsKey are required')
    })

    it('creates instance with valid config', () => {
      const auth = new Authenticator(makeConfig())
      expect(auth).toBeInstanceOf(Authenticator)
      expect(auth.initialized).toBe(true)
      auth.stopWatch()
    })

    it('loads identities from config', () => {
      const auth = new Authenticator(makeConfig({
        identities: [
          { cn: 'admin-node', role: Role.ADMIN },
          { cn: 'reader-node', role: Role.READER },
        ],
      }))
      expect(auth.listAuthorizedCNs()).toEqual(['admin-node', 'reader-node'])
      auth.stopWatch()
    })

    it('loads identities from identitiesFile', () => {
      const idFile = path.join(tmpDir, 'identities.json')
      fs.writeFileSync(idFile, JSON.stringify({
        identities: [
          { cn: 'file-admin', role: 'admin' },
          { cn: 'file-reader', role: 'reader' },
        ],
      }))
      const auth = new Authenticator(makeConfig({
        identitiesFile: idFile,
      }))
      expect(auth.listAuthorizedCNs()).toEqual(['file-admin', 'file-reader'])
      auth.stopWatch()
    })

    it('merges identities from config and file (file overrides)', () => {
      const idFile = path.join(tmpDir, 'identities.json')
      fs.writeFileSync(idFile, JSON.stringify({
        identities: [
          { cn: 'from-file', role: 'admin' },
        ],
      }))
      const auth = new Authenticator(makeConfig({
        identities: [
          { cn: 'from-config', role: Role.READER },
        ],
        identitiesFile: idFile,
      }))
      const cns = auth.listAuthorizedCNs()
      expect(cns).toContain('from-config')
      expect(cns).toContain('from-file')
      auth.stopWatch()
    })

    it('handles missing identitiesFile gracefully', () => {
      const auth = new Authenticator(makeConfig({
        identitiesFile: '/nonexistent/path/identities.json',
        defaultRole: Role.READER,
      }))
      expect(auth.initialized).toBe(true)
      expect(auth.listAuthorizedCNs()).toEqual([])
      auth.stopWatch()
    })
  })

  describe('authenticate', () => {
    it('returns identity for authorized CN', () => {
      const auth = new Authenticator(makeConfig({
        identities: [
          { cn: 'trusted-node', role: Role.ADMIN, databases: ['db1'] },
        ],
      }))
      const result = auth.authenticate('trusted-node')
      expect(result).toEqual({
        user: 'trusted-node',
        role: Role.ADMIN,
        databases: ['db1'],
      })
      auth.stopWatch()
    })

    it('throws AuthError for unknown CN without defaultRole', () => {
      const auth = new Authenticator(makeConfig({
        identities: [{ cn: 'known', role: Role.ADMIN }],
      }))
      expect(() => auth.authenticate('unknown')).toThrow(AuthError)
      expect(() => auth.authenticate('unknown')).toThrow('is not authorized')
      auth.stopWatch()
    })

    it('returns defaultRole for unknown CN when configured', () => {
      const auth = new Authenticator(makeConfig({
        defaultRole: Role.READER,
        defaultDatabases: ['public'],
      }))
      const result = auth.authenticate('new-guest')
      expect(result).toEqual({
        user: 'new-guest',
        role: Role.READER,
        databases: ['public'],
      })
      auth.stopWatch()
    })

    it('throws for empty CN', () => {
      const auth = new Authenticator(makeConfig())
      expect(() => auth.authenticate('')).toThrow(AuthError)
      expect(() => auth.authenticate('')).toThrow('CN is required')
      auth.stopWatch()
    })

    it('throws for non-string CN', () => {
      const auth = new Authenticator(makeConfig())
      expect(() => auth.authenticate(null as any)).toThrow('CN is required')
      expect(() => auth.authenticate(undefined as any)).toThrow('CN is required')
      auth.stopWatch()
    })
  })

  describe('reloadIdentities', () => {
    it('reloads identities from identitiesFile', () => {
      const idFile = path.join(tmpDir, 'identities.json')
      fs.writeFileSync(idFile, JSON.stringify({
        identities: [{ cn: 'node1', role: 'admin' }],
      }))

      const auth = new Authenticator(makeConfig({
        identitiesFile: idFile,
      }))
      expect(auth.listAuthorizedCNs()).toEqual(['node1'])

      // Update the file and reload
      fs.writeFileSync(idFile, JSON.stringify({
        identities: [
          { cn: 'node1', role: 'admin' },
          { cn: 'node2', role: 'reader' },
        ],
      }))
      auth.reloadIdentities()
      const cns = auth.listAuthorizedCNs()
      expect(cns).toContain('node1')
      expect(cns).toContain('node2')
      expect(cns).toHaveLength(2)
      auth.stopWatch()
    })
  })

  describe('startWatch / stopWatch', () => {
    it('startWatch does not throw if no identitiesFile', () => {
      const auth = new Authenticator(makeConfig({
        identities: [{ cn: 'n1', role: Role.ADMIN }],
      }))
      // Should not throw or crash
      auth.startWatch()
      auth.stopWatch()
    })

    it('stopWatch is safe to call multiple times', () => {
      const auth = new Authenticator(makeConfig())
      auth.stopWatch()
      auth.stopWatch()
      auth.stopWatch()
    })
  })

  describe('listAuthorizedCNs', () => {
    it('returns empty array when no identities loaded', () => {
      const auth = new Authenticator(makeConfig())
      expect(auth.listAuthorizedCNs()).toEqual([])
      auth.stopWatch()
    })
  })
})

// ─── RBAC ─────────────────────────────────────────────────────

describe('RBAC', () => {
  describe('checkPermission', () => {
    it('allows ADMIN any operation', () => {
      expect(() => RBAC.checkPermission(Role.ADMIN, 'anything')).not.toThrow()
    })

    it('allows READER to read', () => {
      expect(() => RBAC.checkPermission(Role.READER, 'read')).not.toThrow()
    })

    it('denies READER write', () => {
      expect(() => RBAC.checkPermission(Role.READER, 'write'))
        .toThrow(AuthError)
    })

    it('denies READER delete', () => {
      expect(() => RBAC.checkPermission(Role.READER, 'delete'))
        .toThrow(AuthError)
    })

    it('denies READER compact', () => {
      expect(() => RBAC.checkPermission(Role.READER, 'compact'))
        .toThrow(AuthError)
    })

    it('allows WRITER read, write, delete', () => {
      expect(() => RBAC.checkPermission(Role.WRITER, 'read')).not.toThrow()
      expect(() => RBAC.checkPermission(Role.WRITER, 'write')).not.toThrow()
      expect(() => RBAC.checkPermission(Role.WRITER, 'delete')).not.toThrow()
    })

    it('denies WRITER compact', () => {
      expect(() => RBAC.checkPermission(Role.WRITER, 'compact'))
        .toThrow(AuthError)
    })

    it('allows OPERATOR all ops operations', () => {
      const ops = ['read', 'write', 'delete', 'compact', 'backup', 'restore', 'reshard', 'health', 'metrics', 'audit']
      for (const op of ops) {
        expect(() => RBAC.checkPermission(Role.OPERATOR, op)).not.toThrow()
      }
    })

    it('denies OPERATOR unknown operations', () => {
      expect(() => RBAC.checkPermission(Role.OPERATOR, 'sudo'))
        .toThrow(AuthError)
    })

    it('throws AuthError with statusCode 403', () => {
      try {
        RBAC.checkPermission(Role.READER, 'delete')
      } catch (e) {
        expect(e).toBeInstanceOf(AuthError)
        expect((e as AuthError).statusCode).toBe(403)
      }
    })
  })

  describe('checkDatabaseAccess', () => {
    it('allows ADMIN any database', () => {
      expect(() => RBAC.checkDatabaseAccess(Role.ADMIN, undefined, 'secret')).not.toThrow()
    })

    it('allows access when databases is undefined', () => {
      expect(() => RBAC.checkDatabaseAccess(Role.READER, undefined, 'any-db')).not.toThrow()
    })

    it('allows access when databases is empty', () => {
      expect(() => RBAC.checkDatabaseAccess(Role.READER, [], 'any-db')).not.toThrow()
    })

    it('allows access to listed database', () => {
      expect(() => RBAC.checkDatabaseAccess(Role.READER, ['db1', 'db2'], 'db1')).not.toThrow()
    })

    it('denies access to unlisted database', () => {
      expect(() => RBAC.checkDatabaseAccess(Role.READER, ['db1'], 'db2'))
        .toThrow(AuthError)
    })
  })

  describe('checkResourceAccess', () => {
    it('allows ADMIN any resource', () => {
      expect(() => RBAC.checkResourceAccess(Role.ADMIN, 'write:anything')).not.toThrow()
    })

    it('allows READER read resource', () => {
      expect(() => RBAC.checkResourceAccess(Role.READER, 'read:nodes')).not.toThrow()
    })

    it('denies READER write resource', () => {
      expect(() => RBAC.checkResourceAccess(Role.READER, 'write:nodes'))
        .toThrow(AuthError)
    })
  })

  describe('getPermissions', () => {
    it('returns all for ADMIN', () => {
      const perms = RBAC.getPermissions(Role.ADMIN)
      expect(perms).toContain('* (all)')
    })

    it('returns read for READER', () => {
      const perms = RBAC.getPermissions(Role.READER)
      expect(perms).toContain('read')
    })

    it('returns read/write/delete for WRITER', () => {
      const perms = RBAC.getPermissions(Role.WRITER)
      expect(perms).toContain('read')
      expect(perms).toContain('write')
      expect(perms).toContain('delete')
    })
  })

  describe('ACL delegation', () => {
    // ACLs are global state — clean up after each test
    afterEach(() => {
      RBAC.clearAcls()
    })

    it('addAcl and getAcls round-trip', () => {
      RBAC.addAcl({ role: 'admin', resource: 'graph', actions: ['read', 'write'] })
      const acls = RBAC.getAcls()
      expect(acls.length).toBeGreaterThanOrEqual(1)
      expect(acls.some(a => a.role === 'admin' && a.resource === 'graph')).toBe(true)
    })

    it('removeAcl returns false when no match', () => {
      expect(RBAC.removeAcl('nobody', 'nothing')).toBe(false)
    })

    it('clearAcls resets all ACLs', () => {
      RBAC.addAcl({ role: 'admin', resource: 'x', actions: ['read'] })
      RBAC.clearAcls()
      expect(RBAC.getAcls()).toEqual([])
    })

    it('aclAllows returns boolean without throwing', () => {
      RBAC.addAcl({ role: 'reader', resource: 'node:1', actions: ['read'] })
      expect(RBAC.aclAllows('reader', 'read', 'node:1')).toBe(true)
      expect(RBAC.aclAllows('reader', 'read', 'node:2')).toBe(false)
    })
  })
})

// ─── validateAuthConfig ───────────────────────────────────────

describe('validateAuthConfig', () => {
  it('returns empty for valid config', () => {
    const errors = validateAuthConfig(makeConfig({
      identities: [{ cn: 'a', role: Role.ADMIN }],
    }))
    expect(errors).toEqual([])
  })

  it('detects non-mtls mode', () => {
    const errors = validateAuthConfig({ mode: 'basic' } as any)
    expect(errors).toContain('auth mode must be "mtls"')
  })

  it('detects missing tlsCert', () => {
    const errors = validateAuthConfig({ mode: 'mtls', tlsKey: '/k' } as any)
    expect(errors).toContain('tlsCert must be configured')
  })

  it('detects missing tlsKey', () => {
    const errors = validateAuthConfig({ mode: 'mtls', tlsCert: '/c' } as any)
    expect(errors).toContain('tlsKey must be configured')
  })

  it('detects missing identities, identitiesFile, and defaultRole', () => {
    const errors = validateAuthConfig(makeConfig())
    expect(errors).toContain(
      'at least one identity, identitiesFile, or defaultRole must be configured'
    )
  })

  it('allows identitiesFile as alternative to identities', () => {
    const errors = validateAuthConfig(makeConfig({
      identitiesFile: '/tmp/ids.json',
    }))
    expect(errors).toEqual([])
  })

  it('allows defaultRole as fallback', () => {
    const errors = validateAuthConfig(makeConfig({
      defaultRole: Role.READER,
    }))
    expect(errors).toEqual([])
  })
})

// ─── bodySizeLimitMiddleware ──────────────────────────────────

describe('bodySizeLimitMiddleware', () => {
  function createMockReqRes(method: string, contentLength?: string): {
    req: http.IncomingMessage
    res: http.ServerResponse
    next: ReturnType<typeof vi.fn>
  } {
    const req = new http.IncomingMessage(null as any)
    req.method = method
    if (contentLength !== undefined) {
      req.headers['content-length'] = contentLength
    }

    const res = new http.ServerResponse(req)
    const next = vi.fn()

    return { req, res, next }
  }

  it('passes through GET requests', () => {
    const { req, res, next } = createMockReqRes('GET')
    const middleware = bodySizeLimitMiddleware()
    middleware(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('passes through DELETE requests', () => {
    const { req, res, next } = createMockReqRes('DELETE')
    const middleware = bodySizeLimitMiddleware()
    middleware(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('passes POST with Content-Length within limit', () => {
    const { req, res, next } = createMockReqRes('POST', '100')
    const middleware = bodySizeLimitMiddleware(1024)
    middleware(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('rejects POST with Content-Length exceeding limit', () => {
    const { req, res, next } = createMockReqRes('POST', '9999')
    const middleware = bodySizeLimitMiddleware(100)
    middleware(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(413)
  })

  it('passes POST with non-numeric Content-Length (falls through to streaming)', () => {
    const { req, res, next } = createMockReqRes('POST', 'NaN')
    const middleware = bodySizeLimitMiddleware(100)
    middleware(req, res, next)
    // parseInt('NaN') returns NaN; NaN > 100 is false, so it falls through
    // to the streaming path, not the Content-Length rejection path.
    // This is the source's own handling — it doesn't block on non-numeric.
    expect(next).toHaveBeenCalled()
  })

  it('passes PUT with Content-Length within limit', () => {
    const { req, res, next } = createMockReqRes('PUT', '500')
    const middleware = bodySizeLimitMiddleware(1024)
    middleware(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('passes PATCH with Content-Length within limit', () => {
    const { req, res, next } = createMockReqRes('PATCH', '200')
    const middleware = bodySizeLimitMiddleware(1024)
    middleware(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('rejects all body payloads when maxSize is 0', () => {
    const { req, res, next } = createMockReqRes('POST', '10')
    const middleware = bodySizeLimitMiddleware(0)
    middleware(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(413)
  })

  it('exposes constants with expected values', () => {
    expect(BODY_SIZE_LIMIT).toBe(10485760)
    expect(BODY_READ_TIMEOUT).toBe(30000)
  })
})

// ─── Deprecated exports ───────────────────────────────────────

describe('deprecated exports', () => {
  let authModule: typeof import('./auth')

  beforeAll(async () => {
    authModule = await import('./auth')
  })

  it('UserRegistry methods all throw', async () => {
    const reg = new authModule.UserRegistry()
    await expect(reg.register()).rejects.toThrow('deprecated')
    await expect(reg.authenticate()).rejects.toThrow('deprecated')
    expect(() => reg.getRole()).toThrow('deprecated')
    expect(() => reg.disable()).toThrow('deprecated')
    expect(() => reg.changeRole()).toThrow('deprecated')
    expect(() => reg.unregister()).toThrow('deprecated')
  })

  it('RateLimiter is a class', () => {
    const limiter = new authModule.RateLimiter()
    expect(limiter).toBeInstanceOf(Object)
  })

  it('authenticateBasic throws', async () => {
    await expect(authModule.authenticateBasic()).rejects.toThrow('deprecated')
  })

  it('authenticateToken throws', async () => {
    await expect(authModule.authenticateToken()).rejects.toThrow('deprecated')
  })

  it('requireAuth throws', async () => {
    expect(() => authModule.requireAuth()).toThrow('deprecated')
  })
})
