"use strict";
// ============================================================
// RestApiServer — REST API 服务层
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
exports.parseBody = parseBody;
exports.jsonResponse = jsonResponse;
exports.createRestApiServer = createRestApiServer;
const http = __importStar(require("http"));
const auth_1 = require("../security/auth");
// ──────────────────────────────────────────
// 请求解析辅助
// ──────────────────────────────────────────
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            }
            catch {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}
/**
 * 发送 JSON 响应
 */
function jsonResponse(res, statusCode, data) {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}
// ──────────────────────────────────────────
// RestApiServerImpl
// ──────────────────────────────────────────
function createRestApiServer(shardManager, config) {
    const userRegistry = new auth_1.UserRegistry();
    const rateLimiter = new auth_1.RateLimiter();
    const server = http.createServer();
    let actualPort = config.port;
    const routes = [
        // GET /api/status
        {
            method: 'GET',
            path: '/api/status',
            handler: async (_req, res) => {
                const status = shardManager.getShardStatus();
                jsonResponse(res, 200, {
                    status: 'ok',
                    version: '0.1.0',
                    shards: status,
                });
            },
        },
        // POST /api/graph/nodes
        {
            method: 'POST',
            path: '/api/graph/nodes',
            handler: async (req, res) => {
                const body = await parseBody(req);
                if (!body.typeId || !body.name) {
                    jsonResponse(res, 400, { error: 'typeId and name are required' });
                    return;
                }
                const nodeId = await shardManager.upsertNode(Number(body.typeId), String(body.name));
                jsonResponse(res, 200, { id: nodeId });
            },
        },
        // POST /api/register
        {
            method: 'POST',
            path: '/api/register',
            handler: async (req, res) => {
                const body = await parseBody(req);
                if (!body.username || !body.password || !body.role) {
                    jsonResponse(res, 400, { error: 'username, password, and role are required' });
                    return;
                }
                await userRegistry.register(String(body.username), String(body.password), String(body.role));
                jsonResponse(res, 200, { message: 'registered' });
            },
        },
        // POST /api/login
        {
            method: 'POST',
            path: '/api/login',
            handler: async (req, res) => {
                const body = await parseBody(req);
                if (!body.username || !body.password) {
                    jsonResponse(res, 400, { error: 'username and password are required' });
                    return;
                }
                try {
                    const token = await (0, auth_1.authenticateBasic)(userRegistry, String(body.username), String(body.password));
                    jsonResponse(res, 200, { token });
                }
                catch {
                    jsonResponse(res, 401, { error: 'invalid credentials' });
                }
            },
        },
        // POST /api/admin/disable-user
        {
            method: 'POST',
            path: '/api/admin/disable-user',
            handler: async (req, res) => {
                const body = await parseBody(req);
                if (!body.username) {
                    jsonResponse(res, 400, { error: 'username is required' });
                    return;
                }
                const ok = userRegistry.disable(String(body.username));
                jsonResponse(res, ok ? 200 : 404, ok ? { message: 'disabled' } : { error: 'user not found' });
            },
        },
        // POST /api/admin/change-role
        {
            method: 'POST',
            path: '/api/admin/change-role',
            handler: async (req, res) => {
                const body = await parseBody(req);
                if (!body.username || !body.role) {
                    jsonResponse(res, 400, { error: 'username and role are required' });
                    return;
                }
                const ok = userRegistry.changeRole(String(body.username), String(body.role));
                jsonResponse(res, ok ? 200 : 404, ok ? { message: 'role changed' } : { error: 'user not found' });
            },
        },
        // POST /api/admin/unregister
        {
            method: 'POST',
            path: '/api/admin/unregister',
            handler: async (req, res) => {
                const body = await parseBody(req);
                if (!body.username) {
                    jsonResponse(res, 400, { error: 'username is required' });
                    return;
                }
                const ok = userRegistry.unregister(String(body.username));
                jsonResponse(res, ok ? 200 : 404, ok ? { message: 'unregistered' } : { error: 'user not found' });
            },
        },
        // POST /api/admin/ratelimit-allow
        {
            method: 'POST',
            path: '/api/admin/ratelimit-allow',
            handler: async (req, res) => {
                const body = await parseBody(req);
                if (!body.key) {
                    jsonResponse(res, 400, { error: 'key is required' });
                    return;
                }
                rateLimiter.allow(String(body.key));
                jsonResponse(res, 200, { message: 'allowed' });
            },
        },
        // POST /api/admin/ratelimit-reset
        {
            method: 'POST',
            path: '/api/admin/ratelimit-reset',
            handler: async (_req, res) => {
                rateLimiter.reset();
                jsonResponse(res, 200, { message: 'reset' });
            },
        },
        // GET /api/headers
        {
            method: 'GET',
            path: '/api/headers',
            handler: async (_req, res, _parsed) => {
                jsonResponse(res, 200, { secure: true });
            },
        },
    ];
    server.on('request', async (req, res) => {
        try {
            const parsed = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
            // CORS headers
            if (config.enableCors) {
                const origin = process.env.CORS_ORIGIN || '*';
                res.setHeader('Access-Control-Allow-Origin', origin);
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
                if (req.method === 'OPTIONS') {
                    res.writeHead(204);
                    res.end();
                    return;
                }
            }
            // Security headers
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('X-XSS-Protection', '1; mode=block');
            // Body size limit
            if (config.bodySizeLimit && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')) {
                const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
                if (contentLength > config.bodySizeLimit) {
                    jsonResponse(res, 413, { error: 'Request body too large' });
                    return;
                }
            }
            // Rate limit
            if (config.enableRatelimit) {
                const clientIp = req.socket.remoteAddress ?? 'unknown';
                if (!rateLimiter.isAllowed(clientIp)) {
                    jsonResponse(res, 429, { error: 'Too Many Requests' });
                    return;
                }
            }
            // Find matching route
            const method = req.method?.toUpperCase() ?? 'GET';
            const path = parsed.pathname;
            const matched = routes.find(r => r.method === method && r.path === path);
            if (!matched) {
                jsonResponse(res, 404, { error: 'Not Found' });
                return;
            }
            // Auth
            if (matched.auth || config.enableAuth) {
                const authHeader = req.headers['authorization'];
                if (!authHeader) {
                    jsonResponse(res, 401, { error: 'Unauthorized' });
                    return;
                }
                try {
                    const result = await (0, auth_1.authenticateToken)(authHeader);
                    if (!result) {
                        jsonResponse(res, 401, { error: 'Unauthorized' });
                        return;
                    }
                }
                catch {
                    jsonResponse(res, 401, { error: 'Invalid token' });
                    return;
                }
            }
            // Admin token check for admin routes
            if (path.startsWith('/api/admin/') && config.adminToken) {
                const authHeader = req.headers['authorization'];
                if (!authHeader || authHeader !== `Bearer ${config.adminToken}`) {
                    jsonResponse(res, 401, { error: 'Admin token required' });
                    return;
                }
            }
            await matched.handler(req, res, parsed);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Internal Server Error';
            jsonResponse(res, 500, { error: message });
        }
    });
    return {
        start() {
            return new Promise((resolve) => {
                server.listen(config.port, config.host, () => {
                    const addr = server.address();
                    if (addr && typeof addr === 'object') {
                        actualPort = addr.port;
                    }
                    resolve();
                });
            });
        },
        stop() {
            return new Promise((resolve) => {
                server.close(() => resolve());
            });
        },
        getPort() {
            return actualPort;
        },
    };
}
//# sourceMappingURL=rest.js.map