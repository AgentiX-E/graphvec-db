# Phase 0 执行计划

## 依赖图

```
Day 0: 安装依赖 ✅（18 个包已验证）
          │
          ├── 并行 1（零冲突）──────────────
          │   E01: mTLS-only 认证重构      ✅
          │   A03: MiniSearch 替换         ✅
          │   E02: chokidar 热加载         ✅
          │                                │
          ├── 并行 2（纯测试文件）───────────
          │   E04: CURVE 集成测试          ✅
          │   旧文件清理                    ✅
          │   rest.spec 重写               ✅
          │                                │
          ├── 并行 3（新模块）──────────────
          │   E03: DatabaseManager         ✅
          │   A04: graphology adapter      ✅
          │   A05: LMDB WAL                ✅
          │                                │
          └── 待推进────────────────────────
              A01: batchNeighbors + 缓存   ⬜
              E05: HTTPS/mTLS 配置         ⬜
              InstallSnapshot              ⬜
              成员变更                     ⬜
              Pipeline                     ⬜
              readIndex safety             ⬜
```

## 当前进度

### 完成 ✅
- [x] Day 0: 安装全部 18 个 npm 依赖
- [x] E01: mTLS-only 认证引擎重构（rest.ts → https + Authenticator + RBAC）
- [x] E02: chokidar 身份文件热加载（auth.ts startWatch → chokidar + stat 兜底）
- [x] E03: DatabaseManager 多数据库（目录隔离 + ShardMap）
- [x] E04: CURVE 集成测试（真实 ZMQ PUB/SUB 双向通信 ✅）
- [x] A03: MiniSearch 替换全文搜索（fulltext.ts → minisearch）
- [x] A04: graphology adapter（graph-adapter.ts + 7 扩展包验证 SCC/Centrality）
- [x] A05: LMDB WAL（lmdb-wal.ts, 接口兼容 WAL, msgpackr 序列化, 已验证）
- [x] 旧文件清理（segmented-fulltext.*, fuzzy-search.* → 已删除）
- [x] rest.spec 重写为 mTLS-only 测试（28/28 passed ✅）
- [x] fulltext.spec 适配 MiniSearch（15/15 passed ✅）
- [x] tsc 0 errors ✅
- [x] 全量测试 622/622 passed ✅（51/52 suites, 1 已知 OOM worker）

### 待推进
- [ ] A01: batchNeighbors + LRU 缓存（graph-engine.ts, 已部分实现）
- [ ] E05: HTTPS/mTLS 传输层（tls.ts + rest.ts 已打通 mTLS）
- [ ] InstallSnapshot + 成员变更 + Pipeline（共识层特性）
- [ ] readIndex safety（共识层安全）
