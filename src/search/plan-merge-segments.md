# Merge Segments Implementation Plan

## 目标
实现高效的段合并机制，使用 FullTextIndex.getAllIndexedDocs() 而非 JSON 序列化/反序列化。

## 步骤
- [x] 1. 阅读 fulltext.ts 和 segmented-fulltext.ts 了解现有代码
- [x] 2. 在 FullTextIndex 中添加 `getAllIndexedDocs()` 公共方法
- [x] 3. 重构 SegmentedFullTextIndex.merge() 使用新方法
- [x] 4. 运行现有测试确认没破坏功能 ✅ 22 pass → 28 pass
- [x] 5. 添加合并相关测试（7 个新测试：bounded count, consistency, multi-field, highlight, 两种 policy）
- [x] 6. 修复 bug：merge 时用对象引用而非 id 去重（Date.now() 碰撞导致段丢失）
- [x] 7. 运行 tsc --noEmit 确认零错误
