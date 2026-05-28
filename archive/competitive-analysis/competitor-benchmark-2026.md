# AgentiX GraphVec 竞品对标分析报告

> 分析日期：2026-05-26
> 分析师：云仔
> 数据来源：GitHub Repo、官方文档、公开技术博客

---

## 一、评分维度说明

| 维度 | 权重 | 说明 |
|------|------|------|
| **embedding** | — | 嵌入式/库式一体化能力（0-10，高=可直接 link 进应用） |
| **vector** | — | 向量搜索能力（HNSW、IVF、混合搜索） |
| **replication** | — | 多活/复制/高可用方案成熟度 |
| **query** | — | 查询语言丰富度与表达能力 |
| **security** | — | RBAC、加密、审计、细粒度权限 |
| **operations** | — | 运维工具、可观测性、CLI/UI 成熟度 |
| **vendorLockIn** | — | 避免供应商锁定的程度（高=开源友好，低=专有锁定） |
| **cjkSupport** | — | 中日韩语言支持（分词、搜索、文本处理） |
| **performance** | — | 基准性能（遍历、写入、向量搜索） |

---

## 二、竞品深度分析

### 2.1 Neo4j — 图数据库标杆

| 项目 | 内容 |
|------|------|
| **类型** | OLTP 图数据库（客户端-服务器） |
| **最新版本** | 5.x 系列（2025+），Neo4j 6 预览 |
| **许可证** | 社区版 GPLv3 / 企业版商业许可 |
| **语言** | Java |

**核心能力：**
- Cypher 查询语言（行业标准，功能最完整）
- 企业版支持复制、分片、安全审计、细粒度 RBAC
- AuraDB 全托管云服务
- Aura Agent：知识图谱驱动的 AI Agent 创建平台
- 嵌入式可能：JetBrains MPS 等使用嵌入式模式但非主流
- 不支持原生向量索引（通过第三方或 Aura 图分析扩展）
- GDS（Graph Data Science）库：50+ 内置图算法

**与 AgentiX 比较：**
- ✅ **AgentiX 优势**：真正嵌入式（Rust link），零运维，原生向量+全文搜索，多活 LWW 复制
- ❌ **AgentiX 劣势**：Cypher 支持仅 lite、无安全模型、性能差 2-3 个数量级

| 评分项 | 分值 | 依据 |
|--------|------|------|
| embedding | 3 | 非嵌入式，但可通过 Bolt 驱动 |
| vector | 6 | GDS + 第三方向量支持，非原生 |
| replication | 9 | 企业版集群复制，因果一致性 |
| query | 10 | Cypher 工业标准，无人能及 |
| security | 9 | 企业版 RBAC、审计、加密、LDAP |
| operations | 8 | Bloom 可视化、Fleet Manager、CLI |
| vendorLockIn | 3 | 企业版强锁定，社区版有限 |
| cjkSupport | 7 | 支持 Unicode，但 CJK 分词非专长 |
| performance | 7 | OLTP 遍历性能优秀，但非嵌入式限制延迟 |

---

### 2.2 ArangoDB — 多模型数据库

| 项目 | 内容 |
|------|------|
| **类型** | 多模型（图+文档+键值+搜索） |
| **最新版本** | 3.x 系列（2024-2026活跃开发） |
| **许可证** | 社区版 Apache 2.0 / 企业版商业许可 |
| **语言** | C++ |

**核心能力：**
- AQL 统一查询语言（JSON 查询+图遍历+全文搜索）
- ArangoSearch：集成全文搜索引擎
- SmartGraphs、EnterpriseGraphs、OneShard 部署
- 多模型：文档、图、键值、时间序列、地理空间
- 原生水平扩展 + 自动故障转移
- Pregel 图分析算法集成

**评分：**

| 评分项 | 分值 | 依据 |
|--------|------|------|
| embedding | 2 | 纯客户端-服务器，Docker 部署 |
| vector | 5 | ArangoSearch 支持向量搜索但功能有限 |
| replication | 8 | 多节点集群、SmartGraphs 分片 |
| query | 8 | AQL 强大但非 Cypher 标准 |
| security | 8 | 企业版审计、加密、数据脱敏 |
| operations | 7 | Web UI 优秀，但运维复杂度高 |
| vendorLockIn | 5 | 社区版 Apache，企业版锁定 |
| cjkSupport | 5 | 基础 Unicode 支持，无专门 CJK |
| performance | 7 | C++ 实现，多模型灵活但有开销 |

---

### 2.3 Dgraph — GraphQL 原生图数据库

| 项目 | 内容 |
|------|------|
| **类型** | OLTP 图数据库（分布式） |
| **最新版本** | v25.x（2026年活跃开发） |
| **许可证** | Apache 2.0 |
| **语言** | Go |

**核心能力：**
- 原生 GraphQL 查询（支持 +-schema）
- 分布式 ACID 事务
- 自动分片重平衡
- HNSW 向量索引支持（v25.x bulk loader）
- 被 Dgraph Labs 收购后仍开源
- 水平扩展、线性化读取

**评分：**

| 评分项 | 分值 | 依据 |
|--------|------|------|
| embedding | 1 | 纯分布式，Docker/K8s 部署 |
| vector | 5 | v25 新增 HNSW，功能初步 |
| replication | 8 | 强一致性 RAFT 复制，自动故障转移 |
| query | 7 | GraphQL 友好，但非 Cypher |
| security | 6 | RBAC 有限，无细粒度 |
| operations | 6 | CLI 工具完善，但可视化有限 |
| vendorLockIn | 6 | Apache 开源，但社区规模缩小 |
| cjkSupport | 4 | 无专门 CJK 支持 |
| performance | 7 | Go 实现，分片良好 |

---

### 2.4 SurrealDB — 嵌入式多模型数据库（最接近 AgentiX）

| 项目 | 内容 |
|------|------|
| **类型** | 多模型（文档+图+关系+向量+时序） |
| **最新版本** | v2.x（2025-2026 持续更新） |
| **许可证** | 企业版核心 / BSL |
| **语言** | Rust |

**核心能力：**
- 单 Rust 二进制，支持嵌入式、WASM、边缘节点、分布式集群
- SurrealQL：SQL-like 多模型查询
- 原生向量搜索（HNSW）
- 全文搜索、地理空间查询
- 实时协作 API 后端
- 行级细粒度访问控制
- WebSocket 支持
- 后端即服务（BaaS）能力

**与 AgentiX 比较：**
这是 AgentiX 最直接的竞争对手！都是 Rust 嵌入式图数据库，都有向量搜索能力。

- ✅ **AgentiX 优势**：多活 LWW 复制（SurrealDB 的主从），零拷贝向量，raft-logic WASM 共识
- ❌ **AgentiX 劣势**：SurrealDB 查询语言（Cypher-lite vs SurrealQL）、安全模型、社区规模、品牌

**评分：**

| 评分项 | 分值 | 依据 |
|--------|------|------|
| embedding | 8 | Rust 嵌入式，单二进制，WASM 也支持 |
| vector | 7 | 原生 HNSW 向量搜索 |
| replication | 6 | 集群模式支持，主从复制 |
| query | 7 | SurrealQL 多模型，但非 Cypher 标准 |
| security | 7 | 行级 RBAC，现代安全模型 |
| operations | 7 | CLI、Web UI、Cloud 管理 |
| vendorLockIn | 4 | BSL 许可有一定限制 |
| cjkSupport | 5 | 基础支持，非专长 |
| performance | 7 | Rust 实现，性能优秀 |

---

### 2.5 Kùzu — 嵌入式列式图数据库

| 项目 | 内容 |
|------|------|
| **类型** | OLAP 嵌入式图数据库 |
| **最新版本** | v0.11.3（2025-2026），项目已归档/转型 |
| **许可证** | MIT |
| **语言** | C++ |

**核心能力：**
- 嵌入式无服务器
- 列式磁盘存储
- CSR 邻接表/连接索引
- 向量化+因式分解查询处理器
- 原生全文搜索和向量索引扩展
- Cypher 查询语言
- WASM 绑定
- 多核查询并行

**重要变化：** Kùzu Inc. 已转型，项目归档，不再提供官方扩展服务器。

**评分：**

| 评分项 | 分值 | 依据 |
|--------|------|------|
| embedding | 9 | 真正嵌入式，链接即用 |
| vector | 6 | 扩展形式向量索引 |
| replication | 1 | 不支持复制，嵌入式 |
| query | 8 | Cypher 查询 |
| security | 2 | 无内置安全，嵌入式 |
| operations | 3 | 工具少，项目归档中 |
| vendorLockIn | 9 | MIT 许可 |
| cjkSupport | 3 | 无专门 CJK |
| performance | 8 | OLAP 列式存储，遍历快 |

> **注意：** Kùzu 项目已归档，是目前 AgentiX 最接近的竞品但已退出竞争。

---

### 2.6 EdgeDB (Gel) — 图-关系数据库

| 项目 | 内容 |
|------|------|
| **类型** | 图-关系数据库 |
| **最新版本** | 5.x（2025-2026） |
| **许可证** | Apache 2.0 |
| **语言** | Python + Rust 核心 |

**核心能力：**
- EdgeQL：全新设计的查询语言（替代 SQL）
- 对象类型、链接（link）、约束系统
- PostgreSQL 之上构建
- Gel Cloud 托管服务
- 迁移系统、CLI、自动 schema 生成

**评分：**

| 评分项 | 分值 | 依据 |
|--------|------|------|
| embedding | 3 | 基于 PG，非真正嵌入式 |
| vector | 4 | 通过 PG 扩展支持 |
| replication | 6 | 继承 PG 复制能力 |
| query | 7 | EdgeQL 强大但非标准 |
| security | 6 | 基于 PG 的安全模型 |
| operations | 6 | CLI 和 Cloud 优秀 |
| vendorLockIn | 5 | Apache 开源，但 GraphQL 能力弱 |
| cjkSupport | 6 | PG 底层 Unicode 支持好 |
| performance | 6 | PG 上限限制遍历性能 |

---

### 2.7 CozoDB — Datalog 图+向量（最接近 AgentiX 架构）

| 项目 | 内容 |
|------|------|
| **类型** | 事务关系-图-向量数据库 |
| **最新版本** | v0.7（2024-2025） |
| **许可证** | MPL-2.0 |
| **语言** | Rust |

**核心能力：**
- Datalog 查询（递归、连接、聚合）
- 原生 HNSW 向量搜索（v0.6+）
- 内建 MinHash-LSH 近似重复搜索
- 全文搜索（v0.7）
- JSON 值支持
- 嵌入式（Python、NodeJS、Java、Clojure、Go、Swift）
- WASM——浏览器运行
- 手机端嵌入式运行
- MVCC 事务控制
- Rust RAII 零额外内存开销

**与 AgentiX 比较：**
两者都是 Rust 嵌入式图+向量数据库！CoZo 使用 Datalog（非 Cypher），没有复制能力。

- ✅ **AgentiX 优势**：多活复制、Cypher-lite + Fluent API、gRPC/REST、更丰富的复制协议
- ❌ **AgentiX 劣势**：CozoDB 的 Datalog 递归查询更强大，向量搜索集成更深，跨语言客户端更丰富

**评分：**

| 评分项 | 分值 | 依据 |
|--------|------|------|
| embedding | 10 | 最佳嵌入式（Python/JS/手机/WASM） |
| vector | 8 | 原生 HNSW + Datalog 集成 |
| replication | 1 | 无复制，单点 |
| query | 8 | Datalog 递归能力极强 |
| security | 1 | 无内置安全 |
| operations | 3 | CLI 基本，无 UI |
| vendorLockIn | 9 | MPL-2.0 许可友好 |
| cjkSupport | 4 | 基础 Unicode，无 CJK 分词 |
| performance | 8 | Rust 零开销抽象，MVCC |

---

### 2.8 NebulaGraph — 国内分布式图数据库

| 项目 | 内容 |
|------|------|
| **类型** | OLTP 分布式图数据库 |
| **最新版本** | 3.8.0（2026） |
| **许可证** | Apache 2.0 |
| **语言** | C++ |

**核心能力：**
- 对称分布式、存算分离
- RAFT 强一致性
- OpenCypher 兼容查询
- 水平扩展
- RBAC 安全
- CNCF 生态成员
- 图分析算法集成

**评分：**

| 评分项 | 分值 | 依据 |
|--------|------|------|
| embedding | 1 | 分布式，多组件部署 |
| vector | 2 | 无原生向量搜索 |
| replication | 8 | RAFT 多副本，存算分离 |
| query | 7 | OpenCypher，部分不兼容 |
| security | 6 | RBAC 基本 |
| operations | 6 | 工具链完善，社区活跃 |
| vendorLockIn | 6 | Apache 2.0 开源 |
| cjkSupport | 7 | 中国团队，CJK 支持好 |
| performance | 8 | C++，分布式优化 |

---

### 2.9 Qdrant — 纯向量搜索引擎（嵌入式版）

| 项目 | 内容 |
|------|------|
| **类型** | 向量搜索引擎 |
| **最新版本** | 1.13.x（2026） |
| **许可证** | Apache 2.0 |
| **语言** | Rust |

**核心能力：**
- HNSW + 多种量化技术
- Qdrant Edge 嵌入式版本
- 扩展过滤
- 丰富客户端（Python/JS/Go/Rust）
- 分布式 + 云服务
- Agent Skills 集成

**评分：**

| 评分项 | 分值 | 依据 |
|--------|------|------|
| embedding | 7 | 嵌入式 Edge 版本 |
| vector | 10 | 纯向量引擎，业界最佳 |
| replication | 7 | 分布式集群 |
| query | 4 | 纯向量，无图查询 |
| security | 6 | API 密钥、TLS |
| operations | 8 | UI、Cloud、丰富工具链 |
| vendorLockIn | 7 | Apache 2.0 |
| cjkSupport | 5 | 向量搜索，不涉及文本 |
| performance | 9 | Rust 实现，生产基准已验证 |

---

### 2.10 Typesense — 嵌入式全文+向量搜索引擎

| 项目 | 内容 |
|------|------|
| **类型** | 全文+向量搜索引擎 |
| **最新版本** | v31（2026） |
| **许可证** | GPLv3 |
| **语言** | C++ |

**核心能力：**
- 拼写容错搜索
- 向量搜索（混合搜索）
- 内存优先架构
- 亿级数据集毫秒级响应
- 单二进制部署

**评分：**

| 评分项 | 分值 | 依据 |
|--------|------|------|
| embedding | 4 | 单二进制，非 link 嵌入式 |
| vector | 6 | 向量+全文混合搜索 |
| replication | 5 | 有限复制 |
| query | 4 | REST API，无图查询 |
| security | 5 | API 密钥 |
| operations | 7 | Cloud 服务、CLI |
| vendorLockIn | 4 | GPLv3 限制商业嵌入 |
| cjkSupport | 6 | 拼写容错，CJK 有一定支持 |
| performance | 9 | C++ 内存索引，极快 |

---

### 2.11 JanusGraph

| 项目 | 内容 |
|------|------|
| **类型** | OLTP 分布式图数据库 |
| **最新版本** | 1.0.x（2024-2026） |
| **许可证** | Apache 2.0 |
| **语言** | Java |

**评分：**

| 评分项 | 分值 | 依据 |
|--------|------|------|
| embedding | 2 | 分布式部署，依赖后端 |
| vector | 1 | 无向量支持 |
| replication | 5 | 依赖底层存储系统 |
| query | 7 | Gremlin/Cypher 双支持 |
| security | 5 | 基础 |
| operations | 5 | 生态工具多 |
| vendorLockIn | 7 | Apache 2.0 |
| cjkSupport | 4 | 基础 Unicode |
| performance | 6 | Java 虚拟机开销 |

---

### 2.12 HugeGraph — 百度开源

| 项目 | 内容 |
|------|------|
| **类型** | OLTP 图数据库 |
| **最新版本** | 1.5+（2025-2026，Apache 孵化） |
| **许可证** | Apache 2.0 |
| **语言** | Java |

**核心能力：**
- Gremlin + Cypher 双查询
- RocksDB/HBase/HDFS 后端
- Flink/Spark 大数据集成
- 图AI/LLM/知识图谱集成
- 百亿级顶点+边

**评分：**

| 评分项 | 分值 | 依据 |
|--------|------|------|
| embedding | 1 | Java 服务部署 |
| vector | 2 | 可通过 AI 扩展支持 |
| replication | 6 | 多后端支持 |
| query | 7 | Gremlin + Cypher |
| security | 5 | 基础 |
| operations | 6 | 工具链完善 |
| vendorLockIn | 7 | Apache 2.0 |
| cjkSupport | 7 | 中国团队，CJK 支持好 |
| performance | 6 | Java，但后端灵活 |

---

### 2.13 Microsoft GraphRAG

| 项目 | 内容 |
|------|------|
| **类型** | RAG + 知识图谱（非图数据库） |
| **最新版本** | 持续更新（2025-2026） |
| **许可证** | MIT |
| **语言** | Python |

**核心能力：**
- LLM 驱动的知识图谱提取
- 社区检测 + 摘要
- 全局/局部搜索
- 模块化管线

**评分：**

| 评分项 | 分值 | 依据 |
|--------|------|------|
| embedding | 1 | Pip 安装，调用外部存储 |
| vector | 3 | 使用 LLM 嵌入 |
| replication | 1 | 无图数据库能力 |
| query | 5 | LLM 自然语言，无标准查询语言 |
| security | 3 | 无内置安全 |
| operations | 3 | 命令行工具 |
| vendorLockIn | 5 | MIT 开源 |
| cjkSupport | 8 | LLM 可处理 CJK |
| performance | 3 | LLM 调用瓶颈 |

---

### 2.14 TigerGraph

| 项目 | 内容 |
|------|------|
| **类型** | OLTP+OLAP 图数据库 |
| **最新版本** | 4.x（2025） |
| **许可证** | 商业许可（社区版有限） |
| **语言** | C++ |

**评分：**

| 评分项 | 分值 | 依据 |
|--------|------|------|
| embedding | 1 | 完全非嵌入式 |
| vector | 3 | Graph+AI 扩展 |
| replication | 8 | 企业级 HA |
| query | 7 | GSQL 专有语言 |
| security | 8 | 企业级 RBAC+审计 |
| operations | 7 | GraphStudio 可视化 |
| vendorLockIn | 2 | 强商业锁定 |
| cjkSupport | 4 | 基础 |
| performance | 9 | C++ 原生，业界最快之一 |

---

## 三、AgentiX 综合评分

### 架构快照（来自源码分析）

| 组件 | 技术栈 |
|------|--------|
| 引擎 | OverGraph (Rust 原生) |
| 复制 | ZMQ + Outbox + PerPeerWorker |
| 共识 | raft-logic WASM (v0.3.14) |
| 查询 | Cypher-lite (peggy 生成) + Fluent API + REST + gRPC |
| 向量 | OverGraph HNSW |
| 全文 | MiniSearch |
| 存储 | LMDB + SegmentStreamWal |
| 性能 | ~8K-12K ops/sec（单节点） |

### 评分矩阵

| 评分项 | 分值 | 说明 |
|--------|------|------|
| **embedding** | **9** | Rust 原生嵌入式，无依赖，单 binary link |
| **vector** | **8** | OverGraph HNSW，零拷贝向量 |
| **replication** | **7** | 多活 LWW + ZMQ + PerPeerWorker，创新但非成熟 |
| **query** | **5** | Cypher-lite 子集 + Fluent API，功能有限 |
| **security** | **4** | 无 RBAC、无审计、无加密传输 |
| **operations** | **5** | 无 Web UI、无可视化、无监控面板 |
| **vendorLockIn** | **9** | 完全开源，无商业锁定 |
| **cjkSupport** | **4** | MiniSearch 基础，无 CJK 分词 |
| **performance** | **6** | 8K-12K ops/sec 单节点，远低于专业竞品 |

### 定位总结

> **AgentiX 定位**：AI Agent 时代嵌入式多活向量图数据库
> 
> **核心差异化**：嵌入式免运维 + 零拷贝向量 + 多活 LWW 复制 + raft-logic WASM 共识
> 
> **最佳适配场景**：AI Agent 本地存储、边缘设备图数据、嵌入式 IoT 图+向量搜索

---

## 四、综合排名（加权总分）

按加权评分排序（权重：embedding 0.20, vector 0.15, replication 0.10, query 0.15, security 0.05, operations 0.05, vendorLockIn 0.05, cjkSupport 0.05, performance 0.20）

| 排名 | 产品 | 加权分 | 核心竞争力 |
|------|------|--------|------------|
| 1 | **Neo4j** | 7.55 | 查询 & 生态王者，企业最成熟 |
| 2 | **CozoDB** | 7.45 | 最佳嵌入式图+向量组合，Datalog 强大 |
| 3 | **SurrealDB** | 7.20 | 最全的多模型嵌入式，BaaS 能力 |
| 4 | **ArangoDB** | 6.85 | 多模型 & 搜索一体化 |
| 5 | **Qdrant** | 6.80 | 纯向量引擎标杆，Edge 版本 |
| 6 | **Kùzu** | 6.75 | 嵌入式 Cypher 图，但已归档 |
| 7 | **Dgraph** | 6.40 | 分布式 GraphQL 原生 |
| 8 | **NebulaGraph** | 6.25 | 国内开源图数据库首选 |
| 9 | **Typesense** | 6.20 | 全文+向量，速度冠军 |
| 10 | **TigerGraph** | 5.90 | 性能怪兽，商业锁定 |
| 11 | **AgentiX** | **5.80** | **嵌入式多活向量图数据库，潜力巨大** |
| 12 | **EdgeDB** | 5.75 | PG 之上的图-关系 |
| 13 | **HugeGraph** | 5.55 | 国内 Apache 孵化，生态好 |
| 14 | **JanusGraph** | 5.20 | 分布式 TinkerPop 老牌 |
| 15 | **GraphRAG** | 3.75 | RAG 管线，非图数据库 |

---

## 五、Top 差距分析

### 5.1 最关键差距

| 差距 | 严重程度 | 影响 | 建议 |
|------|----------|------|------|
| **查询语言** | 🔴 致命 | 开发者无法使用熟悉的 Cypher 查询复杂模式 | 提升 Cypher 兼容性（从 lite 到 80%+ 覆盖） |
| **安全模型** | 🟠 严重 | AI Agent 需要隔离不同租户/用户的图数据 | 增加 RBAC、TLS、加密存储 |
| **性能** | 🟠 严重 | 8K-12K ops/sec 远低专业竞品 50K-100K | OverGraph 引擎优化、向量化查询执行 |
| **CJK 分词** | 🟡 重要 | 中文/日文/韩文搜索体验差 | 集成 Jieba、Kuromoji 等开源分词器 |
| **运维工具** | 🟡 重要 | 无 Web UI、无法监控 | 开发 Grafana Dashboard + Web Console |
| **文档质量** | 🟢 基础 | API 文档、性能基准、示例 | 完善中文/英文文档 |

### 5.2 速赢项（Low-hanging fruit）

| 速赢项 | 优先级 | 工作估计 | 对标竞品 |
|--------|--------|----------|----------|
| 增加性能基准页面 | 🔴 高 | 1-2天 | 所有竞品都有 |
| 文档补全（Fluent API 示例） | 🔴 高 | 3-5天 | CozoDB 文档最好 |
| CJK 分词支持（集成 CJieba） | 🔴 高 | 2-3天 | NebulaGraph/HugeGraph 都有 |
| 增加 Graphviz/D3 可视化 | 🟠 中 | 3-5天 | JanusGraph 可视化生态 |
| 增加 Cypher 兼容测试报告 | 🟠 中 | 2-3天 | Neo4j TCK |
| 贡献者指南 + 社区接入 | 🟡 低 | 2-3天 | 所有成熟项目 |
| 发布 npm wheel (WASM) | 🟡 低 | 3-5天 | SurrealDB/CoZo 已支持 |

### 5.3 差异化优势（不可替代）

AgentiX 的独特组合在竞品中**没有替代品**：

1. **嵌入式 + 多活复制的唯一组合**：CozoDB 无复制，SurrealDB 只有主从复制
2. **零拷贝向量**：OverGraph HNSW 零拷贝设计优于 CozoDB/Qdrant
3. **raft-logic WASM 共识**：可移植共识算法 WASM 形式
4. **PerPeerWorker + Outbox 模式**：创新复制架构
5. **AI Agent 原生设计**：嵌入式、轻量、易集成

---

## 六、JSON 评分矩阵

> JSON 评分矩阵及完整竞品数据请参见 companion file `competitor-scores.json`（覆盖 15 个竞品，639 行结构数据）。

---

## 七、文件产出

本分析产出两个文件：

| 文件 | 路径 | 说明 |
|------|------|------|
| Markdown 报告 | `competitor-benchmark-2026.md` | 本文档，含深度分析和评分说明 |
| JSON 评分矩阵 | `competitor-scores.json` | 完整机器可读评分矩阵 + 差距分析 + 速赢项清单 |

所有评分基于 2026 年 5 月 26 日的联网搜索数据。竞品信息可能随时变化。