# V24 综合路线

## 目标：Cypher 语言全覆盖 + 图数据库核心 + 性能 + Ops 全面推进

### 执行原则
- 按依赖顺序推进，不依赖的并行
- 每项附带测试，全量回归通过才合并
- 不做虚假闭包

## 路线图

### Sprint 1: Cypher 语言广度覆盖

| 特性 | 工作量 | 说明 |
|------|:------:|------|
| **列表操作** | 1 天 | `[1,2,3]` 字面量 + 下标 `list[0]` + 范围 `list[1..3]` + `+`|
| **字符串拼接 `+`** | 0.5 天 | 表达式层字符串串联 |
| **FOREACH 完全体** | 1 天 | 嵌套 FOREACH + 多语句体 + 列表聚合 |
| **标签表达式** | 1 天 | `:Person|Animal` union + `:!Person` 排除 |
| **节点模式增强** | 1 天 | `(n)` 基本存在的测试覆盖 |

### Sprint 2: 图数据库核心

| 特性 | 工作量 | 说明 |
|------|:------:|------|
| **多图命名空间** | 2 天 | `USE graph_name` + catalog |
| **IN 操作符** | 1 天 | `WHERE n.age IN [20,30,40]` |
| **STARTS WITH/CONTAINS/ENDS WITH** | 1 天 | 字符串模式匹配 |
| **NOT 否定** | 1 天 | `WHERE NOT n.name = 'Alice'` |

### Sprint 3: 性能与深度

| 特性 | 工作量 | 说明 |
|------|:------:|------|
| **变长路径性能** | 2 天 | 现有 var-length-path 的性能回归 + 大图边界测试 |
| **ORDER BY 多列** | 1 天 | `ORDER BY n.age DESC, n.name ASC`（已部分支持但测试不足）|
| **HNSW 参数调优** | 1 天 | 向量索引的 efConstruction / M 参数暴露 |

### Sprint 4: Ops 运维

| 特性 | 工作量 | 说明 |
|------|:------:|------|
| **REST API 错误码标准化** | 1 天 | 统一错误响应格式 |
| **资源配额 (ResourceQuota)** | 2 天 | per-connection mem/req limit |
| **指标导出 (Prometheus)** | 1 天 | `/metrics` 端点 |
