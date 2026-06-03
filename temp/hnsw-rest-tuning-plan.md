# HNSW 参数调优 + REST API 错误码标准化

创建时间: 2026-06-03 23:43

## 目标

1. **HNSW 参数调优**: `HnswIndex` 已暴露 `M` 和 `efConstruction`，但 `VectorIndexManager` 未暴露。需要给 `VectorIndexManager` 添加 HNSW 创建参数 + 给 `HnswIndex` 添加 `efSearch` 运行时 setter + 给 query-engine 添加 `SEARCH OPTIONS` 支持。
2. **REST API 错误码标准化**: 统一错误响应格式 `{ error: string, code: number, details?: any }`，新建 `src/api/rest-error.spec.ts` 测试。

## 步骤

- [x] 步骤1: 分析现有代码结构
- [ ] 步骤2: 给 `HnswIndex` 添加 `setEfSearch()` 运行时方法
- [ ] 步骤3: 给 `VectorIndexManager` 暴露 `M` 和 `efConstruction` 参数
- [ ] 步骤4: 添加 `HnswIndex` 测试 (≥4 个新测试)
- [ ] 步骤5: 标准化 REST API 错误响应格式
- [ ] 步骤6: 创建 `src/api/rest-error.spec.ts` (≥3 个测试)
- [ ] 步骤7: 运行所有测试确认 ✅

## 当前进度

✅ 全部完成
