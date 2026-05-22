import jwt from 'jsonwebtoken'
import { Authenticator } from './auth'
import { AuthConfig, Role, AuthError } from '../types'

function makeConfig(overrides?: Partial<AuthConfig>): AuthConfig {
  return {
    mode: 'jwt',
    jwtSecret: 'test-secret',
    jwtExpiryMs: 3600000,
    apiKeys: {
      'valid-api-key-001': Role.ADMIN,
      'valid-api-key-002': Role.READER,
    },
    ...overrides,
  }
}

describe('Authenticator', () => {
  describe('JWT', () => {
    test('should authenticate with a valid JWT token', async () => {
      const config = makeConfig()
      const auth = new Authenticator(config)
      const token = jwt.sign({ sub: 'alice', role: Role.ADMIN }, config.jwtSecret!, { expiresIn: '1h' })

      const result = await auth.authenticate({ type: 'jwt', token })
      expect(result.user).toBe('alice')
      expect(result.role).toBe(Role.ADMIN)
    })

    test('should reject an expired JWT token', async () => {
      const config = makeConfig()
      const auth = new Authenticator(config)
      const token = jwt.sign({ sub: 'bob', role: Role.READER }, config.jwtSecret!, { expiresIn: '0s' })

      // Wait briefly to ensure token expiry
      await new Promise(r => setTimeout(r, 50))

      await expect(auth.authenticate({ type: 'jwt', token })).rejects.toThrow(AuthError)
    })

    test('should reject a token with wrong secret', async () => {
      const config = makeConfig()
      const auth = new Authenticator(config)
      const token = jwt.sign({ sub: 'mallory', role: Role.ADMIN }, 'wrong-secret')

      await expect(auth.authenticate({ type: 'jwt', token })).rejects.toThrow(AuthError)
    })

    test('should reject empty JWT token', async () => {
      const config = makeConfig()
      const auth = new Authenticator(config)

      await expect(auth.authenticate({ type: 'jwt' })).rejects.toThrow(AuthError)
    })
  })

  describe('Basic Auth', () => {
    test('should reject admin/admin hardcoded credentials', async () => {
      const config = makeConfig()
      const auth = new Authenticator(config)

      await expect(
        auth.authenticate({ type: 'basic', username: 'admin', password: 'admin' })
      ).rejects.toThrow(AuthError)
      await expect(
        auth.authenticate({ type: 'basic', username: 'admin', password: 'admin' })
      ).rejects.toThrow('Basic Auth requires external identity provider')
    })

    test('should reject wrong password', async () => {
      const config = makeConfig()
      const auth = new Authenticator(config)

      await expect(
        auth.authenticate({ type: 'basic', username: 'admin', password: 'wrong' })
      ).rejects.toThrow(AuthError)
      await expect(
        auth.authenticate({ type: 'basic', username: 'admin', password: 'wrong' })
      ).rejects.toThrow('Basic Auth requires external identity provider')
    })

    test('should reject empty credentials', async () => {
      const config = makeConfig()
      const auth = new Authenticator(config)

      await expect(
        auth.authenticate({ type: 'basic' })
      ).rejects.toThrow(AuthError)
    })
  })

  describe('API Key', () => {
    test('should authenticate with a valid API Key (admin role)', async () => {
      const config = makeConfig()
      const auth = new Authenticator(config)

      const result = await auth.authenticate({ type: 'apikey', apiKey: 'valid-api-key-001' })
      expect(result.role).toBe(Role.ADMIN)
      expect(result.user).toContain('valid-')
    })

    test('should authenticate with a valid API Key (reader role)', async () => {
      const config = makeConfig()
      const auth = new Authenticator(config)

      const result = await auth.authenticate({ type: 'apikey', apiKey: 'valid-api-key-002' })
      expect(result.role).toBe(Role.READER)
    })

    test('should reject an invalid API Key', async () => {
      const config = makeConfig()
      const auth = new Authenticator(config)

      await expect(
        auth.authenticate({ type: 'apikey', apiKey: 'invalid-key' })
      ).rejects.toThrow(AuthError)
    })

    test('should reject missing API Key', async () => {
      const config = makeConfig()
      const auth = new Authenticator(config)

      await expect(
        auth.authenticate({ type: 'apikey' })
      ).rejects.toThrow(AuthError)
    })

    test('should reject API Key when no apiKeys configured', async () => {
      const config = makeConfig({ apiKeys: {} })
      const auth = new Authenticator(config)

      await expect(
        auth.authenticate({ type: 'apikey', apiKey: 'anything' })
      ).rejects.toThrow(AuthError)
    })
  })

  describe('mTLS', () => {
    test('should authenticate with valid CN (node ID)', async () => {
      const config = makeConfig()
      const auth = new Authenticator(config)

      const result = await auth.authenticate({ type: 'mtls', cn: 'node-01' })
      expect(result.user).toBe('node-01')
      expect(result.role).toBe(Role.READER)
    })

    test('should authenticate with underscore and dash in CN', async () => {
      const config = makeConfig()
      const auth = new Authenticator(config)

      const result = await auth.authenticate({ type: 'mtls', cn: 'my_node-alpha' })
      expect(result.user).toBe('my_node-alpha')
      expect(result.role).toBe(Role.READER)
    })

    test('should reject CN with colon (old user:role format)', async () => {
      const config = makeConfig()
      const auth = new Authenticator(config)

      await expect(
        auth.authenticate({ type: 'mtls', cn: 'service-user:writer' })
      ).rejects.toThrow(AuthError)
    })

    test('should reject CN that looks like a role claim', async () => {
      const config = makeConfig()
      const auth = new Authenticator(config)

      await expect(
        auth.authenticate({ type: 'mtls', cn: 'admin:admin' })
      ).rejects.toThrow(AuthError)
    })

    test('should reject empty CN', async () => {
      const config = makeConfig()
      const auth = new Authenticator(config)

      await expect(
        auth.authenticate({ type: 'mtls' })
      ).rejects.toThrow(AuthError)
    })

    test('should reject empty string CN', async () => {
      const config = makeConfig()
      const auth = new Authenticator(config)

      await expect(
        auth.authenticate({ type: 'mtls', cn: '' })
      ).rejects.toThrow(AuthError)
    })

    test('should reject CN with special characters', async () => {
      const config = makeConfig()
      const auth = new Authenticator(config)

      await expect(
        auth.authenticate({ type: 'mtls', cn: 'node@evil' })
      ).rejects.toThrow(AuthError)
    })

    test('should reject CN outside whitelist when configured', async () => {
      const config = makeConfig({
        tlsNodeWhitelist: ['allowed-node'],
      })
      const auth = new Authenticator(config)

      await expect(
        auth.authenticate({ type: 'mtls', cn: 'unknown-node' })
      ).rejects.toThrow(AuthError)
    })

    test('should accept whitelisted CN', async () => {
      const config = makeConfig({
        tlsNodeWhitelist: ['allowed-node', 'another-node'],
      })
      const auth = new Authenticator(config)

      const result = await auth.authenticate({ type: 'mtls', cn: 'allowed-node' })
      expect(result.user).toBe('allowed-node')
      expect(result.role).toBe(Role.READER)
    })

    test('should work without whitelist (any valid CN allowed)', async () => {
      const config = makeConfig()
      const auth = new Authenticator(config)

      const result = await auth.authenticate({ type: 'mtls', cn: 'any-valid-node' })
      expect(result.user).toBe('any-valid-node')
      expect(result.role).toBe(Role.READER)
    })

    test('should reject CN exceeding 64 chars', async () => {
      const config = makeConfig()
      const auth = new Authenticator(config)

      await expect(
        auth.authenticate({ type: 'mtls', cn: 'a'.repeat(65) })
      ).rejects.toThrow(AuthError)
    })
  })

  describe('Unsupported auth type', () => {
    test('should reject unsupported type', async () => {
      const config = makeConfig()
      const auth = new Authenticator(config)

      await expect(
        auth.authenticate({ type: 'unknown' as any })
      ).rejects.toThrow(AuthError)
    })
  })
})
