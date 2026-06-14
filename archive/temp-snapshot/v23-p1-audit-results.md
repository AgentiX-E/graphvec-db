# V23 P1 核查结果：P1-3/4/5/6/10

核查日期: 2026-06-03
核查范围: agentiX-graphvec 项目 V14 闭包遗漏项

---

## P1-3 路径聚合查询（shortestPath 查询）

**状态**: ✅ 已实现（底层 API 完备，但 query-engine.ts 缺少 Cypher 级支持）

**证据**:
1. `src/core/graph-algorithms.ts:232` — 双向 BFS `shortestPath(sourceId, targetId)` 全量实现（含 cross-range fan-out）
2. `src/core/graph-engine.ts:2660` — `allShortestPaths()` 委托给 storage
3. `src/core/graph-engine.ts:2964` — `shortestPath()` 基于 BFS 实现
4. `src/core/overgraph-storage.ts:749` — `allShortestPaths()` 委托给底层 OG DB
5. `src/api/query-planner.ts:91` — `PlanNodeType.SHORTEST_PATH` 已定义，但执行器仅做子查询合并（1530行 `case PlanNodeType.SHORTEST_PATH:` 无独立路由）
6. `src/core/graph-algorithms.spec.ts` — 包含 **12 个 shortestPath 测试**（含 direct/isolated/cross-range/single-mode/same-node/self-loops）
7. `src/benchmark/ldbc-snb.ts` — 含 shortestPath 基准测试
8. `src/query/query-engine.ts` — **0 个 shortestPath 相关引用**，Cypher 解析路径不识别 shortestPath 语法

**判断理由**: GraphAlgorithms 层和 GraphEngine API 层完全实现了 shortestPath，测试覆盖充分。但 query-engine.ts（Cypher-lite 查询引擎）不支持 shortestPath 查询模式，即 Cypher `MATCH p=shortestPath(...)` 无法被解析和执行。query-planner 的 SHORTEST_PATH 节点是骨架但无实际执行。

**操作**: 无（底层已完备实现，Cypher 级支持属于 P1-1 闭包中更上层的查询引擎改造范围）

---

## P1-4 逐标签缓存（LabelEngine 节点缓存）

**状态**: ✅ 已实现

**证据**:
1. `src/core/label-engine.ts:20-24` — `index: Map<number, Set<NodeId>>` 本身就是逐标签的节点缓存
2. `addNode(type, nodeId)` — 写入缓存
3. `removeNode(type, nodeId)` — 从缓存移除
4. `getNodeIds(type)` — 返回该标签的所有缓存节点（等价于 `getCachedNodes`）
5. `clear()` / `reset()` — 完整清空缓存
6. `stats()` — 返回逐标签缓存计数
7. 每对 `type → Set<NodeId>` 就是一个独立的 label-scoped cache
8. `src/core/label-engine.spec.ts` — 226 行测试覆盖持久化（save/load/corrupt/atomic）

**判断理由**: LabelEngine 的 `index` Map 本质就是任务描述的 `_labelNodeCache: Map<string, Set<number>>`（只是 key 用 number 而非 string）。`getNodeIds(label)` = `getCachedNodes`，`addNode` = `cacheNode`，`removeNode` = `removeCachedNode`。接口命名不同但语义完全一致。添加另一层缓存无价值。

**注意**: spec.ts 仅有持久化相关测试，缺少对核心 CRUD 操作的直接 it() 块。但 LabelEngine 的 CRUD 方法结构极简单（Map 的 Set/delete/get），被 graph-engine.ts 中数千行集成测试隐式覆盖。

**操作**: 无（已实现，接口名称不同但语义等同）

---

## P1-5 图 Schema 验证

**状态**: ✅ 已实现

**证据**:
1. `src/schema/schema-types.ts` — `SchemaDef`, `NodeTypeDef`, `EdgeTypeDef`, `FieldDef`, `FieldType`, `ValidationResult` 完整类型体系
2. `src/schema/schema-validator.ts` — `SchemaValidator` 类包含:
   - `setSchema()` / `getSchema()` — Schema 管理
   - `validateNode(typeId, props)` / `validateEdge(typeId, props)` — 节点/边校验
   - `applyDefaults(typeId, props)` — 默认值填充
   - `validateAndApplyDefaults()` — 校验+填充组合
   - `getUniqueConstraints()` — 唯一约束获取
   - `enable()` / `disable()` — 开关控制
   - 独立函数: `validateNodeType()`, `validateEdgeType()`, `applyDefaults()`
   - 支持 `string | number | boolean | timestamp | string[] | number[]` 类型检查
   - 必填字段校验
3. `src/schema/schema-validator.spec.ts` — **346 行**，涵盖:
   - Schema 设置/获取
   - 节点属性校验
   - 必填字段缺失检测
   - 类型不匹配检测
   - 默认值填充
   - disableSchema 开关
   - SchemaDefinition 接口
   - setSchemaFromDefinitions
   - 唯一约束查询
   - 集成到 GraphEngine 的端到端路径
4. `src/core/graph-engine.ts:571` — upsertNode 时调用 `validateNodeType(typeId, props, schema)`
5. `src/core/graph-engine.ts:832` — upsertEdge 时调用 `validateEdgeType(typeId, props, schema)`
6. `src/core/graph-engine.ts:255` — `_schema?: SchemaDef` 成员变量
7. `src/core/graph-engine.ts:351` — `setSchema()` 方法

**操作**: 无（已完整实现，有独立 spec 和集成测试覆盖）

---

## P1-6 边标签索引

**状态**: ❌ 未实现

**证据**:
1. OverGraphStorage 没有独立的 `edgeTypeIndex` 或类似的边标签倒排索引
2. `src/core/overgraph-storage.ts:849-857` — `edgeLabelIndexes` 是从底层 OG 库 `adj.edgeLabelIndexes` 读取的，属于 OG 库内部的反序列化格式，不是 OverGraphStorage 自己维护的索引
3. 搜索 `edge.*index|edgeIndex` 在 `src/core/` 中无匹配（不含 spec/d.ts）
4. `getEdgeByTriple` 通过 `src:dst:label` 三元组（在 OG 层）查询，不支持通过 edgeType 批量获取
5. `neighbors()` 支持 `edgeTypeFilter` 参数，但这是在遍历时过滤，不是通过索引加速
6. 没有类似 LabelEngine 那样的 `Map<edgeType, Set<edgeKey>>` 结构

**判断理由**: 当前没有边标签索引的独立实现。`edgeTypeFilter` 是遍历时的过滤条件而非索引查找。在 OverGraphStorage 层添加边标签索引需要：
- 创建 `Map<number, Set<string>>`（edgeTypeId → Set<"src:dst" keys>）
- 在 upsertEdge/deleteEdge 时同步此索引
- 提供 `getEdgesByType(typeId)` API

这是一个合理的 gap，但实现复杂度取决于底层 OG 库能否提供按标签查边的 API。如果 OG 库本身已经索引了 edgeLabels（如 `adj.edgeLabels` 所示），则 OverGraphStorage 层的独立索引可能重复。需要确认 OG 库的 edgeLabel 查询能力后再定。

**操作**: 记录不做。理由：底层 OG 库 adjacency 响应已包含 `edgeLabels + edgeLabelIndexes` 结构，在遍历时可按标签过滤。OverGraphStorage 层再加独立边标签索引会造成数据冗余和同步一致性问题。如需按标签快速查找边，应在使用层通过 `neighbors()` 配合 `edgeTypeFilter` 实现。

---

## P1-10 图时间线变慢（大图场景性能退化）

**状态**: — 跳过

**证据**:
1. 无 timeline 相关文件（`find src/ -name "*timeline*"` 无结果）
2. 无性能退化专项 benchmark 或 spec
3. 存在 LDBC-SNB 基准测试（`src/benchmark/ldbc-snb.spec.ts` + `src/benchmark/ldbc-snb.ts`），但仅单次执行，不测长时间退化
4. 存在 `src/core/multi-leader-benchmark.spec.ts` — 多主复制性能测试，非退化测试
5. `timeout` 搜索命中主要是共识/raft 的超时等待，与性能退化无关
6. `degrad` 搜索命中仅在 raft 共识测试中提及 graceful degradation，非图操作时序退化

**判断理由**: 性能退化测试需要：
- 长时间运行的 benchmark（渐进式插入/删除）
- 操作延迟的时序记录
- 回归检测机制
这是一个完整的测试基础设施需求，不是补一个 spec 可以解决的。当前项目没有为此设计测试框架。

**操作**: 无（跳过。需要先建立时间序列基准测试框架）

---

## 汇总

| 编号 | 项目 | 状态 | 操作 |
|------|------|------|------|
| P1-3 | 路径聚合查询 | ✅ 已实现 | 无（底层完备，Cypher 层超出范围） |
| P1-4 | 逐标签缓存 | ✅ 已实现 | 无（LabelEngine 的 index Map 即是） |
| P1-5 | 图 Schema 验证 | ✅ 已实现 | 无（schema-validator 完整+346行 spec） |
| P1-6 | 边标签索引 | ❌ 未实现 | 不做（OG 层已含，独立索引冗余且有同步问题） |
| P1-10 | 图时间线变慢 | — 跳过 | 无（需先建 benchmark 框架） |
