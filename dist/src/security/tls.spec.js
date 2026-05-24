"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tls_1 = require("./tls");
describe('TLSConfig', () => {
    test('should create with mTLS config', () => {
        const config = {
            mode: 'mtls',
            tlsCert: '/tmp/cert.pem',
            tlsKey: '/tmp/key.pem',
            tlsCA: '/tmp/ca.pem',
        };
        const tls = new tls_1.TLSConfig(config);
        expect(tls).toBeDefined();
        const opts = tls.getServerOptions();
        expect(opts.key).toBe('/tmp/key.pem');
        expect(opts.cert).toBe('/tmp/cert.pem');
        expect(opts.ca).toBe('/tmp/ca.pem');
        expect(opts.requestCert).toBe(true);
        expect(opts.rejectUnauthorized).toBe(true);
    });
    test('should create with JWT config (TLS disabled)', () => {
        const config = {
            mode: 'jwt',
            jwtSecret: 'secret',
        };
        const tls = new tls_1.TLSConfig(config);
        expect(() => tls.getServerOptions()).toThrow('TLS: cert and key must be configured for server mode');
    });
    test('should throw when TLS cert/key missing', () => {
        const config = {
            mode: 'mtls',
        };
        const tls = new tls_1.TLSConfig(config);
        expect(() => tls.getServerOptions()).toThrow('TLS: cert and key must be configured for server mode');
    });
    test('getServerOptions returns correct values for TLS without CA', () => {
        const config = {
            mode: 'mtls',
            tlsCert: '/tmp/server.pem',
            tlsKey: '/tmp/server.key',
        };
        const tls = new tls_1.TLSConfig(config);
        const opts = tls.getServerOptions();
        expect(opts.ca).toBeUndefined();
        expect(opts.requestCert).toBe(true);
        expect(opts.rejectUnauthorized).toBe(true);
    });
    describe('extractCN', () => {
        test('should extract CN from subject with CN field', () => {
            const cert = { subject: { CN: 'node-01' } };
            expect(tls_1.TLSConfig.extractCN(cert)).toBe('node-01');
        });
        test('should extract CN from subject with commonName field', () => {
            const cert = { subject: { commonName: 'node-alpha' } };
            expect(tls_1.TLSConfig.extractCN(cert)).toBe('node-alpha');
        });
        test('should prefer CN over commonName', () => {
            const cert = { subject: { CN: 'node-cn', commonName: 'node-cname' } };
            expect(tls_1.TLSConfig.extractCN(cert)).toBe('node-cn');
        });
        test('should return null for non-object cert input', () => {
            expect(tls_1.TLSConfig.extractCN(null)).toBeNull();
            expect(tls_1.TLSConfig.extractCN(undefined)).toBeNull();
            expect(tls_1.TLSConfig.extractCN('string')).toBeNull();
            expect(tls_1.TLSConfig.extractCN(42)).toBeNull();
            expect(tls_1.TLSConfig.extractCN(true)).toBeNull();
        });
        test('should return null when subject is missing', () => {
            const cert = {};
            expect(tls_1.TLSConfig.extractCN(cert)).toBeNull();
        });
        test('should return null when subject is not an object', () => {
            const cert = { subject: 'not-an-object' };
            expect(tls_1.TLSConfig.extractCN(cert)).toBeNull();
        });
        test('should return null when CN is not a string', () => {
            const cert = { subject: { CN: 123 } };
            expect(tls_1.TLSConfig.extractCN(cert)).toBeNull();
        });
        test('should return null for empty CN string', () => {
            const cert = { subject: { CN: '' } };
            expect(tls_1.TLSConfig.extractCN(cert)).toBeNull();
        });
        test('should return null for CN with special characters', () => {
            const cert = { subject: { CN: 'admin:admin' } };
            expect(tls_1.TLSConfig.extractCN(cert)).toBeNull();
        });
        test('should return null for CN containing spaces', () => {
            const cert = { subject: { CN: 'node 01' } };
            expect(tls_1.TLSConfig.extractCN(cert)).toBeNull();
        });
        test('should return null for CN containing dots', () => {
            const cert = { subject: { CN: 'node.01' } };
            expect(tls_1.TLSConfig.extractCN(cert)).toBeNull();
        });
        test('should accept CN with underscore and dash', () => {
            const cert = { subject: { CN: 'my_node-01' } };
            expect(tls_1.TLSConfig.extractCN(cert)).toBe('my_node-01');
        });
        test('should return null for CN exceeding 64 chars', () => {
            const longCN = 'a'.repeat(65);
            const cert = { subject: { CN: longCN } };
            expect(tls_1.TLSConfig.extractCN(cert)).toBeNull();
        });
        test('should accept CN at max 64 chars', () => {
            const longCN = 'a'.repeat(64);
            const cert = { subject: { CN: longCN } };
            expect(tls_1.TLSConfig.extractCN(cert)).toBe(longCN);
        });
        test('should handle malformed cert object gracefully', () => {
            const cert = { subject: null };
            expect(tls_1.TLSConfig.extractCN(cert)).toBeNull();
        });
        test('should handle cert with no subject field gracefully', () => {
            const cert = { someOtherField: 'value' };
            expect(tls_1.TLSConfig.extractCN(cert)).toBeNull();
        });
    });
});
//# sourceMappingURL=tls.spec.js.map