import { TLSConfig } from './tls'
import { AuthConfig } from '../types'

describe('TLSConfig', () => {
  test('should create with mTLS config', () => {
    const config: AuthConfig = {
      mode: 'mtls',
      tlsCert: '/tmp/cert.pem',
      tlsKey: '/tmp/key.pem',
      tlsCA: '/tmp/ca.pem',
    }
    const tls = new TLSConfig(config)
    expect(tls).toBeDefined()
    const opts = tls.getServerOptions()
    expect(opts.key).toBe('/tmp/key.pem')
    expect(opts.cert).toBe('/tmp/cert.pem')
    expect(opts.ca).toBe('/tmp/ca.pem')
    expect(opts.requestCert).toBe(true)
    expect(opts.rejectUnauthorized).toBe(true)
  })

  test('should create with JWT config (TLS disabled)', () => {
    const config: AuthConfig = {
      mode: 'jwt',
      jwtSecret: 'secret',
    }
    const tls = new TLSConfig(config)
    expect(() => tls.getServerOptions()).toThrow('TLS: cert and key must be configured for server mode')
  })

  test('should throw when TLS cert/key missing', () => {
    const config: AuthConfig = {
      mode: 'mtls',
    }
    const tls = new TLSConfig(config)
    expect(() => tls.getServerOptions()).toThrow('TLS: cert and key must be configured for server mode')
  })

  test('getServerOptions returns correct values for TLS without CA', () => {
    const config: AuthConfig = {
      mode: 'mtls',
      tlsCert: '/tmp/server.pem',
      tlsKey: '/tmp/server.key',
    }
    const tls = new TLSConfig(config)
    const opts = tls.getServerOptions()
    expect(opts.ca).toBeUndefined()
    expect(opts.requestCert).toBe(true)
    expect(opts.rejectUnauthorized).toBe(true)
  })

  describe('extractCN', () => {
    test('should extract CN from subject with CN field', () => {
      const cert = { subject: { CN: 'node-01' } }
      expect(TLSConfig.extractCN(cert)).toBe('node-01')
    })

    test('should extract CN from subject with commonName field', () => {
      const cert = { subject: { commonName: 'node-alpha' } }
      expect(TLSConfig.extractCN(cert)).toBe('node-alpha')
    })

    test('should prefer CN over commonName', () => {
      const cert = { subject: { CN: 'node-cn', commonName: 'node-cname' } }
      expect(TLSConfig.extractCN(cert)).toBe('node-cn')
    })

    test('should return null for non-object cert input', () => {
      expect(TLSConfig.extractCN(null)).toBeNull()
      expect(TLSConfig.extractCN(undefined)).toBeNull()
      expect(TLSConfig.extractCN('string')).toBeNull()
      expect(TLSConfig.extractCN(42)).toBeNull()
      expect(TLSConfig.extractCN(true)).toBeNull()
    })

    test('should return null when subject is missing', () => {
      const cert = {}
      expect(TLSConfig.extractCN(cert)).toBeNull()
    })

    test('should return null when subject is not an object', () => {
      const cert = { subject: 'not-an-object' }
      expect(TLSConfig.extractCN(cert)).toBeNull()
    })

    test('should return null when CN is not a string', () => {
      const cert = { subject: { CN: 123 } }
      expect(TLSConfig.extractCN(cert)).toBeNull()
    })

    test('should return null for empty CN string', () => {
      const cert = { subject: { CN: '' } }
      expect(TLSConfig.extractCN(cert)).toBeNull()
    })

    test('should return null for CN with special characters', () => {
      const cert = { subject: { CN: 'admin:admin' } }
      expect(TLSConfig.extractCN(cert)).toBeNull()
    })

    test('should return null for CN containing spaces', () => {
      const cert = { subject: { CN: 'node 01' } }
      expect(TLSConfig.extractCN(cert)).toBeNull()
    })

    test('should return null for CN containing dots', () => {
      const cert = { subject: { CN: 'node.01' } }
      expect(TLSConfig.extractCN(cert)).toBeNull()
    })

    test('should accept CN with underscore and dash', () => {
      const cert = { subject: { CN: 'my_node-01' } }
      expect(TLSConfig.extractCN(cert)).toBe('my_node-01')
    })

    test('should return null for CN exceeding 64 chars', () => {
      const longCN = 'a'.repeat(65)
      const cert = { subject: { CN: longCN } }
      expect(TLSConfig.extractCN(cert)).toBeNull()
    })

    test('should accept CN at max 64 chars', () => {
      const longCN = 'a'.repeat(64)
      const cert = { subject: { CN: longCN } }
      expect(TLSConfig.extractCN(cert)).toBe(longCN)
    })

    test('should handle malformed cert object gracefully', () => {
      const cert = { subject: null }
      expect(TLSConfig.extractCN(cert)).toBeNull()
    })

    test('should handle cert with no subject field gracefully', () => {
      const cert = { someOtherField: 'value' }
      expect(TLSConfig.extractCN(cert)).toBeNull()
    })
  })
})
