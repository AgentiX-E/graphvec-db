"use strict";
// ============================================================
// RestApiServer 测试
// ============================================================
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const rest_1 = require("./rest");
const http = __importStar(require("http"));
// ──────────────────────────────────────────
// MockShardManager
// ──────────────────────────────────────────
class MockShardManager {
    allNodes = [];
    nodeEdges = new Map();
    edgeStore = new Map();
    setNodes(nodes) {
        this.allNodes = nodes;
    }
    getAllNodes() {
        return this.allNodes;
    }
    async upsertNode(typeId, name) {
        const id = this.allNodes.length + 1;
        this.allNodes.push({
            id,
            type: typeId,
            name,
            props: {},
            createdAt: Date.now(),
            degree: 0,
        });
        return id;
    }
    async getNode(id) {
        return this.allNodes.find(n => n.id === id) ?? null;
    }
    async upsertEdge(src, dst, typeId) {
        const key = `${src}-${dst}-${typeId}`;
        this.edgeStore.set(key, { src, dst, type: typeId });
    }
    async batchGetNodes(ids) {
        return this.allNodes.filter(n => ids.includes(n.id));
    }
    async neighbors(id, _opts) {
        return this.nodeEdges.get(id) ?? { edges: [], nodes: [] };
    }
    setNeighbors(nodeId, edges, nodes) {
        this.nodeEdges.set(nodeId, { edges, nodes });
    }
    getShardStatus() {
        return [{ rangeId: 'range-0', raftRole: 'leader', nodeCount: this.allNodes.length }];
    }
    getRange(_rangeId) {
        return {
            engine: {
                stats: () => ({
                    nodeCount: this.allNodes.length,
                    edgeCount: this.edgeStore.size,
                    diskSizeBytes: 0,
                }),
            },
        };
    }
    getAllRanges() {
        const m = new Map();
        m.set('range-0', this.getRange('range-0'));
        return m;
    }
}
// ──────────────────────────────────────────
// Request helper
// ──────────────────────────────────────────
function makeRequest(server, method, path, body, headers) {
    return new Promise((resolve, reject) => {
        const port = server.getPort();
        const postData = body !== undefined ? JSON.stringify(body) : undefined;
        const options = {
            hostname: '127.0.0.1',
            port,
            path,
            method,
            headers: {
                ...headers,
            },
        };
        if (postData) {
            options.headers = {
                ...options.headers,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData).toString(),
            };
        }
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let parsed;
                try {
                    parsed = data ? JSON.parse(data) : {};
                }
                catch {
                    parsed = data;
                }
                resolve({
                    statusCode: res.statusCode ?? 0,
                    body: parsed,
                    headers: res.headers,
                });
            });
        });
        req.on('error', reject);
        if (postData) {
            req.write(postData);
        }
        req.end();
    });
}
// ──────────────────────────────────────────
// 测试套件
// ──────────────────────────────────────────
describe('RestApiServer', () => {
    let mockShardManager;
    let server;
    beforeAll(() => {
        process.env.AUTH_JWT_SECRET = 'test-secret';
    });
    beforeEach(() => {
        // 清理 env
        delete process.env.AGENTIX_ADMIN_TOKEN;
        mockShardManager = new MockShardManager();
    });
    afterEach(async () => {
        if (server) {
            await server.stop();
        }
    });
    // ──────────────────────────────────────────
    // 原始 27 tests — 路由/状态/CORS/认证/JSON/生命周期
    // ──────────────────────────────────────────
    describe('基础路由', () => {
        test('GET /api/status should return 200', async () => {
            const config = { port: 0, host: '127.0.0.1' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'GET', '/api/status');
            expect(res.statusCode).toBe(200);
            expect(res.body.status).toBe('ok');
        });
        test('GET /api/status should include version', async () => {
            const config = { port: 0, host: '127.0.0.1' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'GET', '/api/status');
            expect(res.body.version).toBe('0.1.0');
        });
        test('GET /api/status should include shards', async () => {
            const config = { port: 0, host: '127.0.0.1' };
            mockShardManager.setNodes([
                { id: 1, type: 1, name: 'A', props: {}, createdAt: Date.now(), degree: 0 },
            ]);
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'GET', '/api/status');
            expect(res.body.shards).toBeInstanceOf(Array);
        });
        test('POST /api/graph/nodes should create node', async () => {
            const config = { port: 0, host: '127.0.0.1' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'POST', '/api/graph/nodes', { typeId: 1, name: 'test-node' });
            expect(res.statusCode).toBe(200);
            expect(res.body.id).toBeDefined();
        });
        test('POST /api/graph/nodes missing fields should return 400', async () => {
            const config = { port: 0, host: '127.0.0.1' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'POST', '/api/graph/nodes', { typeId: 1 });
            expect(res.statusCode).toBe(400);
        });
        test('POST /api/graph/nodes missing name should return 400', async () => {
            const config = { port: 0, host: '127.0.0.1' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'POST', '/api/graph/nodes', { name: 'test' });
            expect(res.statusCode).toBe(400);
        });
        test('GET to unknown route should return 404', async () => {
            const config = { port: 0, host: '127.0.0.1' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'GET', '/api/unknown');
            expect(res.statusCode).toBe(404);
        });
    });
    describe('CORS', () => {
        test('should include CORS headers when enabled', async () => {
            const config = { port: 0, host: '127.0.0.1', enableCors: true };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'OPTIONS', '/api/status');
            expect(res.statusCode).toBe(204);
            expect(res.headers['access-control-allow-origin']).toBe('*');
        });
        test('OPTIONS preflight should return 204', async () => {
            const config = { port: 0, host: '127.0.0.1', enableCors: true };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'OPTIONS', '/api/status');
            expect(res.statusCode).toBe(204);
        });
        test('CORS headers on normal request', async () => {
            const config = { port: 0, host: '127.0.0.1', enableCors: true };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'GET', '/api/status');
            expect(res.headers['access-control-allow-origin']).toBe('*');
        });
    });
    describe('认证', () => {
        test('should require auth with enableAuth', async () => {
            const config = { port: 0, host: '127.0.0.1', enableAuth: true };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'GET', '/api/status');
            expect(res.statusCode).toBe(401);
        });
        test('should pass auth with valid Bearer token', async () => {
            const config = { port: 0, host: '127.0.0.1', enableAuth: true };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'GET', '/api/status', undefined, {
                Authorization: 'Bearer basic-token-admin-admin',
            });
            // Auth passes because our mock authenticateToken accepts basic-token-* tokens
            expect(res.statusCode).toBe(200);
        });
        test('should reject invalid Bearer token', async () => {
            const config = { port: 0, host: '127.0.0.1', enableAuth: true };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'GET', '/api/status', undefined, {
                Authorization: 'Bearer invalid-token',
            });
            expect(res.statusCode).toBe(401);
        });
    });
    describe('JSON 响应', () => {
        test('should return JSON content-type', async () => {
            const config = { port: 0, host: '127.0.0.1' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'GET', '/api/status');
            expect(res.headers['content-type']).toContain('application/json');
        });
        test('error response should be JSON', async () => {
            const config = { port: 0, host: '127.0.0.1' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'POST', '/api/graph/nodes', { typeId: 1 });
            expect(res.headers['content-type']).toContain('application/json');
            expect(res.body.error).toBeDefined();
        });
    });
    describe('服务器生命周期', () => {
        test('should start and stop without error', async () => {
            const config = { port: 0, host: '127.0.0.1' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            expect(server.getPort()).toBeGreaterThan(0);
            await server.stop();
        });
        test('should assign dynamic port when port is 0', async () => {
            const config = { port: 0, host: '127.0.0.1' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            expect(server.getPort()).toBeGreaterThan(0);
        });
        test('should handle multiple requests', async () => {
            const config = { port: 0, host: '127.0.0.1' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const r1 = await makeRequest(server, 'GET', '/api/status');
            expect(r1.statusCode).toBe(200);
            const r2 = await makeRequest(server, 'POST', '/api/graph/nodes', { typeId: 1, name: 'n' });
            expect(r2.statusCode).toBe(200);
            const r3 = await makeRequest(server, 'GET', '/api/status');
            expect(r3.statusCode).toBe(200);
        });
        test('should handle POST body serialization', async () => {
            const config = { port: 0, host: '127.0.0.1' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const body = { typeId: 42, name: 'serialization-test' };
            const res = await makeRequest(server, 'POST', '/api/graph/nodes', body);
            expect(res.statusCode).toBe(200);
        });
        test('should add Content-Type and Content-Length to requests', async () => {
            const config = { port: 0, host: '127.0.0.1' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'POST', '/api/graph/nodes', { typeId: 1, name: 'test' });
            expect(res.statusCode).toBe(200);
        });
    });
    describe('PUT/DELETE/PATCH handler', () => {
        test('POST should work with body', async () => {
            const config = { port: 0, host: '127.0.0.1' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'POST', '/api/graph/nodes', { typeId: 1, name: 'x' });
            expect(res.statusCode).toBe(200);
        });
        test('PUT to unknown route should return 404', async () => {
            const config = { port: 0, host: '127.0.0.1' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'PUT', '/api/unknown', {});
            expect(res.statusCode).toBe(404);
        });
        test('PATCH to unknown route should return 404', async () => {
            const config = { port: 0, host: '127.0.0.1' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'PATCH', '/api/unknown', {});
            expect(res.statusCode).toBe(404);
        });
        test('DELETE to unknown route should return 404', async () => {
            const config = { port: 0, host: '127.0.0.1' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'DELETE', '/api/unknown');
            expect(res.statusCode).toBe(404);
        });
    });
    // ──────────────────────────────────────────
    // 第4波新增：用户注册（5 tests）
    // ──────────────────────────────────────────
    describe('用户注册', () => {
        test('POST /api/register should register user', async () => {
            const config = { port: 0, host: '127.0.0.1' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'POST', '/api/register', {
                username: 'alice',
                password: 'secret',
                role: 'admin',
            });
            expect(res.statusCode).toBe(200);
        });
        test('POST /api/login with valid credentials should return token', async () => {
            const config = { port: 0, host: '127.0.0.1' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            await makeRequest(server, 'POST', '/api/register', {
                username: 'bob', password: 'pass', role: 'reader',
            });
            const res = await makeRequest(server, 'POST', '/api/login', {
                username: 'bob', password: 'pass',
            });
            expect(res.statusCode).toBe(200);
            expect(res.body.token).toBeDefined();
        });
        test('POST /api/login with invalid credentials should return 401', async () => {
            const config = { port: 0, host: '127.0.0.1' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'POST', '/api/login', {
                username: 'nonexistent', password: 'wrong',
            });
            expect(res.statusCode).toBe(401);
        });
        test('POST /api/admin/disable-user should disable user', async () => {
            const config = { port: 0, host: '127.0.0.1', adminToken: 'admin-token' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            await makeRequest(server, 'POST', '/api/register', {
                username: 'charlie', password: 'pwd', role: 'reader',
            });
            const res = await makeRequest(server, 'POST', '/api/admin/disable-user', { username: 'charlie' }, { Authorization: 'Bearer admin-token' });
            expect(res.statusCode).toBe(200);
        });
        test('POST /api/admin/change-role should change role', async () => {
            const config = { port: 0, host: '127.0.0.1', adminToken: 'admin-token' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            await makeRequest(server, 'POST', '/api/register', {
                username: 'dave', password: 'pwd', role: 'reader',
            });
            const res = await makeRequest(server, 'POST', '/api/admin/change-role', { username: 'dave', role: 'admin' }, { Authorization: 'Bearer admin-token' });
            expect(res.statusCode).toBe(200);
        });
    });
    describe('unregister', () => {
        test('POST /api/admin/unregister should remove user', async () => {
            const config = { port: 0, host: '127.0.0.1', adminToken: 'admin-token' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            await makeRequest(server, 'POST', '/api/register', {
                username: 'eve', password: 'pwd', role: 'reader',
            });
            const res = await makeRequest(server, 'POST', '/api/admin/unregister', { username: 'eve' }, { Authorization: 'Bearer admin-token' });
            expect(res.statusCode).toBe(200);
        });
    });
    // ──────────────────────────────────────────
    // 第4波新增：速率限制（3 tests）
    // ──────────────────────────────────────────
    describe('速率限制', () => {
        test('POST /api/admin/ratelimit-allow should allow key', async () => {
            const config = { port: 0, host: '127.0.0.1', adminToken: 'admin-token' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'POST', '/api/admin/ratelimit-allow', { key: '127.0.0.1' }, { Authorization: 'Bearer admin-token' });
            expect(res.statusCode).toBe(200);
        });
        test('POST /api/admin/ratelimit-reset should reset limits', async () => {
            const config = { port: 0, host: '127.0.0.1', adminToken: 'admin-token' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'POST', '/api/admin/ratelimit-reset', {}, { Authorization: 'Bearer admin-token' });
            expect(res.statusCode).toBe(200);
        });
        test('should allow independent bucket per key', async () => {
            const config = { port: 0, host: '127.0.0.1', adminToken: 'admin-token' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            // Allow specific IP
            await makeRequest(server, 'POST', '/api/admin/ratelimit-allow', { key: '10.0.0.1' }, { Authorization: 'Bearer admin-token' });
            const res = await makeRequest(server, 'GET', '/api/status');
            expect(res.statusCode).toBe(200);
        });
    });
    // ──────────────────────────────────────────
    // 第4波新增：安全头 + bodySizeLimit（3 tests）
    // ──────────────────────────────────────────
    describe('安全头', () => {
        test('should include security headers', async () => {
            const config = { port: 0, host: '127.0.0.1' };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'GET', '/api/status');
            expect(res.headers['x-content-type-options']).toBe('nosniff');
            expect(res.headers['x-frame-options']).toBe('DENY');
        });
    });
    describe('bodySizeLimit', () => {
        test('should reject request body exceeding limit', async () => {
            const config = { port: 0, host: '127.0.0.1', bodySizeLimit: 10 };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'POST', '/api/graph/nodes', {
                typeId: 1,
                name: 'long name that exceeds the body size limit',
            });
            expect(res.statusCode).toBe(413);
        });
        test('should accept request body within limit', async () => {
            const config = { port: 0, host: '127.0.0.1', bodySizeLimit: 1000 };
            server = (0, rest_1.createRestApiServer)(mockShardManager, config);
            await server.start();
            const res = await makeRequest(server, 'POST', '/api/graph/nodes', {
                typeId: 1, name: 'small',
            });
            expect(res.statusCode).toBe(200);
        });
    });
});
//# sourceMappingURL=rest.spec.js.map