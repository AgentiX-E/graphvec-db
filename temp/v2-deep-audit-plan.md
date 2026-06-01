# V2 深审待覆盖项计划

## 状态

### 已确认跳过
- Item 2 (P1-RH02): 无 `(engine as any).db` hack，跳过
- Item 5 (P2-R-05): PreVote 已在 raft-core.ts 实现，有 transport.spec.ts 测试
- Item 6: Rebalancer 已有 load/save reshard state，确认完整
- Item 13 (P2-S03): `src/search/` 无向量搜索，跳过

### 待执行项
1. ✅ P1-Q14 REST 参数验证 (api-validation.ts + spec)
2. ✅ P1-RH03 ReshardPlan 拆分策略优化
3. ✅ P2-W-04 WAL CRC 校验
4. ✅ P1-S02 边写入路由对称 (shard-router.ts)
5. ✅ P1-I04 范围索引 (range-index.ts + spec)
6. ✅ P1-Q20 全文 analyzer 链扩展 (fulltext.ts)
7. ✅ P1-S01 智能路由优化 (shard-router.ts)
8. ✅ P1-S03 CSR 压缩优化 (graph-projection.ts)
9. ✅ P2-A04 Leiden 算法 (leiden.ts + spec)
10. ✅ GraphQL Schema 基础实现 (graphql-adapter.ts + spec)
11. ✅ 中文搜索增强 - 同义词 (fulltext.ts)
