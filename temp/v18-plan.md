# V18 执行计划 — 三路功能迭代

创建时间: 2026-06-03 18:12

## 目标
GNN 完整管道 + FOREACH WHERE + 多模型

## Phase 1 (P0): GNN → GraphEngine 真实特征编码
- [ ] GraphEngineFeatureEncoder: 从 GraphEngine.getNode 读取 props 构建特征向量
- [ ] 多特征字段聚合（多个 prop 字段拼成向量）
- [ ] missing prop 处理（null/undefined → 0）
- [ ] GnnInferenceEngine 接受 GraphEngine 引用
- [ ] gnn-engine.spec.ts 扩展测试（用 GraphEngine + 最小 ONNX）

## Phase 2 (P0): 多模型支持
- [ ] loadModel 改为 loadModel(name, path)，支持命名模型
- [ ] switchModel(name) 切换当前激活模型
- [ ] unloadModel(name) 卸载
- [ ] getLoadedModels() 列出
- [ ] gnn-engine.spec.ts 扩展测试

## Phase 3 (P1): FOREACH WHERE + 混合操作
- [ ] parseQuery: FOREACH 解析 WHERE 子句
- [ ] _executeForeach: WHERE 过滤列表元素
- [ ] 混合操作支持（CREATE+SET+DELETE 组合）
- [ ] foreach.spec.ts 扩展测试

## Phase 4 (P2): GNN Python 训练脚本
- [ ] scripts/train-gnn.py: DGL/PyG 训练一个 2-layer GCN
- [ ] 导出 ONNX 到 /tmp/gnn-model.onnx
- [ ] 与集成测试配对使用

## 当前进度
启动中
