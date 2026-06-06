# AgentiX GraphVec Benchmark Report

> **Last updated**: 2026-06-06 (V35)
> **Environment**: Node.js 24.x, Linux 5.15, Intel Xeon (single node)

---

## Throughput

| Operation | Count | Time | Ops/sec | Notes |
|-----------|-------|------|---------|-------|
| upsertNode | 10 | ~1-5ms | 2,000+ | Cold start, first insert |
| upsertNode | 50 | ~1-3ms | 10,000+ | Warm, batch insert |
| upsertNode | 100 | ~1-3ms | 20,000+ | Sustained throughput |
| upsertEdge | 30 | ~0ms | 100,000+ | In-memory edge append |
| getNode | 100 (×10) | ~0ms | 200,000+ | LRU cache hit ratio >95% |
| scanAllNodes | 100 | ~1ms | 100,000+ | Full scan |
| deleteNode | 50 | ~1ms | 50,000+ | Tombstone + cleanup |
| shortestPath | 50 queries | ~8,462ms | 5.9 q/s | Full graph traversal |
| batchDeleteNodes | 100 | ~41ms | 2,439/s | Bulk delete operation |

## Latency

| Operation | Conditions | Mean | Tail (p99) |
|-----------|-----------|------|-----------|
| upsertNode | 10/50/100 batch | <1ms | ~5ms |
| getNode | cache hit | <0.1ms | <1ms |
| getNode | cache miss | ~1ms | ~5ms |
| scanAllNodes | 100 nodes | <1ms | ~2ms |
| neighbors | 1 depth | <0.1ms | <1ms |

## Scalability

| Operation | Scale Range | Behavior | Notes |
|-----------|------------|----------|-------|
| upsertNode | 10→100 typeIds | O(1) per typeId | Constant cost |
| scanAllNodes | 50→200 nodes | O(n) linear | Full scan |

### Known Limitations
- `neighbors()` with props on nodes may return undefined (engine bug, tracked)
- `scanAllNodes` with competing write+scan may give stale counts (MVCC behavior)
- Bulk operations >10,000 may hit micro-batch frame timing

---

## Test Coverage (V36, ~8,100 tests)

| Module | Tests | Status |
|--------|-------|--------|
| Cypher / TCK | 214 | 43% of 500 target |
| Core (engine, storage) | ~1,600 | Good |
| Query | ~1,647 | Good |
| Algorithms | ~585 | Including PageRank, Louvain, BFS, DFS, Shortest Path, Triangle Count |
| E2E | 444 | 89% of 500 target |
| Stress | 192 | 96% of 200 target |
| Security (RBAC, TLS, Audit) | ~395 | Good |
| Shard / Consensus | ~223 | Good |
| HNSW / Vector | ~200 | Good |
| Benchmark | 208 | 42% of 500 target |

---

*Report auto-generated. See `src/benchmark/` for runnable test suites.*
