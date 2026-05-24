# 深度审查 A：存储+索引层

> 审查日期：2026-05-23
> 审查范围：`src/core/`、`src/index/`、`src/search/`
> 对标系统：Neo4j / Dgraph / ArangoDB / JanusGraph

---

## 一、存储模型问题

### [S01] 缺少原生图存储（免索引邻接）
- **模块**: `src/core/graph-engine.ts`（基于 OverGraph DB）
- **严重度**: 🔴
- **对比**: Neo4j ✅原生图存储 / Dgraph ✅三元组谓词索引 / ArangoDB ⚠️文档引用边 / JanusGraph ✅BigTable邻接表
- **描述**: AgentiX 通过 OverGraph（Rust napi-rs 绑定）存储图数据。OverGraph 是一个嵌入式的 LSM-Tree 存储引擎，而非原生图存储。这意味着：
  1. 邻居查询需要通过 OverGraph 的 `neighbors()` API 读取，不是链表式磁盘布局（Neo4j 的免索引邻接）
  2. OverGraph 底层基于 LSM-Tree（LevelDB/RocksDB 类似的顺序写入 + compaction），对于图遍历这种随机读密集场景，存在写放大和读放大问题
  3. 与 Neo4j 的免索引邻接相比，大图的 2+ 层 BFS 遍历磁盘访问量会显著增加
  4. 存储统计信息（`graph-engine.ts:434-439`）只暴露了 WAL 和 memtable 字节数，缺少实际的 SSTable 命中率、缓存命中率等关键指标
- **方案**: 
  1. 短期：在 OverGraph 上层添加邻接缓存层（如 LRU 缓存的 CSRIterator），为热点子图提供加速
  2. 中期：在 OverGraph 中实现 CSR 列族（Column Family），将邻接表以列族形式连续存储，而非分散在 LSM-Tree 中
  3. 长期：考虑为高频遍历的子图构建"物化邻接表"存储，每 100 个节点一组持久化到单独的文件
- **工作量**: 大

### [S02] 缺乏图分区/分片的数据本地性保证
- **模块**: `src/core/graph-engine.ts` + `src/types.ts`（ShardMap / RangeConfig）
- **严重度**: 🟡
- **对比**: Neo4j ⚠️fabric分库 / Dgraph ❌无原生分区 / ArangoDB ✅SmartGraph智能分片 / JanusGraph ✅基于Vertex ID的哈希分区
- **描述**: 系统通过 `ShardMap` 和 `RangeConfig`（`types.ts:178-195`）实现了分片支持，并提供了分片间 fan-out 模式（`graph-algorithms.ts' crossRangeMode`）。但存在以下缺陷：
  1. 分片策略是**哈希环**（`hashRing`）而非基于图拓扑的分区——同一个社区的节点可能分布在不同的 Range，导致跨 Range 查询频繁
  2. 当前 fan-out 模式只进行"尽力而为"的跨 Range 邻居收集（`graph-algorithms.ts:265-306`），没有保证最终一致性
  3. 跨 Range BFS（`graph-algorithms.ts:363-393`）遇到远程节点时只是 fan-out 一次，未做递归遍历，复杂路径容易遗漏
  4. ArangoDB 的 SmartGraph 基于 `_to` 的 `smartAttribute` 做本地分区保证，JanusGraph 基于 Vertex ID 前缀做分区：而 AgentiX 当前的分区策略缺乏拓扑感知
- **方案**: 
  1. 实现拓扑感知分区：在创建分片时，识别图的连通分量，尽量将同一分量的节点分配到同一 Range
  2. 为跨 Range 边建立双向"桥梁"索引，让 Range 知道哪些邻居在哪些远程 Range
  3. 改进跨 Range 递归遍历：fan-out 结果应该触发对新增远程节点的本地递归 BFS（目前最多 2 层深度不足）
- **工作量**: 大

### [S03] CSR 格式与大图内存压力
- **模块**: `src/core/graph-algorithms.ts`（`toCSR()` 方法, 行 980-1005）
- **严重度**: 🟡
- **对比**: Neo4j ✅CSR 格式用于 GDS 并行算法 / Dgraph ❌无 / ArangoDB ❌无 / JanusGraph ❌无
- **描述**: `toCSR()` 方法将选定的节点集合压缩为 CSR 格式传递给 Worker 线程，这是正确的设计选择。但存在以下问题：
  1. CSR 构建在 `graph-algorithms.ts:1003` 处复制了整个邻接表，当节点集达到百万级时，内存占用会超过数 GB
  2. 没有 CSR 的增量构建或复用（每次调用 `runParallel` 都重建），同一子图的多次算法调用会重复构建
  3. CSR 仅用于 Worker 线程传递，未作为持久化缓存供热路径算法复用
- **方案**: 
  1. 增加 CSR 缓存池：对频繁查询的节点集合，缓存其 CSR 表示并标记过期时间
  2. 实现 CSR 的分块构建：将百万级节点拆分为 64KB/块的分片 CSR，只在需要时合并
  3. 对 OverGraph 中高频访问的邻接表，考虑直接在 Rust 层构建 CSR 列族
- **工作量**: 中

---

## 二、索引策略问题

### [I01] 缺少 Schema 索引（标签-属性组合约束）
- **模块**: `src/core/label-index.ts`
- **严重度**: 🟡
- **对比**: Neo4j ✅Schema索引 + 唯一约束 / Dgraph ✅反向边索引 / ArangoDB ✅持久化索引 / JanusGraph ✅复合索引
- **描述**: 当前 `LabelIndex`（`label-index.ts`）实现了基础的 `typeId → propKey → propValue` 三级索引，但缺少以下关键能力：
  1. **唯一约束**：`graph-engine.ts:66` 通过 `getNodeByKey(typeId, name)` 检查节点是否存在，但这不是 schema 级别约束，无法保证并发场景下的原子唯一性
  2. **复合索引组合查询**：`LabelIndex.findNodesByProperty()` 只支持单属性查找，而 `CompositeIndex`（`composite-index.ts`）虽然支持多条件 AND/OR 查询，但两者是独立的索引系统，没有统一的查询计划
  3. **索引类型选择**：当前索引只有精确匹配（Map），没有范围查询、部分匹配或前缀匹配能力
  4. 与 Neo4j 的 schema index 相比，缺少 "CREATE INDEX ON :Label(prop1, prop2)" 这类 schema 级别的索引声明
- **方案**: 
  1. 在 `LabelIndex` 中增加唯一约束检查，利用 OverGraph 的底层事务保证原子性
  2. 合并 `LabelIndex` 和 `CompositeIndex` 到同一个索引管理器，允许 `CompositeQuery` 利用 `LabelIndex` 的 type 级预筛选
  3. 增加范围索引（B-tree 风格的红黑树或跳表）支持数值属性的大于/小于/区间查询
- **工作量**: 中

### [I02] 全文索引纯 JS 实现性能瓶颈
- **模块**: `src/search/fulltext.ts`
- **严重度**: 🔴
- **对比**: Neo4j ✅Apache Lucene（全文索引） / Dgraph ⚠️外部搜索引擎 / ArangoDB ✅内置全文索引 / JanusGraph ⚠️依赖 Elasticsearch 外部索引后端
- **描述**: `FullTextIndex`（896 行）是纯 JavaScript 实现的内置全文搜索引擎，包含 TF-IDF 评分、中文分词（bigram/trigram）、模糊搜索（Levenshtein 编辑距离）。存在以下性能问题：
  1. **内存索引**：全文索引完全驻留在 JS 堆内存中（`invertedIndex` Map），大文档集（>10万文档）会占用数百 MB ~ 数 GB 堆内存，触发 GC 停顿
  2. **无持久化增量**：`saveToFile()`（`fulltext.ts:790-793`）使用 `JSON.stringify` 全量序列化，完全在内存中完成。对大数据集序列化和反序列化都会 OOM
  3. **搜索性能**：Levenshtein 模糊搜索（`fulltext.ts:587-609`）在每次搜索时都遍历所有倒排项计算编辑距离，复杂度 O(t * n_terms)，大索引下搜索响应差
  4. **中文分词语义缺失**：bigram 分词存在大量非语义片段（如"苹果手机"分成"苹果""果手""手机"），未使用字典分词导致召回率低和噪声大
  5. **持续增量索引**：每次 `upsertNode`（`graph-engine.ts:96`）都会调用 `indexNodeForSearch`，但 `FullTextIndex` 的 `addDocument` 先删除再重建（`fulltext.ts:124-126`），没有真正增量更新逻辑
- **方案**: 
  1. 短期：将全文索引的可持久化层改为 SQLite FTS5 或 RocksDB 后端，避免全量 JSON 序列化
  2. 中期：引入 jieba 或其他基于字典的中文分词器替代 bigram；模糊搜索改为 BK-tree 或 SymSpell 替代全表遍历
  3. 长期：评估集成 Meilisearch 或 Tantivy（Rust 实现）作为全文搜索后端替代
- **工作量**: 大

### [I03] 复合索引的内存消耗与一致性风险
- **模块**: `src/index/composite-index.ts`
- **严重度**: 🟡
- **对比**: Neo4j ✅原生存储级别索引 / Dgraph ✅谓词索引 / ArangoDB ✅持久化索引 / JanusGraph ✅外部存储索引
- **描述**: `CompositeIndex` 使用内存 Map 结构存储倒排索引，存在以下问题：
  1. **内存持久化**：索引仅存储在内存中（`composite-index.ts:35`），数据库重启索引就丢失，需要重新遍历所有节点来重建（当前没有重建逻辑）
  2. **查询无优化**：AND 查询（`composite-index.ts:104-112`）直接对所有结果集取交集，未按基数对条件排序（应先取最严格的条件），可能导致产生巨大的中间结果集
  3. **并发不安全**：`composite-index.ts` 未使用任何锁机制或并发控制，多线程并发 upsert 时索引可能脏读
  4. **删除引用不一致**：`graph-engine.ts:87` 中 `deleteNode` 调用 `compositeIndex.removeNode()` 但传入的 `oldProps` 来自 `getNode` 返回的节点属性，若该节点已被其他并发写入更新，则删除的索引条目与最新数据不一致
- **方案**: 
  1. 添加复合索引的重建入口，初始化时从 OverGraph 扫描所有节点重建索引
  2. 优化 AND 查询：按条件基数对条件排序，优先取匹配节点最少的条件
  3. 使用 `ReadWriteLock` 或 `Mutex` 保护索引的并发写入
  4. 在 OverGraph 层启用节点版本号，仅当版本匹配时才进行索引更新
- **工作量**: 中

### [I04] 缺少范围索引与排序索引
- **模块**: `src/index/composite-index.ts` + `src/core/label-index.ts`
- **严重度**: 🔵
- **对比**: Neo4j ✅B+树索引（范围查询/排序） / Dgraph ✅谓词范围索引 / ArangoDB ✅跳表索引（persistent indexes支持范围） / JanusGraph ✅Mixed Index（支持范围）
- **描述**: 当前索引系统仅支持精确匹配（Map-based exact match），不支持：
  1. **数值范围查询**：如 `age > 30`、`price BETWEEN 100 AND 200`
  2. **排序输出**：如 `ORDER BY score DESC`
  3. **前缀匹配**：如 `name STARTS WITH 'A'`
  所有范围查询都要回退到遍历图引擎的 getNode，在大图上效率极低
- **方案**: 引入一个基于有序树（如 B-tree 或 SortedMap）的范围索引，支持数值/字符串属性的区间查询和排序。可以只在 OverGraph 层提供，利用 Rust 原生的 B-tree 实现
- **工作量**: 中

---

## 三、图算法精度与广度问题

### [A01] PPR 精度在跨 Range 场景下降
- **模块**: `src/core/graph-algorithms.ts`（`ppr()` 方法）
- **严重度**: 🟡
- **对比**: Neo4j GDS ✅精确PPR（GDS内置） / Dgraph ❌无 / ArangoDB ✅Pregel PageRank / JanusGraph ❌无
- **描述**: `ppr()`（`graph-algorithms.ts:78-145`）在跨 Range 模式下的实现存在精度损失：
  1. 跨 Range 节点收集（`_collectReachableCrossRange`）只进行一次 fan-out 并递归最多 2 层，可能遗漏更深层的远程节点
  2. PPR 幂迭代要求在**所有可达节点**间同步分数，但跨 Range 时无法同步多 Range 间的 rank 向量。即使每轮都 fan-out 各自的 rank，通信也需要 O(N * R) 复杂度（N 为节点数，R 为 Range 数）
  3. 代码文档（`graph-algorithms.ts:71-72`）明确标注"跨 Range 的 PPR 分数是近似值"，但没有给出近似程度（误差界）
- **方案**: 
  1. 为跨 Range PPR 实现 "push-based" 变体：每个 Range 独立计算本地 PPR，然后将端节点的残差推送到远程 Range，再递归计算
  2. 当图规模可控时（如 <10万节点），在单一 Range 上运行精确 PPR 并缓存结果
  3. 文档中明确标注跨 Range PPR 的误差范围，提供 `PPRStats.confidenceInterval` 输出
- **工作量**: 大

### [A02] 缺少大量关键图算法
- **模块**: `src/core/graph-algorithms.ts`
- **严重度**: 🔴
- **对比**: Neo4j GDS ✅55+算法 / Dgraph ❌无（gRPC外部调用） / ArangoDB ✅6+（Pregel框架） / JanusGraph ❌无（Gremlin叠加）
- **描述**: 当前算法实现对比 Neo4j GDS 55+ 算法，缺失的**关键**算法如下：

| 类别 | 缺失算法 | 必要程度 | 描述 |
|------|---------|---------|------|
| **中心性** | Eigenvector Centrality | 🔴 | 比 PageRank 更适合有向图权威度评估 |
| **中心性** | Harmonic Centrality | 🟡 | 处理非连通图的接近中心性变体 |
| **社区** | SCC (Strongly Connected Components) | 🔴 | 有向图中强连通分量检测 |
| **社区** | K-Core / K-Truss | 🟡 | 稠密子图发现 |
| **路径** | A* Search | 🔴 | 带启发式的最短路径，远快于 Dijkstra+BFS |
| **路径** | Yen's K-Shortest Paths | 🔴 | 前 K 条最短路径（当前只有全部最短路径） |
| **路径** | Maximum Flow (Edmonds-Karp / Dinic) | 🟡 | 网络流分析 |
| **相似性** | Cosine Similarity | 🟡 | 向量相似性（虽由向量搜索覆盖，但图上节点间需要） |
| **相似性** | SimRank | 🟡 | 基于图拓扑的结构相似性 |
| **节点嵌入** | Node2Vec-like random walk | 🔴 | 图拓扑→向量的嵌入学习（与向量引擎配合） |
| **节点嵌入** | GraphSAGE aggregation | 🟡 | 归纳式节点嵌入（新节点无需重新训练） |
| **链接预测** | Resource Allocation Index | 🟡 | 比 AA/CommonNeighbors 更精准的链路预测 |
| **聚类** | HITS | 🟡 | 权威度+枢纽度双指标（BFS/DFS场景常用） |
| **聚类** | Spectral Clustering | 🟡 | 基于 Laplacian 矩阵的聚类，适用于已知社区数场景 |

- **方案**: 按优先级分批实现。第一期（高优先级，工作量小到中）：Eigenvector Centrality、SCC、A* Search、Yen's K-Shortest Paths、HITS。第二期（中优先级，工作量中）：K-Core、Node2Vec、SimRank、Maximum Flow。第三期（扩展优先级，工作量大）：Node embeddings、Spectral Clustering
- **工作量**: 大（一期约 400 行/算法，二期约 200-800 行/算法）

### [A03] Dijkstra 缺少 A* 启发式加速和瓶颈路径
- **模块**: `src/core/graph-algorithms.ts`（`dijkstra()` 方法）
- **严重度**: 🟡
- **对比**: Neo4j GDS ✅A* + Dijkstra / Dgraph ❌无 / ArangoDB ✅Pregel SSSP / JanusGraph ❌无
- **描述**: 当前 `dijkstra()`（`graph-algorithms.ts:190-282`）在跨 Range 模式下的终止条件和路径重建存在问题：
  1. 当 `unvisited` 为空时终止（行 212），但如果跨 Range 节点在后续 fan-out 中才被发现，循环已结束，这些节点会被遗漏
  2. 跨 Range 扩展（行 256-274）的算法逻辑是：遍历已发现距离的节点并尝试获取新邻居。但这会导致 `unvisited` 可能包含已被松弛但距离为 Infinity 的远程节点，造成死循环
  3. 缺少 A* 启发式，即使提供了目标节点 ID，Dijkstra 仍会展开所有可达节点
- **方案**: 
  1. 增加 A* 搜索实现，针对已知 `targetId` 的场景提供加速
  2. 改进跨 Range Dijkstra 的终止条件：使用两阶段策略，先完成本地 Dijkstra，再触发跨 Range fan-out + 重新松弛
  3. 增加目标导向的终止检查
- **工作量**: 中

### [A04] Louvain 的分辨率参数和并行化
- **模块**: `src/core/graph-algorithms.ts`（`louvain()` 方法）
- **严重度**: 🔵
- **对比**: Neo4j GDS ✅Louvain + Leiden / ArangoDB ✅Pregel Louvain / Dgraph ❌无 / JanusGraph ❌无
- **描述**: 当前 `louvain()`（`graph-algorithms.ts:455-518`）虽然支持 gamma 参数，但缺少：
  1. **Leiden 算法**：Louvain 的一个已知问题是可能产生断开的社区。Leiden 算法增加了 Refinement 阶段来修复此问题。对于大多数使用场景，Leiden 应该是默认选择
  2. **多级凝聚**：Neo4j GDS 的 Louvain 支持将第一阶段结果作为新的图进行多级凝聚（递归 Louvain），以发现更深层的社区结构
  3. **并行化**：当前 Louvain 完全串行（节点间依赖是必然的），但如果用 `runParallel + CSR`，可以获得显著的加速
- **方案**: 
  1. 实现 Leiden 算法替代/补充 Louvain（增加 Refinement 阶段，约 150 行）
  2. 使用 `runParallel` + CSR 将 Louvain 第一阶段迁移到 Worker 线程执行，利用多核加速
  3. 增加多级凝聚的可选递归模式
- **工作量**: 中

---

## 四、总结

| 严重度 | 数量 | 问题列表 |
|--------|------|---------|
| 🔴 严重 | 4 | S01 缺少原生图存储、I02 全文索引性能、A02 缺少关键算法、I01 缺少Schema索引 |
| 🟡 中等 | 6 | S02 分片无拓扑感知、S03 CSR内存压力、I03 复合索引一致性、A01 跨Range PPR精度、A03 Dijkstra缺少A*、I04 缺少范围索引 |
| 🔵 轻微 | 1 | A04 Louvain无Leiden |
| **合计** | **11** | |

### 优先级建议

**P0（立即修复）**：S01（图存储缺陷）+ I02（全文索引性能）+ A02（关键算法缺失）
→ 这三项直接影响图数据库产品的核心竞争力和可用性

**P1（下一迭代）**：S02（拓扑感知分片）+ I01（Schema索引）+ I03（复合索引一致性）+ A01（跨Range PPR）

**P2（持续改进）**：S03（CSR优化）+ I04（范围索引）+ A03（A*加速）+ A04（Leiden+并行化）
