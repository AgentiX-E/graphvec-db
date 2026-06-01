# v4-track3 执行计划

创建时间: 2026-06-02 07:02

## 目标
实现 Deep Review V4 中存储引擎+图算法+运维模块的 14 个 GAP 项。

## 执行顺序

### Batch 1 — 独立简单项（并行）
- [ ] A-03: SimpleTxnManager SSI 冲突检测（writeSet/deleteSet）
- [ ] A-07: WAL fsync策略调优（every-n n=100）
- [ ] D-07: inEdges 度数缓存（inDegree/outDegree Map）
- [ ] D-09: K8s 三探针（liveness/readiness/startup）
- [ ] D-11: 慢查询日志 persistent rotating file

### Batch 2
- [ ] D-13: 恢复可观测性（restore onProgress）
- [ ] B-08: Transport TLS 加密
- [ ] C-09: EventBus 消息 WAL 持久化

### Batch 3
- [ ] D-05: 图算法多线程（PageRank/Louvain）
- [ ] D-04: 缺失核心算法（k-core + node2vec）

### Batch 4
- [ ] D-08: 指标统一 metrics→OTel
- [ ] D-12: 导入事务支持
- [ ] A-08: 复合索引唯一约束
- [ ] D-14: 审计日志远程 Sink

## 当前进度
正在执行: Batch 1
