# 安全 API 参考

> 模块路径: `src/security/auth.ts`、`src/security/rbac.ts`
>
> AgentiX GraphVec 的安全体系分层设计，涵盖传输层认证、访问控制模型、操作审批和审计追溯。

---

## 目录

- [认证体系总览](#认证体系总览)
- [mTLS Authenticator — 传输层认证](#mtls-authenticator--传输层认证)
- [JwtManager — JWT 签发与验证](#jwtmanager--jwt-签发与验证)
- [ApiKeyManager — API Key 管理](#apikeymanager--api-key-管理)
- [RBAC — 基于角色的访问控制](#rbac--基于角色的访问控制)
- [ACL — 访问控制列表](#acl--访问控制列表)
- [ForceReview — 强制审批流程](#forcereview--强制审批流程)
- [LDAP 认证](#ldap-认证)
- [OIDC 令牌验证](#oidc-令牌验证)
- [AuthenticatorChain — 认证链](#authenticatorchain--认证链)
- [认证配置验证](#认证配置验证)
- [安全最佳实践](#安全最佳实践)

---

## 认证体系总览

```typescript
import { Role } from '../types'

enum Role {
  ADMIN    = 'admin',     // 管理员：完全访问
  OPERATOR = 'operator',  // 运维人员：管理操作
  WRITER   = 'writer',    // 写入者：读写+删除
  READER   = 'reader',    // 只读者：仅查询
}
```

### 认证策略选择

| 认证方式 | 适用场景 | 优先级 |
|----------|----------|--------|
| **mTLS** | 生产环境（默认强制） | 最高 |
| **JWT Bearer Token** | REST API 调用 | 中 |
| **API Key** | 自动化/CI/CD 场景 | 中 |
| **LDAP** | 企业目录服务集成 | 低 |
| **OIDC** | 外部身份提供者集成 | 低 |

---

## mTLS Authenticator — 传输层认证

mTLS 是 GraphVec 的主认证方式。引擎仅支持 `mode: 'mtls'` 认证模式。

### `new Authenticator(config)`

#### 签名

```typescript
constructor(config: AuthConfig)
```

#### AuthConfig 配置

```typescript
interface AuthConfig {
  mode: 'mtls'                                  // 必须为 'mtls'
  tlsCert: string                               // 服务端证书路径
  tlsKey: string                                // 服务端私钥路径
  tlsCA?: string                                // CA 证书路径（可选）
  identities?: AuthorizedIdentity[]             // 授权身份列表
  identitiesFile?: string                       // 身份配置文件路径（支持热加载）
  defaultRole?: Role                            // 未授权 CN 的默认角色
  defaultDatabases?: string[]                   // 默认数据库白名单
}

interface AuthorizedIdentity {
  cn: string          // 证书 Common Name
  role: Role          // 全局角色
  databases?: string[] // 限定可访问的数据库
}
```

#### 验证流程

1. 从客户端证书提取 CN（Common Name）
2. 在授权列表 `identities` 中查找 CN
3. 找到则返回对应的身份和角色
4. 未找到则使用 `defaultRole`（如果配置了）
5. 无 `defaultRole` 则拒绝访问（抛出 `AuthError`）

### 方法

#### `authenticate(cn)`

```typescript
authenticate(cn: string): AuthResult
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `cn` | `string` | 客户端证书的 Common Name |

**返回值**: `AuthResult` — `{ user: string; role: Role; databases?: string[] }`

**异常**: 抛出 `AuthError` 如果 CN 未授权且无默认角色。

#### `startWatch()`

```typescript
startWatch(): void
```

启动身份文件热加载。使用 chokidar 监听 `identitiesFile` 文件变更，即时生效。若 chokidar 不可用，自动降级为 stat 轮询（每 30 秒）。

#### `stopWatch()`

停止文件监控。

#### `reloadIdentities()`

```typescript
reloadIdentities(): void
```

强制重新加载身份配置。

#### `listAuthorizedCNs()`

```typescript
listAuthorizedCNs(): string[]
```

获取所有已授权的 CN 列表。

### 示例

```typescript
import { Authenticator, Role } from './security/auth'

const auth = new Authenticator({
  mode: 'mtls',
  tlsCert: '/etc/certs/server.crt',
  tlsKey: '/etc/certs/server.key',
  identities: [
    { cn: 'alice@example.com', role: Role.ADMIN },
    { cn: 'service-bot', role: Role.WRITER, databases: ['prod-db'] },
  ],
  identitiesFile: '/etc/agentiX/identities.json',
  defaultRole: Role.READER,
})

// 启动热加载
auth.startWatch()

// 验证客户端证书 CN
try {
  const result = auth.authenticate('alice@example.com')
  console.log(`用户: ${result.user}, 角色: ${result.role}`)
} catch (err) {
  console.error('认证失败:', err.message)
}
```

---

## JwtManager — JWT 签发与验证

HMAC-SHA256 JWT 签发与验证，用于 REST API 的 Bearer Token 认证。

### `new JwtManager(secret?)`

```typescript
constructor(secret?: string | Buffer)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `secret` | `string \| Buffer` | 签名密钥（至少 16 字节），默认生成 256-bit 随机密钥 |

### 方法

#### `signToken(userId, role, expiresInSec?)`

```typescript
signToken(userId: string, role: Role, expiresInSec?: number): string
```

签发 JWT Access Token。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `userId` | `string` | — | 用户标识 |
| `role` | `Role` | — | 用户角色 |
| `expiresInSec` | `number` | `3600` | 过期时间（秒） |

**返回值**: JWT token 字符串。

#### `verifyToken(token)`

```typescript
verifyToken(token: string): JwtPayload
```

验证并解码 JWT Token。

| 参数 | 类型 | 说明 |
|------|------|------|
| `token` | `string` | JWT token 字符串 |

**返回值**: `JwtPayload` — `{ userId: string; role: Role; exp: number; iat?: number; type?: string }`

**异常**: 抛出 `AuthError` (401) 如果 token 无效或已过期。

#### `authenticateFromHeader(authHeader)`

```typescript
authenticateFromHeader(authHeader: string | undefined): JwtPayload
```

从 HTTP `Authorization` header 提取并验证 Bearer Token。

#### `signRefreshToken(userId, role, expiresInSec?)`

```typescript
signRefreshToken(userId: string, role: Role, expiresInSec?: number): string
```

签发 Refresh Token（默认 7 天有效期）。

#### `refreshAccessToken(refreshToken, newExpiresInSec?)`

```typescript
refreshAccessToken(refreshToken: string, newExpiresInSec?: number): { accessToken: string; expiresIn: number }
```

使用 Refresh Token 换取新的 Access Token。

#### `loadSecretFromFile(filePath)`

```typescript
static loadSecretFromFile(filePath: string): Buffer
```

从文件加载 JWT secret（第一行内容即为 secret）。

### JwtPayload 接口

```typescript
interface JwtPayload {
  userId: string        // 用户标识
  role: Role            // 用户角色
  exp: number           // 过期时间戳（秒）
  iat?: number          // 签发时间
  type?: string         // Token 类型（如 'refresh'）
}
```

### 示例

```typescript
import { JwtManager, Role } from './security/auth'

// 从文件加载密钥
const secret = JwtManager.loadSecretFromFile('/etc/agentiX/jwt-secret')
const jwt = new JwtManager(secret)

// 签发 Access Token (1 小时)
const token = jwt.signToken('alice', Role.ADMIN, 3600)
console.log('Access Token:', token)

// 签发 Refresh Token (7 天)
const refreshToken = jwt.signRefreshToken('alice', Role.ADMIN)
console.log('Refresh Token:', refreshToken)

// 验证 Token
try {
  const payload = jwt.verifyToken(token)
  console.log(`用户: ${payload.userId}, 角色: ${payload.role}`)
} catch (err) {
  console.error('Token 无效:', err.message)
}

// 刷新 Token
const { accessToken: newToken, expiresIn } = jwt.refreshAccessToken(refreshToken)
console.log(`新 Token (有效期 ${expiresIn}s):`, newToken)
```

---

## ApiKeyManager — API Key 管理

生成和验证 API Key，用于自动化/CI 场景。

### `new ApiKeyManager()`

```typescript
constructor()
```

### 方法

#### `generateApiKey(userId, role)`

```typescript
generateApiKey(userId: string, role: Role): ApiKeyRecord
```

生成新的 API Key。

**格式**: `agx_<random 32 bytes base64url>`

**返回值**: `ApiKeyRecord`

```typescript
interface ApiKeyRecord {
  key: string          // 完整 API Key（仅创建时返回一次）
  keyPrefix: string    // 前 12 位用于识别
  userId: string
  role: Role
  createdAt: number
  enabled: boolean
}
```

#### `validateApiKey(apiKey)`

```typescript
validateApiKey(apiKey: string): { userId: string; role: Role } | null
```

验证 API Key（使用 SHA-256 哈希比对）。

#### `revokeApiKey(apiKey)`

```typescript
revokeApiKey(apiKey: string): boolean
```

按完整 key 禁用（不可逆）。

#### `revokeByPrefix(keyPrefix)`

```typescript
revokeByPrefix(keyPrefix: string): boolean
```

按前缀禁用。

#### `listActiveKeys()`

```typescript
listActiveKeys(): Array<{ keyPrefix: string; userId: string; role: Role; createdAt: number }>
```

列出所有活跃 Key（不含完整 key）。

### 示例

```typescript
import { ApiKeyManager, Role } from './security/auth'

const keyManager = new ApiKeyManager()

// 生成 API Key
const record = keyManager.generateApiKey('ci-bot', Role.WRITER)
console.log(`Key: ${record.key}`)        // 牢记，仅此一次
console.log(`Prefix: ${record.keyPrefix}`)

// 验证
const result = keyManager.validateApiKey(record.key)
console.log(`用户: ${result?.userId}, 角色: ${result?.role}`)

// 禁用
keyManager.revokeApiKey(record.key)
```

---

## RBAC — 基于角色的访问控制

### 内置权限矩阵

| 角色 | 权限 |
|------|------|
| `ADMIN` | `*`（全部） |
| `OPERATOR` | read, write, delete, compact, backup, restore, reshard, health, metrics, audit |
| `WRITER` | read, write, delete |
| `READER` | read |

### 方法

#### `checkPermission(role, operation)`

```typescript
static checkPermission(role: Role, operation: string): void
```

检查角色是否有权限执行操作。无权限时抛出 `AuthError` (403)。

#### `checkDatabaseAccess(role, databases, database)`

```typescript
static checkDatabaseAccess(
  role: Role,
  databases: string[] | undefined,
  database: string
): void
```

检查用户是否有权访问指定数据库。

#### `checkSubgraphPermission(role, subgraph, action)`

```typescript
static checkSubgraphPermission(
  role: Role,
  subgraph: string,
  action: string
): void
```

检查用户对子图的访问权限。子图权限通过 ACL 系统管理。

#### `getSubgraphAcls(subgraph)`

```typescript
static getSubgraphAcls(subgraph: string): AclEntry[]
```

获取指定子图的 ACL 列表（审计用）。

#### `getPermissions(role)`

```typescript
static getPermissions(role: Role): string[]
```

获取角色的所有权限。

### 示例

```typescript
import { RBAC, Role } from './security/auth'

// 简单的权限检查
try {
  RBAC.checkPermission(Role.READER, 'write')
} catch (err) {
  // 抛出 AuthError: "Role 'reader' does not have permission for 'write'"
}

// 数据库访问检查
RBAC.checkDatabaseAccess(Role.WRITER, ['app-db'], 'app-db')  // 通过

// 获取角色权限
console.log(RBAC.getPermissions(Role.OPERATOR))
// ['read', 'write', 'delete', 'compact', 'backup', 'restore', 'reshard', 'health']
```

---

## ACL — 访问控制列表

ACL 扩展了 RBAC 模型，支持按资源粒度的精细权限控制。当未定义 ACL 时，自动回退到角色默认权限。

### 类型定义

```typescript
type AclResourceType = 'database' | 'graph_node' | 'graph_edge' | 'query' | 'subgraph'
type AclAction = 'create' | 'read' | 'update' | 'delete' | 'query' | 'admin'

interface AclEntry {
  role: string
  resource: AclResourceType
  resourceId?: string
  actions: AclAction[]
}
```

### 方法

#### `checkAclPermission(role, action, resource?, resourceId?)`

```typescript
static checkAclPermission(
  role: Role,
  action: string,
  resource?: AclResourceType | string,
  resourceId?: string
): void
```

ACL-aware 权限检查。先检查 ACL，若无则回退到角色默认权限。无权限时抛出 `AuthError` (403)。

#### `addAcl(entry)`

```typescript
static addAcl(entry: AclEntry): void
```

添加 ACL 条目。如果已有相同 `(role, resource, resourceId)` 的条目，将覆盖。

#### `removeAcl(role, resource, resourceId?)`

```typescript
static removeAcl(role: string, resource: string, resourceId?: string): boolean
```

删除匹配的 ACL 条目。返回 `true` 如果删除了至少一条。

#### `aclAllows(role, action, resource?, resourceId?)`

```typescript
static aclAllows(
  role: string,
  action: string,
  resource?: string,
  resourceId?: string
): boolean
```

布尔值权限检查（不抛异常）。`true` = 允许，`false` = 拒绝。

#### `getAcls(role?)`

```typescript
static getAcls(role?: string): AclEntry[]
```

获取 ACL 条目列表，可按角色过滤。

#### `clearAcls()`

```typescript
static clearAcls(): void
```

清空所有 ACL 条目（测试用）。

### 示例

```typescript
import { RBAC, Role } from './security/auth'

// 添加 ACL 条目：授予 alice-user 角色对 prod-db 的读写权限
RBAC.addAcl({
  role: 'alice-user',
  resource: 'database',
  resourceId: 'prod-db',
  actions: ['read', 'update'],
})

// 检查 ACL
RBAC.checkAclPermission('alice-user', 'read', 'database', 'prod-db')  // 通过

// 使用布尔值检查（不抛异常）
if (RBAC.aclAllows('bob-user', 'delete', 'database', 'prod-db')) {
  console.log('允许删除')
} else {
  console.log('无删除权限')
}

// 获取所有 ACL 条目
const allAcls = RBAC.getAcls()
console.log(allAcls)
```

---

## ForceReview — 强制审批流程

要求指定操作必须经过多名审阅者批准才能执行。核心规则：发起人不得审批自己的请求。

### `new ForceReviewManager()`

```typescript
constructor()
```

### 方法

#### `createRequest(operation, requestor, requiredReviewers, requiredApprovals?, ttlMs?)`

```typescript
createRequest(
  operation: string,
  requestor: string,
  requiredReviewers: string[],
  requiredApprovals?: number,
  ttlMs?: number
): ForceReviewRequest
```

创建审批请求。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `operation` | `string` | — | 操作描述 |
| `requestor` | `string` | — | 发起人 |
| `requiredReviewers` | `string[]` | — | 必审人员列表 |
| `requiredApprovals` | `number` | `requiredReviewers.length` | 通过所需人数 |
| `ttlMs` | `number` | `30 * 60 * 1000` (30分钟) | 超时时间（毫秒） |

**返回值**: `ForceReviewRequest`

```typescript
interface ForceReviewRequest {
  id: string
  operation: string
  requestor: string
  requiredReviewers: string[]
  approvedBy: string[]
  rejectedBy: string[]
  status: ReviewStatus   // 'pending' | 'approved' | 'rejected' | 'expired'
  createdAt: number
  expiresAt: number
  requiredApprovals: number
}
```

#### `approve(requestId, reviewer)`

```typescript
approve(requestId: string, reviewer: string): ForceReviewRequest
```

审批通过。达到 `requiredApprovals` 后自动标记为 approved。

#### `reject(requestId, reviewer)`

```typescript
reject(requestId: string, reviewer: string): ForceReviewRequest
```

审批拒绝。**有人拒绝则整个请求被拒绝**（少数否决制）。

#### `getStatus(requestId)`

```typescript
getStatus(requestId: string): ForceReviewRequest | null
```

获取审批状态。自动检查超时。

#### `listRequests(status?)`

```typescript
listRequests(status?: ReviewStatus): ForceReviewRequest[]
```

列出所有审批请求，可按状态过滤。

#### `cleanupExpired()`

```typescript
cleanupExpired(): number
```

清理过期的审批请求。返回清理数量。

#### `getPendingForUser(userId)`

```typescript
getPendingForUser(userId: string): ForceReviewRequest[]
```

获取指定用户的待审批请求列表。

### 示例

```typescript
import { ForceReviewManager } from './security/auth'

const reviewMgr = new ForceReviewManager()

// 创建审批请求：需要至少 2 位审批者通过
const request = reviewMgr.createRequest(
  'DELETE production database',
  'alice',
  ['bob', 'charlie', 'diana'],
  2,    // 2 人通过即可
  60 * 60 * 1000, // 1 小时超时
)
console.log(`审批 ID: ${request.id}`)

// Bob 通过
const afterBob = reviewMgr.approve(request.id, 'bob')
console.log(`状态: ${afterBob.status} (${afterBob.approvedBy.length}/2)`)

// Charlie 通过（达到 2/2 → 自动 approved）
const afterCharlie = reviewMgr.approve(request.id, 'charlie')
console.log(`状态: ${afterCharlie.status}`)  // 'approved'

// 获取待审批
const myPending = reviewMgr.getPendingForUser('bob')
console.log(`我有 ${myPending.length} 个待审批请求`)
```

---

## LDAP 认证

企业 LDAP 目录服务集成，支持用户密码验证、角色映射和子图权限管理。

### `new LdapAuthenticator(config)`

```typescript
constructor(config: LdapConfig)
```

### LdapConfig

```typescript
interface LdapConfig {
  url: string                // LDAP 服务器 URL
  bindDn: string             // 绑定 DN
  bindPassword: string       // 绑定密码
  baseDn: string             // 搜索基础 DN
  userFilter: string         // 用户过滤器 ({{username}} 会替换)
  roleMapping?: Record<string, Role>  // 角色映射
  defaultRole?: Role         // 默认角色
  tls?: boolean              // 启用 TLS
  timeout?: number           // 连接超时（毫秒）
  allowMock?: boolean        // 允许模拟认证（仅测试）
}
```

### 方法

#### `authenticate(username, password)`

```typescript
async authenticate(username: string, password: string): Promise<AuthResult>
```

#### 子图权限管理

```typescript
addSubgraphPermission(perm: SubgraphPermission): void
removeSubgraphPermission(userId: string, subgraph: string): boolean
checkSubgraphPermission(userId: string, subgraph: string, action: 'read' | 'write' | 'admin'): boolean
getUserSubgraphPermissions(userId: string): SubgraphPermission[]
getAllSubgraphPermissions(): SubgraphPermission[]
clearSubgraphPermissions(): void
```

### 示例

```typescript
import { LdapAuthenticator, Role } from './security/auth'

const ldap = new LdapAuthenticator({
  url: 'ldap://ldap.example.com:389',
  bindDn: 'cn=admin,dc=example,dc=com',
  bindPassword: 'secret',
  baseDn: 'dc=example,dc=com',
  userFilter: '(uid={{username}})',
  defaultRole: Role.READER,
  timeout: 5000,
  allowMock: true,  // 开发环境允许模拟
})

const result = await ldap.authenticate('alice', 'password123')
console.log(result) // { user: 'alice', role: 'reader' }
```

---

## OIDC 令牌验证

支持 OAuth2 / OpenID Connect 的外部令牌验证，通过 JWKS（JSON Web Key Set）验证令牌签名。

### `new OIDCValidator(options)`

```typescript
constructor(options: OIDCValidatorOptions)
```

```typescript
interface OIDCValidatorOptions {
  issuer: string       // OIDC Issuer URL
  clientId: string     // 预期 audience (client_id)
  jwksUri?: string     // JWKS 端点地址
}
```

### 方法

#### `validateToken(token)`

```typescript
async validateToken(token: string): Promise<Record<string, unknown>>
```

验证 OIDC token（验证格式、过期时间、issuer 和 audience）。

#### `setJwks(jwks)`

设置本地 JWKS（用于测试或离线验证）。

#### `getCachedJwks()`

获取缓存的 JWKS。

### 示例

```typescript
import { OIDCValidator } from './security/auth'

const oidc = new OIDCValidator({
  issuer: 'https://auth.example.com',
  clientId: 'my-app',
})

const payload = await oidc.validateToken(token)
console.log(`用户: ${payload.sub}`)
```

---

## AuthenticatorChain — 认证链

按注册顺序依次尝试多个认证器，直到有一个成功。

### 方法

#### `use(name, fn)`

```typescript
use(name: string, fn: AuthenticatorFn): void
```

注册认证器。`AuthenticatorFn` 接收 `http.IncomingMessage`，返回 `Promise<AuthResult | null>`。

#### `authenticate(req)`

```typescript
async authenticate(req: http.IncomingMessage): Promise<AuthResult>
```

按注册顺序尝试每个认证器。所有认证器失败时抛出 `AuthError` (401)。

#### `list()`

```typescript
list(): AuthenticatorEntry[]
```

获取当前注册的认证器列表。

### 示例

```typescript
import { AuthenticatorChain, JwtManager } from './security/auth'

const chain = new AuthenticatorChain()

// 注册 JWT 认证器
chain.use('jwt', async (req) => {
  const authHeader = req.headers['authorization']
  if (!authHeader) return null
  const payload = jwt.authenticateFromHeader(authHeader)
  return { user: payload.userId, role: payload.role }
})

// 注册 API Key 认证器
chain.use('apikey', async (req) => {
  const authHeader = req.headers['x-api-key']
  if (!authHeader) return null
  const result = keyManager.authenticateFromHeader(authHeader)
  return result ? { user: result.userId, role: result.role } : null
})

// 执行认证链
const result = await chain.authenticate(req)
console.log(`认证通过: ${result.user} (${result.role})`)
```

---

## 认证配置验证

### `validateAuthConfig(config)`

```typescript
function validateAuthConfig(config: AuthConfig): string[]
```

验证 `AuthConfig` 是否满足生产安全要求。返回错误消息数组，空数组表示配置有效。

#### 示例

```typescript
import { validateAuthConfig } from './security/auth'

const errors = validateAuthConfig({
  mode: 'mtls',
  tlsCert: '/etc/certs/server.crt',
  tlsKey: '/etc/certs/server.key',
})

if (errors.length === 0) {
  console.log('配置有效')
} else {
  console.error('配置错误:', errors.join('; '))
}
```

---

## 安全最佳实践

### 密钥轮换

JWT 和 API Key 应定期轮换：

```typescript
// 定期从文件重新加载 secret
const newSecret = JwtManager.loadSecretFromFile('/etc/agentiX/jwt-secret-v2')
const jwt = new JwtManager(newSecret)

// 旧 Token 会在过期后自动失效
// 为了平滑过渡，可在一段时间内同时支持新旧密钥
```

### 审计链

`AuditEntry` 支持哈希链完整性验证，确保审计日志不可篡改：

```typescript
interface AuditEntry {
  timestamp: string
  operation: string
  user: string
  role: Role
  resource: string
  result: 'success' | 'denied' | 'error'
  latencyMs?: number
  details?: string
  prevHash?: string  // 上一条审计记录的 SHA-256
}
```

### 推荐的生产环境安全配置

```typescript
const PRODUCTION_AUTH_CONFIG: AuthConfig = {
  mode: 'mtls',
  tlsCert: '/etc/certs/server.crt',
  tlsKey: '/etc/certs/server.key',
  identitiesFile: '/etc/agentiX/identities.json',
  // 不设置 defaultRole → 未授权的 CN 将被拒绝
}
```

### 重要安全规则

1. **mTLS 是唯一的生产认证方式**，JWT/API Key 仅作为 REST API 的辅助认证
2. **发起人不得审批自己的请求**（ForceReview）
3. **有人拒绝即全局拒绝**（少数否决制）
4. **API Key 只存储 SHA-256 哈希**，创建后仅返回一次完整 key
5. **Refresh Token 具备独立格式标记**，不可用作 Access Token
6. **认证链的失败意味着整体认证失败**，不会模糊地"部分通过"
