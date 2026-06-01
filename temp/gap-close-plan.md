# GAP Close Plan — 2026-06-01

## 并行组

### Group A：独立 spec 文件（互不依赖，可并行）
1. `schema-integration.spec.ts` — Schema + GraphEngine 集成测试
2. `graph-adapter.spec.ts` — graphology adapter spec
3. `bfs.spec.ts` + `dfs.spec.ts` — 算法独立 spec
4. `pagerank.spec.ts` + `dijkstra.spec.ts` — 算法独立 spec
5. `closeness.spec.ts` — 算法独立 spec
6. `bfs-stream.spec.ts` + `pagerank-stream.spec.ts` — 流式算法 spec

### Group B：功能增强（依赖已有代码，顺序执行）
7. Reshard execute() migration
8. Rebalancer checksum
9. Q03 optimize() → executor 打通
