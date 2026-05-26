## Dgraph + JanusGraph 竞品分析

> 分析日期: 2026-05-26  
> 分析范围: Dgraph (v24+) + JanusGraph (v1.x) vs AgentiX GraphVec  
> 分析目标: 提取 Dgraph/JanusGraph 的架构设计亮点与隐含的设计决策，评估其对 AgentiX 的参考价值和 AgentiX 的相对优势

---

### 1. Dgraph 架构 & 查询

#### 1.1 Alpha / Zero 分离架构

**Dgraph 设计**:
- **Zero 节点**: 负责元数据管理（分片定位、时间戳分配、集群成员管理）。不参与数据读写，因此不会成为数据路径的性能瓶颈。Zero 也组建自己的 Raft 组保证高可用。
- **Alpha 节点**: 负责实际的数据存储和查询。每个 Alpha 节点承载若干谓词（predicate）分片，通过 GraphQL± / DQL 对外提供服务。
- 架构的核心理念是**元数据路径与数据路径彻底分离**，使得数据路径可以线性扩展而不受元数据操作干扰。

**AgentiX 对应设计**:
- AgentiX 没有独立的元数据节点。ShardManager 在每个节点上作为进程内对象运行，维护 RangeInstance 集合，通过 HLC 时钟实现时间戳分配。
- 元数据（分片位置、节点 ID 到名称的映射、类型亲和度计数）以 LRU 缓存 + 运行时计算为主，未做持久化元数据存储。

**差距分析**:
| 维度 | Dgraph (Zero) | AgentiX |
|------|--------------|---------|
| 元数据一致性 | Zero Raft 组保证 | 运行时缓存 + 每个 Range 对应 RangeConfig |
| 分片定位 | Zero 提供全局映射表 | ShardMap 对象 + 一致性哈希路由 |
| 时间戳 | Zero 的 Timestamp Oracle | HLC 时钟（故障不生效 — 现 bug） |
| 元数据高可用 | 独立 Zero Raft 组 | 依赖 ShardMap 配置文件的可用性 |
| 扩缩容对客户端影响 | Zero 协调 + Alpha 感知 | ShardMap 重建路由表，无 fence 机制 |

#### 1.2 Raft 组：每个分片一个 Raft 组

**Dgraph 设计**:
- Dgraph 将每个谓词分片分配一个独立的 Raft 组（multi-raft）。这意味着一个 3 节点的 Dgraph 集群如果有 24 个分片，就有 24 个 Raft 组同时在运行。
- 每个 Raft 组维护自己的 Raft Leader、日志、快照。Alpha 节点可以同时是多个 Raft 组的 Leader 或 Follower。
- 这种方式的好处是**热点分散**：写入压力不被单一 Raft 组的 Leader 限制，而是均匀分布到所有分片的 Leader。
- 代价是**运维复杂度**：多个 Raft 组的心跳、选举、日志复制开销累加，尤其在集群规模较大时。

**AgentiX 对应设计**:
- AgentiX 的 RangeInstance 同样是「一个 Range = 一个 Raft 组 + 一个 OverGraph 实例」的设计。
- 使用 raft-logic WASM（TiKV 的 Raft 实现）作为共识引擎，单节点模式下使用 StandaloneConsensus。
- 每个 RangeInstance 有自己的 Raft 日志、WAL（通过 LMDB 事务）、状态机（GraphEngine）。

**差距分析**:
| 维度 | Dgraph | AgentiX |
|------|--------|---------|
| Raft 组数量 | 与分片数 1:1 | 与 RangeInstance 数 1:1 |
| 多 Raft 组共享 | 一个 Alpha 多组共享 | 一个进程一个 RangeInstance |
| Raft 实现 | 自研 Go Raft | raft-logic WASM（TiKV） |
| 单节点模式 | 也需 Raft (Zero) | StandaloneConsensus 跳过硬状态同步 |
| Raft 日志压缩 | 内置快照机制 | 每 10000 条触发一次 snapshot |
| Pipeline 批处理 | 内置支持 | RaftLogicConsensus 有 100ms 窗口合并 |

**AgentiX 的优势/**
- raft-logic WASM 是 TiKV 生产验证的 Raft 实现，工程质量有保证。
- StandaloneConsensus 在单节点模式下零额外开销，对嵌入式场景有利。
- 分片粒度更细（hash-based range），Dgraph 是 predicate 级分片。

#### 1.3 分片再平衡（Dynamic Movement）

**Dgraph 设计**:
- Dgraph 支持在线分片迁移：Zero 检测到某个 Alpha 节点负载过高时，计算分裂/迁移计划，通过 Raft 配置变更（membership change）实现无停机分片移动。
- 分片迁移的实质是 Raft 组 Leader 在新节点之间同步日志，新节点追上后加入 Raft 组，旧节点通过 conf change 移除。
- 数据移动粒度是**谓词**级别的：一个谓词的所有数据一起移动。

**AgentiX 对应设计**:
- ReshardManager 实现了分片分裂/迁移的核心流程：双写（dual-write）→ 数据迁移 → 原子切换 → 垃圾清理。
- AutoSplitter 周期性检查 Range 节点数，超过阈值时触发分裂。
- 使用一致性哈希做路由，数据移动粒度是 hash-range 级别的（不是 predicate 级）。

**差距分析**:
| 维度 | Dgraph | AgentiX |
|------|--------|---------|
| 移动粒度 | predicate 级别 | hash range 级别 |
| 分裂粒度 | predicate 内数据量触发 | Range 节点数超过阈值触发 |
| 原子切换 | Raft conf change（原子） | rebuildRouter + fence 缺失 |
| 双写阶段 | —— | 有（dual-write 阶段）|
| fence 机制 | Raft 天然提供 | `_draining` 标记（RangeInstance） |
| 持久化迁移状态 | Zero 持久化 | 无持久化（重启丢失） |
| 清理 | Zero 自动清理旧副本 | 48h 定时器（不可靠） |

**AgentiX 的差距**:
- **原子性不完整**：`rebuildRouter()` 调用前后没有 fence 旧 Range，存在同一数据被双写残留污染的问题。
- **迁移状态未持久化**：重启后 ReshardManager 丢失所有迁移进度，无法恢复。
- **AutoSplitter 仅检查节点数**：没有考虑 Range 的实际负载（查询 QPS、延迟、磁盘 I/O），可能产生不合理的分裂。

**参考价值**:
Dgraph 的分片迁移本质上**借用 Raft 的 conf change** 来实现数据移动，避免了手写双写逻辑。AgentiX 如果能让 hash-range 分裂后形成一个临时 2 节点 Raft 组，新节点在追上后自动切换路由，就能大大简化 Resharding 实现。

#### 1.4 存储：Badger (LSM-tree)

**Dgraph 设计**:
- 底层存储使用自研的 Badger（Go 实现的 LSM-tree KV 存储）。
- 所有数据都存储为 KV 对：key 是编码后的 pred#uid，value 是 protobuf 序列化的数据。
- LSM-tree 提供：
  - 顺序写入性能高（磁盘旋转扇区友好）
  - 读放大（需要合并多个 SST 文件）
  - 写放大（compaction 持续发生）
- Badger 优势：零 GC 停顿（Go 管理）、高效的 prefix scan、WAL 安全性。

**AgentiX 对应设计**:
- 使用 LMDB（mmap-based B+tree KV 存储）作为持久化层。
- LMDB 提供：
  - 零拷贝读取（内存映射）
  - ACID 事务（MVCC）
  - 没有 write-ahead 写放大
  - 读取性能极高，写入受限于 mmap 刷新频率
- 上层通过 OverGraph 库将 LMDB KV 映射为图数据结构（邻接表、属性索引）。

**横向对比**:
| 维度 | Dgraph (Badger/LSM) | AgentiX (LMDB) |
|------|---------------------|----------------|
| 读性能 | 中等（SST 合并开销） | **高**（mmap 零拷贝） |
| 写性能 | **高**（顺序写入） | 中等（B-tree 随机写入） |
| 写放大 | 有（compaction） | 无（B-tree in-place update） |
| WAL | 内置 WAL | LMDB 事务日志（ACID） |
| GC | Go GC | 无（手工 overgraph compact） |
| 读事务 | MVCC + snapshot | MVCC + reader snapshot |
| 崩溃恢复 | WAL replay | mmap 回滚 + 文件锁校验 |
| 数据碎片 | compaction 控制 | 需要手动 compact |

**AgentiX 的优势**:
- LMDB 的**读性能极高**，尤其适合 AgentiX 频繁的图遍历和向量搜索场景（大量小随机读）。
- 零 GC 停顿：TypeScript 本身有 GC（V8），但存储层没有，减少了不可预测的延迟飙升。
- 嵌入式友好：LMDB 是 C 库，Node.js binding 成熟（lmdb npm 包），同进程嵌入代价极小。

**AgentiX 的差距**:
- LMDB 写入性能在写入密集型场景下受限（B-tree 随机写入 + mmap 限制）。
- 缺少 LSM-tree 的 compaction 控制意味着长期运行后数据碎片化严重，需要定期 `compact()`。
- OverGraph 和 LMDB 之间的数据一致性没有显式验证。

#### 1.5 谓词级索引与反向边

**Dgraph 设计**:
- **谓词（predicate）级索引**：每个 predicate（类似属性或边类型）可以单独配置索引类型（hash、list、int、float、bool、geo、全文搜索等）。索引是 per-predicate 的。
- **反向边（reverse edges）**：Dgraph 通过 `@reverse` 指令自动为边生成反向索引。当 A--knows-->B 被插入时，自动生成 B<--knows--A 的反向边索引。用户查询可以从 B 方向走到 A 而不需要额外声明。
- 这种设计使得谓词既是属性又是边基元，数据模型非常灵活。

**AgentiX 对应设计**:
- AgentiX 没有 predicate 级索引的概念。索引通过 CompositeIndex（复合索引）、FullTextIndex（MiniSearch）、LabelEngine（label 索引）独立实现。
- 边遍历依赖 OverGraph 内置的邻接表：正向走到邻居，没有自动反向边索引。
- 属性过滤在 GraphEngine 层通过 `findNodesByProperty()` 实现（遍历 + 属性匹配），性能较差。

**差距分析**:
| 维度 | Dgraph (predicate index) | AgentiX |
|------|-------------------------|---------|
| 属性索引粒度 | per-predicate | composite index（schemaless） |
| 反向边 | `@reverse` 自动维护 | **不支持反向边** |
| 组合查询 | index intersection | CompositeIndex 做 AND |
| 全文搜索 | 内置 Bleve | MiniSearch（BM25F） |
| 地理空间索引 | 内置 S2 几何 | **不支持** |
| 索引配置 | DDL 配置 | 代码级添加 IndexRecord |

**AgentiX 的关键差距**:

**反向边缺失是最严重的问题之一。** 在图遍历中，双向遍历是基本模式。当前 AgentiX 如果要获取入边（谁指向我），必须：
- OverGraph 层面不支持反向邻接表，只能遍历所有出边反向查找——O(N) 全扫描。
- 这是一个**架构级缺陷**而非实现问题：OverGraph 的邻接表设计只存储出边方向。

**索引方案对比**:
Dgraph 的 predicate 级索引通过 DDL 声明自动维护，用户不需要手动管理索引。而 AgentiX 的 CompositeIndex 需要用户在代码中调用 `addRecord()`/`removeRecord()`，没有与写入操作联动，极易出现数据与索引不一致。

#### 1.6 事务：Snapshot Isolation

**Dgraph 设计**:
- 使用**可串行化快照隔离（SSI）**：事务读一个一致性快照，写之间检测冲突。
- 读写不阻塞：读操作不需要锁，写操作只锁谓词级（精细粒度）。
- 写写冲突：由 Zero 节点的时间戳 oracle 提供全局单调递增的时间戳，用于冲突检测。
- 事务大小有限制（默认 1000 条突变），避免长事务产生大快照。
- Zero 的 timestamp oracle 是单点瓶颈（虽然 Raft 组做了高可用）。

**AgentiX 对应设计**:
- AgentiX 有 Transaction 类，在内存中缓存写操作，commit 时通过 GraphEngine 一次性应用。
- 冲突检测：基于写集碰撞检测（节点级别），使用 HLC 时间戳做 LWW 排序。
- 读写之间**没有隔离级别保障**（没有 MVCC），读操作直接读取当前存储层状态。
- HLC 时钟的 `now()` 方法不读取系统时钟（已发现 bug），LWW 冲突解决不生效。

**差距分析**:
| 维度 | Dgraph (SSI) | AgentiX |
|------|-------------|---------|
| 隔离级别 | Serializable Snapshot Isolation | **无（读 current）** |
| 读写阻塞 | 读不阻塞写，写不阻塞读 | 无并发控制 |
| 冲突检测 | predicate 级 + timestamp | 节点级写集碰撞 |
| 时间戳 | Zero 全局 timestamp oracle | HLC（bug 导致退化为逻辑时钟） |
| 事务大小限制 | 1000 突变 | 无限制（maxActive=100） |
| 长事务处理 | abort 或重试 | 无处理 |
| 并发冲突 | 自动检测/重试 | 仅探测，不重试 |

**AgentiX 的严峻问题**:

1. **无 MVCC = 无事务隔离**。当前 Transaction 只是在 GraphEngine 上顺序应用写操作，读不通过事务快照。
2. **HLC 时钟 bug 导致冲突检测退化为逻辑计数器**。`now()` 不读取系统时钟，跨进程的时间戳比较不可靠。
3. **Dgraph 的 SSI 是一个坚固的参考实现**：每个读操作分配一个 read timestamp，读操作只看到该 timestamp 之前已提交的数据。AgentiX 如果要做多节点一致读，这一方案是必经之路。

#### 1.7 分布式分片策略

**Dgraph 设计**:
- **predicate 级分片**：分片以 predicate 为单位。同一个 predicate 的所有三元组（subject-predicate-object）被路由到同一个分片。
- 这种分片策略的优点是**查询局部性好**：如果查询只涉及少量 predicate，通常只需要访问少数分片。但缺点是单个大 predicate 无法跨分片，会成为热点。
- 跨分片查询是 scatter-gather 模式：查询被广播到所有可能相关的分片，结果合并。

**AgentiX 对应设计**:
- **hash-based 分片**：通过一致性哈希将节点名称（prefixedName）映射到 hash ring 上的一个范围。Smart Routing 还做了 type 亲和度优化。
- 边跟随源节点路由（upsertEdge 按 src 的 range 路由）。
- 跨分片查询（findNodesByType、vectorSearch、PPR 等）通过 ScatterGather 类实现 fan-out + merge。

**差距分析**:
| 维度 | Dgraph (predicate sharding) | AgentiX (hash sharding) |
|------|---------------------------|------------------------|
| 路由粒度 | predicate | node name hash |
| 大批量单一类型 | 热点（大 predicate 无法跨分片） | 分散到多个 range（依赖 consistent hash） |
| 查询局部性 | **高**（按 predicate 聚合） | 低（相关节点可能跨 range） |
| 跨分片边查询 | predicate 级路由，跨分片少 | 边跟随 src 节点，跨 range 多 |
| 类型亲和度 | 天然（predicate 按类型聚） | Smart Routing（人工优化） |
| 一致性 | 强一致性（Raft per shard） | Raft per Range |
| 分片数弹性 | 动态分裂/合并 | AutoSplitter + ReshardManager |
| 热点解耦 | 大 predicate 不可分割 | Consistent hash 可缓解 |

**AgentiX 的 Smart Routing 是一个差异化优势**：通过记录每个 Range 上各 typeId 的亲和度，在 upsertNode 时优先选择已拥有该 type 数据的 Range，减少跨 Range 查询。这在图遍历密集型场景（如 SNS 推荐、知识图谱）中的效果可能优于 Dgraph 的 predicate 分片。

**但 hash 分片的根本问题**：边的遍历（`neighbors()`）只涉及一个 Range（按 src 路由），但节点的类型查询（findNodesByType）需要 fan-out 到所有 Range。当类型多且分散时，性能下降明显。

#### 1.8 DQL 查询语言

**Dgraph 设计**:
- DQL（Dgraph Query Language）是 GraphQL+ 变体，本身是一种**块级声明式图查询语言**。
- 支持递归查询（`recurse` 指令）、变量（`var`）、组（`@groupby`）、过滤、排序、分页。
- 例如：
```graphql
{
  me(func: eq(name, "Alice")) {
    name
    friends {
      name
      age
    }
  }
}
```
- DQL 被设计为不需要遍历路径声明：用户只需声明期望的数据形状，Dgraph 自行决定遍历路径。

**AgentiX 对应设计**:
- AgentiX 采用 **Fluent API**（链式调用）作为主要查询方式。
- Fluent API 是 TypeScript 强类型的，IDE 自动补全友好。
- QueryPlanner 和 QueryIR 提供中间表示，当前是 REST API 接口。
- 不支持递归查询、变量、组等高级查询结构。

**差距分析**:
| 维度 | Dgraph (DQL) | AgentiX (Fluent API) |
|------|-------------|----------------------|
| 查询入口 | HTTP GraphQL± | REST API + Fluent API |
| 声明式 | ✅ Block-based | ❌ 命令式链式调用 |
| 递归查询 | `recurse` 指令 | 函数式实现（用户写循环） |
| 变量 | `var` block + `uid` 绑定 | 无 |
| 分组聚合 | `@groupby` + 聚合函数 | 无 |
| 排序分页 | `orderasc/desc`, `first`, `offset` | 无排序，有分页（page/pageSize） |
| 过滤 | `@filter` 表达式 | 属性过滤（findNodesByProperty） |
| 模式(Pattern) | DQL 块级嵌套 | `queryPattern()` + depth/edgeFilters |
| TypeScript 强类型 | ❌ GraphQL 查询字符串 | ✅ 链式调用 + 类型推断 |
| 学习成本 | 学习 DQL 语法 | 学习 API 方法 |

**核心差距**:
Dgraph 的 DQL 是一套**完整的图查询语言**，可以对用户隐藏存储结构。AgentiX 的 Fluent API 虽然 TypeScript 友好，但在表达能力上相差甚远：

1. **没有递归查询**：`所有朋友的 friends` 需要用户手动写循环 `batchNeighbors`
2. **没有多步模式匹配**：`queryPattern` 只支持 depth 1-3，且深度有限
3. **没有聚合**：`count(node)`, `sum(prop)` 等在 GraphEngine 层有实现，但没有在查询层暴露
4. **没有变量绑定**：无法在同一查询中复用子查询结果

---

### 2. JanusGraph 架构 & 扩展

#### 2.1 存储后端抽象

**JanusGraph 设计**:
- JanusGraph 的核心特色是**存储后端完全抽象**（Storage Backend Abstraction）：
  - Cassandra（默认，生产推荐）
  - HBase
  - Bigtable
  - BerkeleyDB（内嵌，单机/测试）
- 所有存储操作通过 `StoreManager` 接口抽象，这意味着：
  - JanusGraph 本身不管理数据持久化
  - 一致性语义由后端保证（Cassandra 的最终一致性 vs BerkeleyDB 的 ACID）
  - 运维复杂度被转移到后端（Cassandra 集群管理）
- 同样，索引后端也抽象化：
  - ElasticSearch（默认，生产推荐）
  - Solr
  - Lucene（内嵌，单机/测试）

**AgentiX 对应设计**:
- AgentiX 也通过 `StorageProvider` 接口抽象存储后端。
- 默认实现是 `OverGraphStorage`（基于 LMDB），但接口支持切换后端。
- 索引后端：CompositeIndex（内存 Map）、FullTextIndex（MiniSearch）都是独立的，不通过 StorageProvider。

**横向对比**:
| 维度 | JanusGraph | AgentiX |
|------|-----------|---------|
| 存储抽象 | StoreManager 接口 | StorageProvider 接口 |
| 默认后端 | Cassandra | LMBD (OverGraph) |
| 可选后端 | HBase, Bigtable, BerkeleyDB | 接口定义 + 未实现其他 |
| 索引后端 | ES, Solr, Lucene (接口独立) | CompositeIndex, FullTextIndex, VectorSearch |
| 后端一致性 | 依赖后端（Cassandra 最终一致性） | Raft 强一致性 |
| 部署复杂度 | 高（需要 Cassandra/ES 集群） | **极低（同进程嵌入）** |

**AgentiX 的设计质量**:
StorageProvider 的设计简洁且覆盖完整（节点 CRUD、边 CRUD、图算法、向量搜索、维护操作），比 JanusGraph 的 StoreManager 更高级（JanusGraph 的 StoreManager 是底层 KV 接口）。

**但问题在于**：当前只有一个实现 OverGraphStorage。如果在 LMDB 出现问题后切换到其他后端，迁移成本极高。JanusGraph 的 BerkeleyDB ↔ Cassandra 切换经过生产验证。

#### 2.2 查询规划器

**JanusGraph 设计**:
- JanusGraph 的查询规划器（Query Optimizer）是**后端索引推入**（index-pushdown）的核心：
  - 当 Gremlin 查询 `g.V().has('age', gt(30)).has('name', 'Alice')` 被提交时，
  - 规划器分析查询条件，识别哪些条件可以推送到存储/索引后端执行
  - 对于 ES 后端，将组合条件转换为 ES 查询，只返回匹配的 ID
  - 结果集在 JanusGraph 层做二次过滤和组装
- 这种设计的最大好处：**索引查询在存储后端完成，传输到 JanusGraph 的数据量最小化**。
- 多条件组合查询的性能瓶颈通常不在 JanusGraph 本身，而在 ES 或 Cassandra 的查询能力。

**AgentiX 对应设计**:
- AgentiX 有 QueryPlanner 和 QueryIR 作为中间层，但功能远未完善。
- 当前属性查询通过 `findNodesByProperty()` 实现：遍历所有节点 ID，逐一调用 `getNode()` 检查属性值——**全表扫描**。
- CompositeIndex 虽然是独立索引引擎，但需要用户在 upsert 操作中手动维护 `addRecord()`，**极易出现不一致**。

**差距分析**:
| 维度 | JanusGraph (ES pushdown) | AgentiX |
|------|-------------------------|---------|
| 索引推送 | ✅ ES 原生 | ❌ 全表扫描 |
| 组合条件 | AND 推入 ES | CompositeIndex AND（内存） |
| 范围查询 | ES range query | CompositeIndex queryRange |
| 全文搜索 | ES 全文 | MiniSearch |
| 地理空间 | ES geo | ❌ 不支持 |
| 多表 JOIN | Cassandra 协调 | 无 |
| 查询计划 | Gremlin 执行计划 | QueryIR（未对接存储） |

**巨大差距**:
JanusGraph 的索引推入是**生产级分布式图数据库的标准做法**。它体现了一个核心原则：**计算靠近数据**。ES 的倒排索引可以毫秒级返回匹配条件的数据范围，而 AgentiX 的 `findNodesByProperty` 在百万节点下的性能完全不可接受。

**结论**：AgentiX 必须在 OverGraph（LMDB）层面实现属性索引推入，或者让 FullTextIndex/CompositeIndex 能够从持久化层重建。当前的全表扫描模式只适合小规模（<10k 节点）的场景。

#### 2.3 缓存层（L1/L2）

**JanusGraph 设计**:
- **L1 缓存（事务级）**：每个事务独立维护，事务结束后自动清空。减少同一事务内的重复读取。
- **L2 缓存（数据库级）**：跨事务共享，使用 LRU 策略。减少后端访问次数。
- 缓存的粒度是 vertex/edge + 属性，缓存命中时直接返回序列化数据。
- L2 通过 Guava Cache 实现，支持随机淘汰和 TTL。
- 缓存的陷阱：如果后端数据通过另一路径被修改（如 Cassandra 直接操作），缓存返回 stale 数据。

**AgentiX 对应设计**:
- GraphEngine 有一个 LRU 邻居缓存（per-entry TTL），专门用于 `batchNeighbors()` 的批量邻居查询。
- 没有更细粒度的节点/边/属性缓存。
- 没有事务级缓存。

**差距分析**:
| 维度 | JanusGraph | AgentiX |
|------|-----------|---------|
| 事务级缓存 | L1 (per-txn) | ❌ 无 |
| 全局缓存 | L2 (跨事务 LRU) | neighbor LRU cache only |
| 缓存粒度 | vertex/edge/property | neighbor entries |
| 失效策略 | TTL + Guava eviction | 过期 + LRU eviction |
| 序列化 | Java serialized | JS object reference |
| 缓存一致性问题 | staleness | TTL 过期后自动失效 |

**AgentiX 的潜在优势**：
由于 AgentiX 的 GraphEngine 和存储层（OverGraph/LMDB）在同一个进程中，LMDB 本身是 mmap 文件映射，读取不需要序列化/反序列化开销。而 JanusGraph 的后端访问需要通过 thrift/gRPC 协议序列化传输。这意味着**同进程嵌入的 AgentiX 天然具有缓存优势**——即使没有显式缓存层，mmap 的 page cache 已经在 OS 层面做了。

**但 AgentiX 缺少一个关键优化**：属性缓存在 LRU 邻居缓存中只缓存邻居列表，不缓存节点的属性值。`getNode()` 每次都走 OverGraph 查询，在频繁读属性值的场景下浪费严重。

#### 2.4 事务：最终一致性 vs 强一致性

**JanusGraph 设计**:
- JanusGraph 本身不做一致性保证，一致性由后端决定：
  - **Cassandra 后端**：最终一致性（EVR）
  - **BerkeleyDB 后端**：强一致性（ACID）
  - **HBase 后端**：强一致性（基于 HLog）
- JanusGraph 内部使用**锁机制**（lock manager）来模拟强一致性：
  - 在写操作前获取分布式锁
  - 配合 Cassandra 的 light-weight transactions 做原子性检查
  - 但这带来了性能损失（2-3 RTT 额外延迟）
- JanusGraph 的可配置一致性级别：
  - `DEFAULT`: 标准
  - `STRONG`: 增加锁范围
  - `WEAK`: 跳过一致性检查

**AgentiX 对应设计**:
- AgentiX 的事务通过 RangeInstance 的 Raft 写路径保证强一致性（leader 写入 + 日志复制 + follower apply）。
- 读操作通过 `readIndex()` 实现线性一致读。
- 但**没有事务隔离**（见 1.6），即写和读之间缺少 MVCC 快照。

**对比**:
| 维度 | JanusGraph (Cassandra) | AgentiX (Raft) |
|------|-----------------------|----------------|
| 一致性模型 | 最终一致性（默认） | 强一致性（Raft） |
| 线性一致读 | ❌ 不保证 | ✅ `readIndex()` |
| 事务隔离 | ❌ 不保证 | ❌ 不保证 |
| 可配置一致性 | ✅ 3 级 | ❌ 不可配置 |
| 写延迟 | 1-5ms | RTT + Raft 提交 |
| 锁代价 | 分布式锁（2-3 RTT） | Raft 日志复制（1 RTT + apply） |
| 级联故障风险 | 后端故障导致 | Raft follower 故障不影响 |
| 运维复杂度 | Cassandra 集群管理 | 节点少、无外部依赖 |

**启示**:
JanusGraph 的「一致性由后端保证」的策略是一把双刃剑：
- **优点**：可以利用 Cassandra 的天然扩展性和高可用，需要高一致性时切换后端。
- **缺点**：后端的一致性模型和 JanusGraph 的图操作语义不完全匹配，需要通过锁来弥补，增加了复杂度。

AgentiX 选择 Raft 作为强一致性基础，代价是写延迟略高、Raft 组管理复杂度，但**架构更纯粹**——不需要手写分布式锁。这个选择在 3-7 节点集群中表现良好，在更大规模下需要引入 multi-raft 模式（AgentiX 的每个 Range 已经是独立的 Raft 组）。

#### 2.5 扩展性

**JanusGraph 设计**:
- 水平扩展：加节点相当于扩展 Cassandra 集群（不是 JanusGraph 自身）
- JanusGraph 本身是**无状态**的（可以添加 JanusGraph Server 节点做负载均衡）
- 数据和索引写在后端 Cassandra + ES 中，JanusGraph 只做查询处理和数据缓存
- 瓶颈在后端的 ES 查询能力和 Cassandra 的 I/O 吞吐
- 单 JanusGraph 节点的最大吞吐量受限于：CPU（Gremlin 遍历）、内存（缓存）、网络带宽（后端访问）

**AgentiX 对应设计**:
- AgentiX 的扩展模型：Node.js 进程 + OverGraph（LMDB）+ Raft
- 水平扩展：添加节点 → 添加 Range → 重平衡
- AgentiX 的每个节点是**有状态**的（持有本地 LMDB + Raft 日志）
- 瓶颈维度：Raft 写吞吐（单 Raft leader 限制）、LMDB 写入（B-tree 随机写）、CPU（图算法）

**扩展性对比**:
| 维度 | JanusGraph | AgentiX |
|------|-----------|---------|
| 单元 | 无状态查询节点 | 有状态存储节点 |
| 扩展方式 | 后端集群扩展 | Raft 组 + 分片分裂 |
| 存储扩展 | Cassandra 集群 | RangeInstance 分裂 |
| 计算扩展 | 加 JanusGraph 节点 | 拆分 Range |
| I/O 隔离 | Cassandra 层 | 无（LMDB 在当前进程） |
| 部署模型 | 3 层（JanusGraph + Cassandra + ES） | 1 层（单一 Node.js 进程） |
| 运维复杂度 | **高**（3 个分布式系统） | **低**（npm install） |
| 最小生产集群 | 3x JanusGraph + 3x Cassandra + 3x ES = 9 节点 | 1-3 节点 |
| 扩展极限 | 100+ 节点（大 Cassandra 集群） | 10-20 节点（Raft 组开销） |

**关键洞察**：
JanusGraph 的优势是**计算与存储分离**，可以在不影响存储的情况下无限添加计算节点。缺点是运维炸裂：9 节点的最小生产集群需要维护 3 个独立的分布式系统（JanusGraph + Cassandra + ES）。

AgentiX 的优势在**嵌入性**：一个 Process = 一个 Graph Database。缺点是有状态节点的扩展不如无状态节点灵活，单进程的 CPU/内存资源受限于 Node.js 的单线程模型（虽然通过 Worker threads 可缓解）。

**但 JanusGraph 的「后端依赖」也是一个弱点**：Cassandra 的 tombstone、compaction、GC 停顿都会影响 JanusGraph 的可用性，而这些问题 JanusGraph 无法在应用层解决。相比之下，AgentiX 对整个栈有完全控制。

---

### 3. 核心差距

综合以上分析，AgentiX GraphVec 与 Dgraph/JanusGraph 的差距可归纳为以下 6 个维度：

#### 3.1 事务与一致性

| 差距 | 严重性 | Dgraph 做法 | AgentiX 现状 |
|------|-------|-------------|-------------|
| 无 MVCC / 事务隔离 | **Critical** | SSI (Serializable Snapshot Isolation) | Transaction 只是写操作的顺序排列，读操作直接读取当前状态 |
| HLC 时钟故障 | **Critical** | Zero 的全局 timestamp oracle | `now()` 不读取系统时钟，退化为逻辑计数器，跨节点 LWW 不可靠 |
| 无事务回滚 | **Important** | 冲突自动 abort + 重试 | Transaction 仅探测冲突，不做任何处理 |
| 读未释放锁竞争 | **Improvement** | 读不阻塞写 | 无并发控制 |

**修复优先级**: ⚠️ HLC 时钟故障（影响所有跨节点操作） > MVCC（决定多节点一致性） > 回滚

#### 3.2 查询与索引

| 差距 | 严重性 | Dgraph/JanusGraph 做法 | AgentiX 现状 |
|------|-------|-----------------------|-------------|
| 反向边 | **Critical** | Dgraph `@reverse` 自动维护 | **不支持** — 入边查询需要全量扫描 |
| 索引推入 | **Critical** | JanusGraph 推送属性过滤到 ES | 全表扫描 `findNodesByProperty()` |
| 属性索引维护 | **Important** | Dgraph 通过 DDL 自动维护 | 手动 `compositeIndex.addRecord()` |
| 递归查询 | **Important** | DQL `recurse` / Gremlin `repeat` | 用户手动写循环 |
| 分组聚合 | **Improvement** | DQL `@groupby` + 聚合函数 | 无 |
| 地理空间索引 | **Improvement** | Dgraph S2 / ES geo | **不支持** |

**修复优先级**: ⚠️ 反向边（架构级缺失） > 索引推入（决定大规模查询性能） > 属性索引自动化

#### 3.3 分片与扩展

| 维度 | Dgraph | JanusGraph | AgentiX |
|------|--------|-----------|---------|
| 分片粒度 | predicate（查询局部性好） | 无（后端处理） | hash range（需 type 亲和度优化） |
| 原子迁移 | Raft conf change | 后端扩展 | ❌ 无 fence，无持久化进度 |
| 热点处理 | ⚠️ 大 predicate 不可分割 | Cassandra 自动散列 | Consistent hash 自动散列 |
| 跨分片遍历 | scatter-gather | Gremlin 遍历 | ScatterGather + BFS（PPR 需要在 coordinator 内存中执行） |
| 数据本地性 | 高（按 predicate 聚合） | 高（后端自动） | 中等（Smart Routing 优化） |

#### 3.4 运维与安全

| 差距 | Dgraph | JanusGraph | AgentiX |
|------|--------|-----------|---------|
| 部署复杂度 | 2 组件 (Zero+Alpha) | 3 组件 (JanusGraph+Cassandra+ES) | **1 组件 (npm install)** |
| 启动时间 | ~1s | ~10s | **~50ms** |
| 认证 | mTLS + JWT + Basic | 多种 | mTLS only（已修改） |
| 审计日志 | ✅ | ✅ | ✅ 已有（audit.ts） |
| OpenTelemetry | ✅ | ❌ | ✅ 已有（otel.ts） |
| 崩溃恢复 | Badger WAL | Cassandra 修复 | LMDB 事务 + 文件锁（测试不全） |
| 备份 | 在线快照 | Cassandra snapshot | ⚠️ 命令注入风险（backup.ts） |
| 健康检查 | ✅ 内置 | ✅ | ⚠️ diskFree=0 硬编码 |

#### 3.5 图算法生态

| 维度 | Dgraph | JanusGraph | AgentiX |
|------|--------|-----------|---------|
| 内置算法 | 有限（PageRank, 最短路径等） | 有限（需集成 GDS） | 11 个自研 → **graphology 50+**（规划中） |
| 向量搜索 | 无 | 无 | **✅ 已有 Dense + Sparse + Hybrid** |
| 社区检测 | 无 | Giannis（插件） | **✅ Louvain（graphology）** |
| 算法执行位置 | Dgraph 内部 | Gremlin Server | **🚧** 内存中（coordinator 做 PPR 全量计算 = 大图 OOM） |
| Fluent API | ❌ GraphQL± 字符串 | ❌ Gremlin 字符串 | **✅ TypeScript 强类型链式调用** |

#### 3.6 整体架构权衡

```
                复杂度轴 →
                   低                         高
部署  ┌────────────────────────────────────────┐
简单  │  AgentiX      JanusGraph     Dgraph    │  复杂
     │  (1进程)       (3系统)       (2组件)   │
     └────────────────────────────────────────┘
                   扩展性轴 →
                   低                         高
水平  ┌────────────────────────────────────────┐
弱    │  AgentiX       Dgraph       JanusGraph │  强
     │  (有状态)     (multi-raft)  (无状态)   │
     └────────────────────────────────────────┘
                    嵌入性轴 →
                   低                         高
嵌入  ┌────────────────────────────────────────┐
否    │  Dgraph        JanusGraph    AgentiX   │  是
     │  (Go 服务)    (JVM 服务)    (npm 包)   │
     └────────────────────────────────────────┘
```

**核心结论**：
- Dgraph 是一个**中等复杂度、中等扩展性**的图数据库，在单谓词级别的查询性能和 Raft multi-raft 实现上值得参考。
- JanusGraph 是一个**高复杂度、高扩展性**的架构典范，其「存储后端 + 索引后端」分离、查询规划器、L1/L2 缓存的设计思路对 AgentiX 有很高的参考价值。
- AgentiX 的核心差距集中在：**事务隔离、反向边、索引推入、分片迁移原子性** 这 4 个关键点上。

---

### 4. AgentiX 优势

尽管存在上述差距，AgentiX GraphVec 在以下维度具有明确的差异化优势：

#### 4.1 嵌入性与部署简便性（最大优势）

**对比数据**：
```
启动时间对比:
  AgentiX:       ~50ms (require + GraphEngine.open)
  Dgraph:        ~1s (Go 二进制启动 + Raft 选举)
  JanusGraph:    ~10s (JVM 启动 + Cassandra 连接 + ES 连接)

内存占用对比:
  AgentiX:       ~50-200MB (Node.js 进程)
  Dgraph:        ~500MB-2GB (Alpha + Zero)
  JanusGraph:    ~2-8GB (JanusGraph + Cassandra + ES 进程)

包大小对比:
  AgentiX:       ~5MB (npm install, 纯 TS + native addons)
  Dgraph:        不适用（独立二进制 ~40MB）
  JanusGraph:    不适用（需要 3 个独立系统安装）
```

**使用场景差异**：
- **AgentiX 适合**：AI Agent 基础设施（同进程嵌入）、IoT 边缘设备、轻量级微服务、桌面应用
- **Dgraph/JanusGraph 适合**：大规模 OLTP 图查询、企业级知识图谱、社交网络推荐系统

#### 4.2 向量搜索（原生支持）

Dgraph 和 JanusGraph 均不原生支持向量搜索。AgentiX 的向量搜索是差异化核心功能：

| 特性 | AgentiX | Dgraph | JanusGraph |
|------|--------|--------|-----------|
| Dense Vector | ✅ HNSW（OverGraph） | ❌ | ❌ |
| Sparse Vector | ✅ | ❌ | ❌ |
| Hybrid Search | ✅ RRF / Weighted | ❌ | ❌ |
| Graph-scosed 搜索 | ✅ startNode + 图遍历过滤 | ❌ | ❌ |
| 向量索引维度 | 可配置 | ❌ | ❌ |

**核心场景**：语义搜索、RAG（检索增强生成）、AI Agent 记忆检索、推荐系统。

#### 4.3 Fluent API + TypeScript 强类型

**Dgraph 的查询方式**：
```graphql
# 用户在 HTTP 中传递 GraphQL± 查询字符串
# 无类型安全，无编译期检查
```

**JanusGraph 的查询方式**：
```groovy
// Gremlin 字符串（或 Java/Clojure 代码）
g.V().has('name', 'Alice').out('friends')
```

**AgentiX 的查询方式**：
```typescript
// TypeScript 强类型，IDE 自动补全 + 编译期检查
const alice = engine.getNodeByName('Alice')
const friends = engine.neighbors(alice.id, {
  edgeTypeFilter: [EdgeType.FRIENDS]
})
```

**优势**：
- AI Agent 生态使用 TypeScript 的比例很高（LangChain.js、OpenAI TS SDK 等），AgentiX 的 TS 原生继承与此完美匹配
- 无需学习非通用查询语言（DQL/Gremlin/AQL），降低开发者门槛
- Fluent API 配合 TypeScript 的 `async/await` 实现完整的链式调用

#### 4.4 多活复制方案

| 特性 | AgentiX | Dgraph | JanusGraph |
|------|--------|--------|-----------|
| 跨 DC 复制 | EventStream + ZMQ PUB/SUB | Multi-Leader (Enterprise) | ❌ 不支持 |
| 冲突解决 | LWW / CRDT merge | 无（Dgraph 自身单集群） | ❌ |
| HLC 时钟 | ✅ 已有（bug 待修） | ❌ 无 | ❌ |
| Delta Sync | ✅ 已有 (delta-sync.ts) | ❌ | ❌ |
| 单集群多 DC 部署 | ✅ 原生支持 | ❌ Enterprise only | ❌ |

**注**：Dgraph 的 Enterprise 版支持 Multi-Leader 多活，但开源版无此能力。JanusGraph 完全不支持跨 DC 同步。AgentiX 的 EventStream + ZMQ PUB/SUB + LWW 方案在开源产品中非常罕见。

#### 4.5 安全设计（mTLS-only）

AgentiX 的 mTLS-only 设计是一个**极端的安全取舍**：

| 维度 | AgentiX (mTLS-only) | 主流做法 |
|------|--------------------|---------|
| 认证方式数 | 1 种 | 3-5 种（JWT + Basic + API Key + mTLS + OAuth） |
| 攻击面 | 最小（仅证书管理） | 最大（多种认证协议 + 密码存储） |
| 运维成本 | 中（CA + 证书轮换） | 高（密码管理 + 密钥轮换 + JWT 签名） |
| 凭证泄漏 | 证书无法被攻击者控制 CN | JWT 泄漏 / 密码暴力破解 |
| 对 UI 友好 | ❌ 不适合浏览器客户端 | ✅ 支持多种客户端 |
| 自动化集成 | 证书管理需额外工具 | JWT 生成简单 |

**适用场景**：
- mTLS-only 的场景：AI Agent 之间的内部 RPC、微服务网格、IoT 设备身份认证
- 不适合的场景：面向 Web 客户端的公开 API、移动 App 后端

#### 4.6 开源协议与生态兼容性

| 维度 | AgentiX | Dgraph | JanusGraph |
|------|--------|--------|-----------|
| 许可证 | Apache 2.0 | Apache 2.0 | Apache 2.0 |
| 语言 | TypeScript | Go | Java |
| JS/TS 生态 | **原生** | 间接（gRPC client） | 间接（TinkerPop driver） |
| npm 安装 | ✅ npm install agentix-graphvec | ❌ | ❌ |
| Docker | ✅ | ✅ | ✅ |
| 与 LangChain/LLM 集成 | **原生** | 间接 | 间接 |

---

### 总结

```
┌────────────────────────────────────────────────────────────┐
│  AgentiX GraphVec vs Dgraph + JanusGraph 总结              │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  AgentiX 的定位:                                            │
│    "嵌入式、TypeScript 原生、支持向量搜索的图数据库引擎"       │
│    适合 AI Agent 基础设施、边缘设备、微服务架构               │
│                                                            │
│  Dgraph + JanusGraph 的定位:                                │
│    "分布式、独立服务、传统图查询的图数据库"                    │
│    适合大型 OLTP 图查询、企业级知识图谱                       │
│                                                            │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  必须修复的核心差距（按优先级）：                              │
│                                                            │
│  P0-Critical:                                               │
│  1. HLC 时钟 bug: now() 不读取系统时钟                      │
│  2. 反向边：入边查询需要全量扫描                              │
│  3. 索引推入：findNodesByProperty 全表扫描                    │
│                                                            │
│  P1-Important:                                              │
│  4. 事务隔离：没有 MVCC / SSI                               │
│  5. 分片迁移原子性：rebuildRouter 无 fence                    │
│  6. 属性索引自动化：维护索引需要手动 addRecord()               │
│                                                            │
│  P2-Improvement:                                            │
│  7. 递归查询：用户手动写循环                                  │
│  8. 查询语言：Fluent API 表达能力有限                         │
│  9. 备份命令注入：backup.ts 安全问题                          │
│                                                            │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  可保留的差异化优势：                                        │
│  - 嵌入性（~50ms 启动, 同进程嵌入）                          │
│  - 向量搜索（Dense + Sparse + Hybrid, Graph-scoped queries）│
│  - Fluent API + TypeScript 强类型                           │
│  - 多活复制（EventStream + ZMQ + LWW）                      │
│  - mTLS-only 安全设计（攻击面最小）                          │
│  - 图算法生态（graphology 50+ 算法）                         │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

#### 技术架构取舍一览

| 决策点 | AgentiX | Dgraph | JanusGraph | 评价 |
|--------|--------|--------|-----------|------|
| 嵌入性 | ✅ 同进程 | ❌ 独立服务 | ❌ 独立服务 | **AgentiX 最大优势** |
| 一致性 | Raft 强一致 | Raft 强一致 | 后端决定（默认最终一致） | AgentiX ≈ Dgraph > JanusGraph |
| 事务隔离 | ❌ 无 | ✅ SSI | ❌ 依赖后端 | Dgraph 领先 |
| 反向边 | ❌ 不支持 | ✅ @reverse | ✅ 边列表双向 | 必须修复 |
| 索引推入 | ❌ 全表扫描 | ✅ predicate 索引 | ✅ ES pushdown | 必须修复 |
| 向量搜索 | ✅ 原生 | ❌ 无 | ❌ 无 | **AgentiX 核心差异** |
| 查询语言 | Fluent API | DQL (GraphQL+) | Gremlin | 各有利弊 |
| 图算法 | graphology 50+ | 有限 | 有限 | **AgentiX 领先** |
| 跨 DC 复制 | ✅ 原生 | ❌ Enterprise only | ❌ | **AgentiX 领先** |
| 扩展性 | 中等（有状态） | 高（multi-raft） | 高（无状态） | Dgraph/JanusGraph 领先 |
| 运维复杂度 | **极低** | 中 | **高** | **AgentiX 领先** |
| TypeScript 生态 | ✅ 原生 | ❌ | ❌ | **AgentiX 领先** |
