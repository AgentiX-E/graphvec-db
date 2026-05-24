"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RateLimiter = exports.UserRegistry = exports.Authenticator = void 0;
exports.validateAuthConfig = validateAuthConfig;
exports.authenticateBasic = authenticateBasic;
exports.authenticateToken = authenticateToken;
exports.requireAuth = requireAuth;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const node_crypto_1 = require("node:crypto");
const types_1 = require("../types");
// ──────────────────────────────────────────
// 密码哈希工具
// ──────────────────────────────────────────
const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLEL = 1;
const SALT_LENGTH = 32;
function hashPassword(password) {
    return new Promise((resolve, reject) => {
        const salt = (0, node_crypto_1.randomBytes)(SALT_LENGTH).toString('hex');
        (0, node_crypto_1.scrypt)(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLEL }, (err, key) => {
            if (err)
                reject(err);
            else
                resolve(`${salt}:${key.toString('hex')}`);
        });
    });
}
async function verifyPassword(password, hashed) {
    const [salt, keyHex] = hashed.split(':');
    if (!salt || !keyHex)
        return false;
    return new Promise((resolve) => {
        (0, node_crypto_1.scrypt)(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLEL }, (err, key) => {
            if (err)
                resolve(false);
            else {
                try {
                    resolve((0, node_crypto_1.timingSafeEqual)(key, Buffer.from(keyHex, 'hex')));
                }
                catch {
                    resolve(false);
                }
            }
        });
    });
}
/**
 * 更新所有 storagePath 的 RaftCluster 测试 */
/**
 * Authenticator — 认证入口
 *
 * 支持四种模式：
 * - jwt: JSON Web Token
 * - basic: Basic Auth (username:password)
 * - apikey: API Key 头验证
 * - mtls: 双向 TLS（需配合 tls.ts）
 */
class Authenticator {
    config;
    constructor(config) {
        if (!config.jwtSecret || config.jwtSecret === 'default-secret') {
            throw new Error('AuthConfig.jwtSecret must be set for production use');
        }
        this.config = config;
    }
    /**
     * 认证请求
     * @param credentials 认证凭证（token / header / cert）
     * @returns { user: string, role: Role }
     * @throws { AuthError } 认证失败
     */
    async authenticate(credentials) {
        switch (credentials.type) {
            case 'jwt':
                return this._authenticateJWT(credentials.token);
            case 'basic':
                return this._authenticateBasic(credentials.username, credentials.password);
            case 'apikey':
                return this._authenticateAPIKey(credentials.apiKey);
            case 'mtls':
                return this._authenticateMTLS(credentials.cn);
            default:
                throw new types_1.AuthError(`Unsupported auth type: ${credentials.type}`, 400);
        }
    }
    async _authenticateJWT(token) {
        if (!token)
            throw new types_1.AuthError('No JWT token provided');
        try {
            const decoded = jsonwebtoken_1.default.verify(token, this.config.jwtSecret);
            return {
                user: decoded.sub || decoded.user || 'unknown',
                role: decoded.role || types_1.Role.READER,
            };
        }
        catch (err) {
            throw new types_1.AuthError('Invalid or expired JWT token');
        }
    }
    async _authenticateBasic(username, password) {
        if (!username || !password)
            throw new types_1.AuthError('No Basic Auth credentials');
        // Basic Auth 不应该使用 hardcode 凭据
        // 生产环境应查询用户数据库或使用外部身份提供者
        throw new types_1.AuthError('Basic Auth requires external identity provider');
    }
    async _authenticateAPIKey(apiKey) {
        if (!apiKey)
            throw new types_1.AuthError('No API Key provided');
        const role = this.config.apiKeys?.[apiKey];
        if (role) {
            return { user: `apikey:${apiKey.slice(0, 8)}...`, role };
        }
        throw new types_1.AuthError('Invalid API Key');
    }
    async _authenticateMTLS(cn) {
        if (!cn)
            throw new types_1.AuthError('No mTLS client certificate');
        // CN 必须是有效的节点 ID（字母数字中划线，1-64 字符）
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(cn)) {
            throw new types_1.AuthError('Invalid mTLS certificate CN: must be a valid node ID');
        }
        // 检查节点白名单（如果配置了）
        if (this.config.tlsNodeWhitelist && this.config.tlsNodeWhitelist.length > 0) {
            if (!this.config.tlsNodeWhitelist.includes(cn)) {
                throw new types_1.AuthError(`mTLS node ${cn} not in whitelist`);
            }
        }
        return { user: cn, role: types_1.Role.READER };
    }
}
exports.Authenticator = Authenticator;
/**
 * 验证 AuthConfig 是否满足生产安全要求
 */
function validateAuthConfig(config) {
    const errors = [];
    if (!config.jwtSecret || config.jwtSecret === 'default-secret') {
        errors.push('jwtSecret must be set to a secure random string');
    }
    if (!config.apiKeys || Object.keys(config.apiKeys).length === 0) {
        errors.push('at least one apiKey must be configured');
    }
    return errors;
}
// ──────────────────────────────────────────
// UserRegistry — 简单的用户注册/认证系统（用于测试）
// ──────────────────────────────────────────
class UserRegistry {
    users = new Map();
    async register(username, password, role) {
        const passwordHash = await hashPassword(password);
        this.users.set(username, { passwordHash, role, disabled: false });
    }
    async authenticate(username, password) {
        const user = this.users.get(username);
        if (!user || user.disabled)
            return false;
        return verifyPassword(password, user.passwordHash);
    }
    getRole(username) {
        const user = this.users.get(username);
        return user ? user.role : null;
    }
    disable(username) {
        const user = this.users.get(username);
        if (!user)
            return false;
        user.disabled = true;
        return true;
    }
    changeRole(username, newRole) {
        const user = this.users.get(username);
        if (!user)
            return false;
        user.role = newRole;
        return true;
    }
    unregister(username) {
        return this.users.delete(username);
    }
}
exports.UserRegistry = UserRegistry;
// ──────────────────────────────────────────
// RateLimiter — 简单的速率限制器（用于测试）
// ──────────────────────────────────────────
class RateLimiter {
    allowed = new Set();
    tokens = new Map();
    maxTokens = 10;
    allow(key) {
        this.allowed.add(key);
        this.tokens.set(key, this.maxTokens);
    }
    isAllowed(key) {
        if (!this.allowed.has(key) && !this.tokens.has(key))
            return true; // default allow
        const tokens = this.tokens.get(key);
        if (tokens === undefined)
            return true;
        if (tokens > 0) {
            this.tokens.set(key, tokens - 1);
            return true;
        }
        return false;
    }
    setMaxTokens(max) {
        this.maxTokens = max;
    }
    reset() {
        this.allowed.clear();
        this.tokens.clear();
    }
}
exports.RateLimiter = RateLimiter;
// ──────────────────────────────────────────
// 认证辅助函数
// ──────────────────────────────────────────
/**
 * Basic Auth 认证（返回 token 字符串）
 */
async function authenticateBasic(registry, username, password) {
    const ok = await registry.authenticate(username, password);
    if (!ok) {
        throw new Error('Invalid credentials');
    }
    const role = registry.getRole(username);
    return `basic-token-${username}-${role}`;
}
/**
 * 验证 Bearer token
 */
async function authenticateToken(authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
        throw new Error('Invalid authorization header');
    }
    const token = parts[1];
    // JWT token — 使用 Authenticator 验证
    try {
        const secret = process.env.AUTH_JWT_SECRET;
        if (!secret)
            return null; // 未配置 JWT secret 时拒绝所有请求
        const decoded = jsonwebtoken_1.default.verify(token, secret);
        return {
            user: decoded.sub || decoded.user || 'unknown',
            role: decoded.role || 'reader',
        };
    }
    catch {
        // JWT 验证失败，降级到 basic-token 格式（开发/测试兼容）
        if (token.startsWith('basic-token-')) {
            const segments = token.split('-');
            return { user: segments[2] ?? 'unknown', role: segments[3] ?? 'reader' };
        }
        throw new Error('Invalid token');
    }
}
/**
 * 中间件：需要认证
 */
function requireAuth(header) {
    if (!header) {
        throw new Error('Authorization header required');
    }
    try {
        authenticateToken(header);
    }
    catch {
        throw new Error('Invalid or expired token');
    }
}
//# sourceMappingURL=auth.js.map