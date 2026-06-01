/**
 * C-02: OAuth2/OIDC — 测试
 *
 * 验证 OIDCValidator（JWKS 验证）、AuthenticatorChain、fallback 行为
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { OIDCValidator, AuthenticatorChain, AuthError } from './auth'
import { AuthResult, Role } from '../types'
import * as http from 'http'
import * as crypto from 'node:crypto'

describe('C-02: OAuth2/OIDC', () => {
  // TC1: OIDCValidator token handling
  it('OIDCValidator decodes header from token', () => {
    const validator = new OIDCValidator({
      issuer: 'https://nonexistent-issuer.example.com',
      clientId: 'test-client',
    })

    // decodeHeader is synchronous and doesn't require initialization
    const header = { alg: 'RS256', kid: 'test-key', typ: 'JWT' }
    const decodedHeader = (validator as any)._decodeHeader(
      Buffer.from(JSON.stringify(header)).toString('base64url') + '.payload.sig'
    )
    expect(decodedHeader.alg).toBe('RS256')
    expect(decodedHeader.kid).toBe('test-key')
  })

  // TC2: OIDCValidator token decode
  it('OIDCValidator token handling', () => {
    const validator = new OIDCValidator({
      issuer: 'https://example.com',
      clientId: 'test',
    })

    // Create a minimal valid JWT header/token to test decodeHeader
    const header = { alg: 'RS256', kid: 'test-key', typ: 'JWT' }
    const payload = { sub: 'user123', iss: 'https://example.com', aud: 'test', exp: Math.floor(Date.now() / 1000) + 3600 }
    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url')
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const fakeToken = `${headerB64}.${payloadB64}.fakesignature`

    // Can't verify without JWKS, but we can decode the header
    const decodedHeader = (validator as any)._decodeHeader(fakeToken)
    expect(decodedHeader.alg).toBe('RS256')
    expect(decodedHeader.kid).toBe('test-key')
  })

  // TC3: OIDCValidator rejects invalid token
  it('OIDCValidator rejects malformed token', async () => {
    const validator = new OIDCValidator({
      issuer: 'https://example.com',
      clientId: 'test',
    })

    await expect(validator.validateToken('not-a-jwt')).rejects.toThrow(AuthError)
    await expect(validator.validateToken('a.b.c')).rejects.toThrow()
  })

  // TC4: AuthenticatorChain — tries authenticators in order
  it('AuthenticatorChain runs authenticators in order', async () => {
    const chain = new AuthenticatorChain()
    const callOrder: string[] = []

    // Register authenticators
    chain.use('fail1', async (_req) => {
      callOrder.push('fail1')
      return null
    })
    chain.use('success1', async (_req) => {
      callOrder.push('success1')
      return { userId: 'oidc-user', role: Role.ADMIN } as AuthResult
    })
    chain.use('fail2', async (_req) => {
      callOrder.push('fail2') // should not be reached
      return null
    })

    const req = { headers: {} } as http.IncomingMessage
    const result = await chain.authenticate(req)

    expect(result.userId).toBe('oidc-user')
    expect(result.role).toBe(Role.ADMIN)
    expect(callOrder).toEqual(['fail1', 'success1'])
  })

  // TC5: AuthenticatorChain — all fail
  it('AuthenticatorChain throws when all authenticators fail', async () => {
    const chain = new AuthenticatorChain()

    chain.use('fail1', async (_req) => null)
    chain.use('fail2', async (_req) => null)

    const req = { headers: {} } as http.IncomingMessage
    await expect(chain.authenticate(req)).rejects.toThrow(AuthError)
    await expect(chain.authenticate(req)).rejects.toThrow('Authentication required')
  })

  // TC6: AuthenticatorChain — empty chain
  it('AuthenticatorChain throws with empty chain', async () => {
    const chain = new AuthenticatorChain()
    const req = { headers: {} } as http.IncomingMessage

    await expect(chain.authenticate(req)).rejects.toThrow(AuthError)
  })

  // TC7: AuthenticatorChain — uses AuthResult from successful authenticator
  it('AuthenticatorChain returns correct role from successful authenticator', async () => {
    const chain = new AuthenticatorChain()

    chain.use('token', async (req) => {
      const auth = req.headers['authorization']
      if (auth === 'Bearer valid-token') {
        return { userId: 'api-user', role: Role.WRITER } as AuthResult
      }
      return null
    })

    // Test with valid token
    const req1 = { headers: { authorization: 'Bearer valid-token' } } as unknown as http.IncomingMessage
    const result1 = await chain.authenticate(req1)
    expect(result1.userId).toBe('api-user')
    expect(result1.role).toBe(Role.WRITER)

    // Test without token
    const req2 = { headers: {} } as http.IncomingMessage
    await expect(chain.authenticate(req2)).rejects.toThrow(AuthError)
  })

  // TC8: AuthenticatorChain with error in authenticator
  it('AuthenticatorChain continues after error', async () => {
    const chain = new AuthenticatorChain()

    chain.use('error', async (_req) => {
      throw new Error('Internal error')
    })
    chain.use('backup', async (_req) => {
      return { userId: 'backup-user', role: Role.READER } as AuthResult
    })

    const req = { headers: {} } as http.IncomingMessage
    const result = await chain.authenticate(req)
    expect(result.userId).toBe('backup-user')
  })
})
