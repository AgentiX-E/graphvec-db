__V6_STORAGE_COMPLETE__

## 完成内容

### GAP-14: 列式索引 (Columnar Index)

| 文件 | 描述 |
|------|------|
| `src/core/columnar-index.ts` | `ColumnarIndex` 类，使用 `lmdb` 持久化列索引 |
| `src/core/columnar-index.spec.ts` | 25 个测试，覆盖率完整 |
| `src/core/storage-provider.ts` | `StorageConfig` 新增 `colIndex` 配置项 |
| `src/core/overgraph-storage.ts` | 集成列索引到 `upsertNode`/`deleteNode`/`open`/`close` |

**关键设计**：
- 键格式: `<column_name>:<value>:<node_id>`
- 数值补零到 20 位，保证字典序范围扫描正常工作
- `buildForColumn(col, iterator)` / `rangeScan(col, op, val, val2?)` / `eq(col, val)` /
- `deleteNodeIndexes(id)` / `updateNodeIndexes(id, props)`
- 支持: eq, gt, gte, lt, lte, between 六种扫描

### GAP-15: CDC 变更数据捕获

| 文件 | 描述 |
|------|------|
| `src/core/cdc-adapter.ts` | `CdcAdapter` 类 — 事件转换、环形缓冲区、订阅管理 |
| `src/core/cdc-adapter.spec.ts` | 7 个单元测试 |
| `src/api/cdc-server.ts` | WebSocket / HTTP Long-Polling / Webhook 三个接口 |
| `src/api/cdc-server.spec.ts` | 23 个集成测试 |

**关键设计**：
- `CdcAdapter.subscribe(id, handler, filter?)` / `unsubscribe(id)` / `querySince(seq)`
- WebSocket: 原生实现（无外部依赖）ws://host:port/cdc
- HTTP Long-Polling: GET /api/v1/cdc/stream?since=<seq>&ops=create,delete
- Webhook: 事件自动 POST 到配置的 URL 列表
- 环形缓冲区（默认 10000 条）支持断点续传

### 测试结果

- `columnar-index.spec.ts`: 25/25 ✅
- `cdc-adapter.spec.ts`: 7/7 ✅
- `cdc-server.spec.ts`: 23/23 ✅
- `graph-config.spec.ts` (existing): 4/4 ✅
- `multi-backend.spec.ts` (existing): 57/57 ✅
