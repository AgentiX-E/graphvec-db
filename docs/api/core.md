# GraphEngine 核心 API 参考

> 模块路径: `src/core/graph-engine.ts`
>
> GraphEngine 是 AgentiX GraphVec 的图引擎核心，提供存储无关的图数据操作接口。
> 所有数据操作通过 `StorageProvider` 接口完成，不直接依赖任何具体存储后端。

---

## 目录

- [GraphEngine 构造器](#new-graphengineconfig)
- [生命周期管理](#open--close)
- [节点操作](#节点操作)
- [边操作](#边操作)
- [邻居查询](#邻居查询)
- [暂停/恢复写入](#暂停恢复写入)
- [数据结构定义](#数据结构定义)

---

## `new GraphEngine(config)`

创建 GraphEngine 实例。

### 签名

```typescript
constructor(
  config: OverGraphConfig,
  storage?: StorageProvider,
  eventStream?: EventStream,
  mlReplication?: MultiLeaderReplication,
  fulltext?: FullTextIndex,
  rls?: RowLevelSecurity,
  planner?: QueryPlanner,
  cipherConfig?: CipherConfig
)
```

### 参数说明

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `config` | `OverGraphConfig` | ✅ | — | 引擎配置 |
| `storage` | `StorageProvider` | ❌ | `new OverGraphStorage()` | 存储后端实例 |
| `eventStream` | `EventStream` | ❌ | `null` | 事件流（集群复制） |
| `mlReplication` | `MultiLeaderReplication` | ❌ | `null` | Multi-Leader 同步复制 |
| `fulltext` | `FullTextIndex` | ❌ | `null` | 全文索引 |
| `rls` | `RowLevelSecurity` | ❌ | `null` | 行级安全 |
| `planner` | `QueryPlanner` | ❌ | `null` | 查询计划器 |
| `cipherConfig` | `CipherConfig` | ❌ | — | 静态加密配置 |

### OverGraphConfig 配置项

```typescript
interface OverGraphConfig {
  /** 存储路径（必需） */
  path: string
  /** 存储后端，默认 'lmdb'（通过 overgraph 实现） */
  backend?: 'lmdb' | 'classic-level'
  /** 密集向量配置，开启向量搜索时需指定维度 */
  denseVector?: { dimension: number }
  /** 节点/边默认保留策略 */
  defaultRetention?: { nodes?: string; edges?: string }
  /** 邻居查询缓存大小，默认 1024 */
  cacheSize?: number
  /** 节点缓存最大条目数，默认 1000 */
  nodeCacheSize?: number
  /** 边缓存最大条目数，默认 500 */
  edgeCacheSize?: number
  /** 邻居查询缓存 TTL（毫秒），默认 5000 */
  neighborCacheTTLMs?: number
  /** OverGraph 存储内核调优参数 */
  overgraph?: {
    compactAfterNFlushes?: number
    memtableFlushThreshold?: number
    memtableHardCapBytes?: number
  }
  /** 启用属性压缩（msgpackr），节省约 20-30% 空间 */
  storageCompression?: boolean
  /** 查询超时毫秒数，默认 30000（0 表示不超时） */
  queryTimeoutMs?: number
  /** 是否持久化内存索引，默认 true */
  persistIndexes?: boolean
}
```

### 示例

```typescript
import { GraphEngine } from './core/graph-engine'

// 基础配置
const config = {
  path: '/data/graph-store',
  denseVector: { dimension: 128 },
  cacheSize: 2048,
  storageCompression: true,
  queryTimeoutMs: 15000,
}

const engine = new GraphEngine(config)

// 设置 Schema（可选）
engine.setSchema({
  nodeTypes: {
    Person: { properties: { name: 'string', age: 'number' } },
    Company: { properties: { name: 'string', founded: 'number' } },
  },
  edgeTypes: {
    WORKS_AT: { properties: { role: 'string', since: 'number' } },
  },
})
```

---

## `open()` / `close()`

打开或关闭数据库存储。

### 签名

```typescript
open(): void
close(): void
```

### 说明

- `open()` 初始化存储层，恢复持久化索引，注册远程事件处理程序。**必须在所有读写操作之前调用。**
- `close()` 持久化内存索引到磁盘，关闭存储层连接。

### 示例

```typescript
engine.open()   // 打开数据库

// ... 执行图操作 ...

engine.close()  // 关闭数据库
```

---

## 节点操作

### `engine.upsertNode(id, typeName, opts?)`

插入或更新一个节点。若节点已存在则更新属性；若不存在则创建。

#### 签名

```typescript
async upsertNode(
  typeId: number,
  name: string,
  opts?: UpsertNodeOptions
): Promise<NodeId>
```

#### 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `typeId` | `number` | 节点类型 ID |
| `name` | `string` | 节点名称 |
| `opts.props` | `NodeProperties` | 可选属性键值对 |
| `opts.denseVector` | `Float32Array \| number[]` | 可选密集向量 |
| `opts.sparseVector` | `Record<number, number>` | 可选稀疏向量 |
| `opts.temporalValidity` | `TemporalValidity` | 可选时间有效性 `{ start?, end? }` |
| `opts.decayFactor` | `number` | 可选衰减因子 |
| `opts.ttlSeconds` | `number` | 可选自动过期秒数 |
| `opts.skipReplication` | `boolean` | 跳过 Multi-Leader 复制 |
| `opts._mvccVersion` | `number` | 内部 MVCC 版本号 |
| `opts._txId` | `string` | 内部事务 ID |

#### 返回值

返回节点 ID (`number`)。触发事件 `node:created` / `node:updated`。

#### 示例

```typescript
// 创建一个人物节点
const personId = await engine.upsertNode(1, 'Alice', {
  props: { age: 30, city: 'Beijing' },
  denseVector: new Float32Array([0.1, 0.2, 0.3, ...]),
})

// 创建公司节点
const companyId = await engine.upsertNode(2, 'Acme Corp', {
  props: { founded: 2000, industry: 'tech' },
})
```

---

### `engine.getNode(id)`

根据节点 ID 获取节点记录。

#### 签名

```typescript
getNode(id: NodeId, ctx?: RLSContext): NodeRecord | null
```

#### 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `id` | `NodeId` | 节点 ID |
| `ctx` | `RLSContext` | 可选行级安全上下文 |

#### 返回值

返回 `NodeRecord` 或 `null`（节点不存在或 RLS 过滤掉时返回 `null`）。

结果会经过 LRU 缓存（无 RLS 上下文时）。

#### 示例

```typescript
const node = engine.getNode(personId)
if (node) {
  console.log(`节点: ${node.name}，类型: ${node.type}`)
  console.log(`属性:`, node.props)
  console.log(`度数:`, node.degree)        // 入度+出度
  console.log(`创建时间:`, node.createdAt)
}
```

---

### `engine.scanAllNodes()`

全表扫描返回所有节点。

#### 签名

```typescript
scanAllNodes(): NodeRecord[]
```

#### 返回值

所有节点的 `NodeRecord[]` 数组。

#### 示例

```typescript
const allNodes = engine.scanAllNodes()
console.log(`总节点数: ${allNodes.length}`)
for (const node of allNodes) {
  console.log(`  - ${node.name} (type=${node.type})`)
}
```

---

### `engine.deleteNode(id)`

删除指定 ID 的节点。支持级联删除关联边。

#### 签名

```typescript
async deleteNode(
  id: NodeId,
  skipReplication?: boolean,
  cascade?: boolean,
  opts?: { _txId?: string }
): Promise<boolean>
```

#### 参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | `NodeId` | — | 要删除的节点 ID |
| `skipReplication` | `boolean` | `false` | 跳过 Multi-Leader 同步复制 |
| `cascade` | `boolean` | `false` | 是否级联删除所有出边 |
| `opts._txId` | `string` | — | 内部事务 ID |

#### 返回值

`true` 如果节点存在且被删除，`false` 如果节点不存在。

#### 示例

```typescript
// 删除节点及其关联边
const deleted = await engine.deleteNode(personId, false, true)
if (deleted) {
  console.log('节点已删除')
}
```

---

## 边操作

### `engine.upsertEdge(src, dst, typeId, opts?)`

插入或更新一条边。若边已存在则更新属性；若不存在则创建。

#### 签名

```typescript
async upsertEdge(
  src: NodeId,
  dst: NodeId,
  typeId: number,
  opts?: UpsertEdgeOptions
): Promise<void>
```

#### 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `src` | `NodeId` | 源节点 ID |
| `dst` | `NodeId` | 目标节点 ID |
| `typeId` | `number` | 边类型 ID |
| `opts.props` | `NodeProperties` | 可选属性 |
| `opts.weight` | `number` | 可选权重 |
| `opts.temporalValidity` | `TemporalValidity` | 可选时间有效性 |
| `opts.skipReplication` | `boolean` | 跳过 Multi-Leader 复制 |

#### 示例

```typescript
// 创建边：Alice WORKS_AT Acme Corp
await engine.upsertEdge(personId, companyId, 10, {
  props: { role: 'Engineer', since: 2023 },
  weight: 0.8,
})

// 创建边：Alice DEPENDS_ON Bob
await engine.upsertEdge(personId, anotherPersonId, 11)
```

---

### `engine.deleteEdge(src, dst, typeId)`

删除指定边。

#### 签名

```typescript
async deleteEdge(
  src: NodeId,
  dst: NodeId,
  typeId: number,
  skipReplication?: boolean,
  opts?: { _txId?: string }
): Promise<boolean>
```

#### 参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `src` | `NodeId` | — | 源节点 ID |
| `dst` | `NodeId` | — | 目标节点 ID |
| `typeId` | `number` | — | 边类型 ID |
| `skipReplication` | `boolean` | `false` | 跳过 Multi-Leader 复制 |
| `opts._txId` | `string` | — | 内部事务 ID |

#### 返回值

`true` 如果边存在且被删除。

#### 示例

```typescript
const deleted = await engine.deleteEdge(personId, companyId, 10)
if (deleted) {
  console.log('边已删除')
}
```

---

### `engine.getEdge(src, dst, typeId)`

获取指定边的记录。

#### 签名

```typescript
getEdge(src: NodeId, dst: NodeId, typeId: number): EdgeRecord | null
```

#### 示例

```typescript
const edge = engine.getEdge(personId, companyId, 10)
if (edge) {
  console.log(`边: ${edge.src} -> ${edge.dst}，类型: ${edge.type}`)
}
```

---

## 邻居查询

### `engine.neighbors(id, opts?)`

获取指定节点的所有邻居节点和边。

#### 签名

```typescript
neighbors(
  id: NodeId,
  opts?: { maxDepth?: number; edgeTypeFilter?: number[] },
  ctx?: RLSContext
): { edges: EdgeRecord[]; nodes: NodeRecord[] }
```

#### 参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | `NodeId` | — | 节点 ID |
| `opts.maxDepth` | `number` | `1` | 遍历深度 |
| `opts.edgeTypeFilter` | `number[]` | — | 边类型过滤 |
| `ctx` | `RLSContext` | — | 可选行级安全上下文 |

#### 返回值

包含 `edges`（边记录数组）和 `nodes`（邻居节点数组）的对象。

结果经过 LRU 缓存（默认 TTL 5 秒，通过 `neighborCacheTTLMs` 配置）。

#### 示例

```typescript
// 获取 Alice 的直接邻居（深度 1）
const { edges, nodes } = engine.neighbors(personId)

console.log(`邻居数: ${nodes.length}`)
for (const neighbor of nodes) {
  console.log(`  -> ${neighbor.name}`)
}

// 按边类型过滤：仅获取 WORKS_AT 关系的邻居
const { edges: workEdges, nodes: colleagues } = engine.neighbors(personId, {
  maxDepth: 2,
  edgeTypeFilter: [10, 11],
})
```

---

## 暂停/恢复写入

### `engine.pauseWrites()` / `resumeWrites()`

暂停所有写入操作用于一致性备份，完成后恢复。

> 注：源码中实现为 `pauseWrites()` / `resumeWrites()`，替代了传统命名 `freeze()` / `unfreeze()`。

#### 签名

```typescript
async pauseWrites(): Promise<() => void>
```

#### 使用方式

`pauseWrites()` 返回一个恢复函数，调用该函数可恢复写入。

#### 行为说明

- 调用 `pauseWrites()` 后，所有新的写入操作将排队等待（抛出 `Writes are frozen for backup` 错误）。
- 当前正在执行的写入不受影响。
- 调用返回的恢复函数后，排队的写入将继续执行。

#### 示例

```typescript
// 暂停写入，执行备份
const resume = await engine.pauseWrites()

try {
  await performBackup(engine)
} finally {
  // 恢复写入
  resume()
}
```

---

## 数据结构定义

### `NodeRecord`

```typescript
interface NodeRecord {
  /** 节点 ID（数字类型） */
  id: NodeId
  /** 节点类型 ID */
  type: number
  /** 节点名称 */
  name: string
  /** 节点属性键值对 */
  props: NodeProperties
  /** 创建时间戳 */
  createdAt?: number
  /** 节点度数（入度 + 出度） */
  degree?: number
  /** MVCC 版本号（由事务系统设置） */
  mvccVersion?: number
}
```

### `EdgeRecord`

```typescript
interface EdgeRecord {
  /** 源节点 ID */
  src: NodeId
  /** 目标节点 ID */
  dst: NodeId
  /** 边类型 ID */
  type: number
  /** 边属性键值对 */
  props: NodeProperties
  /** 创建时间戳 */
  timestamp?: number
}
```

### `NodeProperties`

```typescript
interface NodeProperties {
  [key: string]: string | number | boolean | null | string[] | number[]
}
```

### `NodeId`

```typescript
type NodeId = number
```

### `UpsertNodeOptions`

```typescript
interface UpsertNodeOptions {
  props?: NodeProperties
  denseVector?: Float32Array | number[]
  sparseVector?: Record<number, number>
  temporalValidity?: TemporalValidity
  decayFactor?: number
  ttlSeconds?: number
  skipReplication?: boolean
  /** 内部使用 */
  _mvccVersion?: number
  /** 内部使用 */
  _txId?: string
}
```

### `UpsertEdgeOptions`

```typescript
interface UpsertEdgeOptions {
  props?: NodeProperties
  temporalValidity?: TemporalValidity
  weight?: number
  skipReplication?: boolean
  /** 内部使用 */
  _txId?: string
}
```

---

## 完整使用示例

```typescript
import { GraphEngine } from './core/graph-engine'

// 1. 创建引擎实例
const engine = new GraphEngine({
  path: '/data/graph-demo',
  denseVector: { dimension: 64 },
  storageCompression: true,
})

// 2. 打开数据库
engine.open()

async function main() {
  try {
    // 3. 创建节点
    const alice = await engine.upsertNode(1, 'Alice', {
      props: { age: 30, city: 'Beijing' },
    })
    const bob = await engine.upsertNode(1, 'Bob', {
      props: { age: 28, city: 'Shanghai' },
    })
    const acme = await engine.upsertNode(2, 'Acme Corp', {
      props: { industry: 'Tech', founded: 2010 },
    })

    // 4. 创建边
    await engine.upsertEdge(alice, acme, 10, {
      props: { role: 'Engineer', since: 2022 },
      weight: 0.9,
    })
    await engine.upsertEdge(bob, acme, 10, {
      props: { role: 'Designer', since: 2023 },
      weight: 0.7,
    })

    // 5. 查询节点
    const node = engine.getNode(alice)
    console.log(node?.name, node?.props)

    // 6. 邻居查询
    const { edges, nodes } = engine.neighbors(alice)
    console.log(`Alice 有 ${nodes.length} 个邻居`)

    // 7. 更新节点属性
    await engine.upsertNode(1, 'Alice', {
      props: { age: 31, city: 'Beijing' },
    })

    // 8. 全表扫描
    const all = engine.scanAllNodes()
    console.log(`总计 ${all.length} 个节点`)
  } finally {
    // 9. 关闭
    engine.close()
  }
}

main()
```
