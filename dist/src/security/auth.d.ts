import { AuthConfig, AuthResult } from '../types';
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
export declare class Authenticator {
    private config;
    constructor(config: AuthConfig);
    /**
     * 认证请求
     * @param credentials 认证凭证（token / header / cert）
     * @returns { user: string, role: Role }
     * @throws { AuthError } 认证失败
     */
    authenticate(credentials: {
        type: 'jwt' | 'basic' | 'apikey' | 'mtls';
        token?: string;
        username?: string;
        password?: string;
        apiKey?: string;
        cn?: string;
    }): Promise<AuthResult>;
    private _authenticateJWT;
    private _authenticateBasic;
    private _authenticateAPIKey;
    private _authenticateMTLS;
}
/**
 * 验证 AuthConfig 是否满足生产安全要求
 */
export declare function validateAuthConfig(config: AuthConfig): string[];
export declare class UserRegistry {
    private users;
    register(username: string, password: string, role: string): Promise<void>;
    authenticate(username: string, password: string): Promise<boolean>;
    getRole(username: string): string | null;
    disable(username: string): boolean;
    changeRole(username: string, newRole: string): boolean;
    unregister(username: string): boolean;
}
export declare class RateLimiter {
    private allowed;
    private tokens;
    private maxTokens;
    allow(key: string): void;
    isAllowed(key: string): boolean;
    setMaxTokens(max: number): void;
    reset(): void;
}
/**
 * Basic Auth 认证（返回 token 字符串）
 */
export declare function authenticateBasic(registry: UserRegistry, username: string, password: string): Promise<string>;
/**
 * 验证 Bearer token
 */
export declare function authenticateToken(authHeader: string): Promise<{
    user: string;
    role: string;
} | null>;
/**
 * 中间件：需要认证
 */
export declare function requireAuth(header: string | undefined): void;
//# sourceMappingURL=auth.d.ts.map