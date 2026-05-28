# R7 P0-4: StorageProvider 流式分块快照

创建时间: 2026-05-29 07:27

## 目标

为 `OverGraphStorage` 添加流式分块快照能力：
- `exportSnapshotChunked(chunkSize?)` → AsyncGenerator<Buffer>
- `exportSnapshotAtomic(id, chunkSize?)` → 原子写入文件
- `importSnapshotStream(stream)` → 校验并重建图
- SHA-256 全量校验
- 分块头部含 chunkIndex / totalChunks / checksum

## 步骤

- [x] 步骤1: 阅读当前代码（overgraph-storage.ts, storage-provider.ts, overgraph.d.ts）
- [x] 步骤2: 实现分块导出、原子写入、流式导入
- [ ] 步骤3: 创建测试文件 overgraph-storage.spec.ts
- [ ] 步骤4: 运行 graph-engine.spec.ts 确保不影响现有测试
- [ ] 步骤5: 运行新测试

## 当前进度

正在执行: 步骤2
