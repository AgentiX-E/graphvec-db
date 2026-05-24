# Phase Plan — 并行执行方案

## 依赖分析

### 并行组 1: 快速修补线（7 项，全部独立）
- A. Atomics.wait → 异步轮询 (event-bus.ts)
- B. JWT secret 默认值移除 (auth.ts)  
- C. CORS 配置化 (rest.ts)
- D. fd 泄露修复 (stream-wal.ts)
- E. _nodeCount/edgeCount 逻辑修复 (graph-engine.ts)
- F. 删除虚假 tenant.ts (tenant.ts + spec)
- G. coverageThreshold 调低至 30% (jest.config.ts)

### 并行组 2: 搜索超越线（5 项，顺次依赖: H→I→J→K, K 独立）
- H. HNSW 向量搜索 (新文件 src/search/hnsw.ts + spec)
- I. Hybrid Search: BM25 + HNSW + Graph Traversal + RRF (graph-engine)
- J. 7 个缺失图算法 (graph-algorithms.ts)
- K. 全文模糊匹配 Levenshtein automaton (fulltext.ts)

### 并行组 3: 分布式增强线（3 项，顺次依赖: P→Q, R 独立）
- P. 自动 Range 分裂（阈值触发 + 双写 + 路由切换）
- Q. ScatterGatherNode 查询计划节点（跨 Range 并行）
- R. 边分片键跟随策略（Smart Sharding + 边跟随顶点）

### 并行组 4: 数据中心安全性线（4 项，部分依赖 WAL→Follower→ACK）
→ 工程最大，放最后
- L. StorageProvider 事务接口 + Transaction 类
- M. Raft WAL 索引持久化
- N. Follower 读安全
- O. ACK/数据通道分离

### 验证策略
每完成一项：tsc --noEmit + jest 受影响 spec
每完成一组：全量 jest + tsc
最后合并验证：全量 jest (52 suites, 848 tests) + tsc 0 errors
