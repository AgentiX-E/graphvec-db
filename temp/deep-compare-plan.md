# Deep Compare: AgentiX GraphVec vs Neo4j/Dgraph/ArangoDB/JanusGraph

创建时间: 2026-06-01 19:45

## 目标

对 AgentiX GraphVec 源码进行掘地三尺的全面审查，与 Neo4j/Cypher, Dgraph/GraphQL±, ArangoDB/AQL, JanusGraph/Gremlin 深入比较，列出所有需要提升的项目，对每项详细说明：
1. 问题是什么
2. 如何解决
3. 是否需要引入 npm 包（多个候选时代码级比较）
4. 是否需要自研（及原因）
5. 验收测试条款

**约束**: npm 包必须可嵌入且不需要外部服务。无符合条件的才自研。

## 分析维度

| # | 维度 | 负责 |
|---|------|------|
| 1 | **图存储引擎** | sub-agent |
| 2 | **查询语言与优化器** | sub-agent |
| 3 | **图算法** | sub-agent |
| 4 | **分布式/共识/Raft** | sub-agent |
| 5 | **API/GraphQL/REST** | sub-agent |
| 6 | **安全/运维/备份** | sub-agent |

## 对比基线

- **Neo4j**: Cypher, Bolt协议, 原生图存储, ACID, 集群(PRIMARY/SECONDARY)
- **Dgraph**: GraphQL±, Badger存储, 分片, Alpha/Zero架构
- **ArangoDB**: AQL, Multi-Model, SmartGraph, 多存储引擎
- **JanusGraph**: Gremlin, Cassandra/Scylla后端, 事务管理

## 工作流

1. 每个 sub-agent 读取对应源码目录中的所有 `.ts` 文件
2. 对比行业标准列出 gap 和改进项
3. 输出到 `temp/deep-compare-{维度}.md`
4. 主 agent 汇总并得到完整清单

## 进度

- [x] 启动 5 个子 agent (max 5/5)
  - storage-review: 图存储引擎
  - query-review: 查询语言与优化器
  - algo-review: 图算法
  - distributed-review: 分布式/共识/Raft
  - api-review: API/REST/GraphQL
- [ ] 安全/运维 维度由于达上限，由主 agent 在汇总时完成
- [ ] 等待所有子 agent 完成
- [ ] 汇总为完整报告
