# MatchWhere1 修复计划

## 当前状态
- 5/15 passed ([2][3][4] + 2 个已知 pass)
- 10 failed

## 分层修复优先级

### Layer 1 — scanLabel 是变量名（【1】【5】【7】【8】【10】【11】【12】【13】）
`scanLabel = "a"`（变量名）被 `_fixScanLabel` 当成标签处理 → 找不到节点 → 0 行
- [x] ~~[7] `(n {name: 'A'})` 无标签，scanLabel=n 被当成标签~~ -> 变 ROWCNT
- 修复：`_fixScanLabel` 中检查 scanLabel 是否真的是标签（GE 中有这个标签/是所有节点的标签），否则设为 null 用 _scanAll

### Layer 2 — WHERE 标签谓词 `WHERE a:A`（【1】【5】）
`a:A` 在 WHERE 中不是属性过滤，是类型判断。filters 为空，所以 GE 不过滤。
- 修复：WHERE 中的标签谓词 —— 作为 filter 或 pre-filter，通过 _scanNodesByLabel 做 seed 预过滤

### Layer 3 — 无向边 `-[:ADMIN]-`（【1】【5】）
GE direction=any 只在 out 方向查，不反向兼容。
- 修复：direction=any 时扩展，或方向无关匹配。

### Layer 4 — 嵌套属性投影 `a.id` / `b.id`（【1】）
returnColumns = ["a.id", "b.id"]，_postProcessResults 需要能从节点 props 中提取嵌套值。
- 修复：_formatResultRow 中解析 a.id 为 returnColumns["a"]?.["id"]？实际上 a.id 是属性映射，最终格式化成字符串。

### Layer 5 — 边变量属性过滤（【8】）
`MATCH (a)-[r:KNOWS]->(b) WHERE r.name = 'foo'` — filter.source = "r"（边变量），
目前只有 source = 节点变量时才做预过滤，r 是边变量需忽略或在 edgesPayload 上做边属性过滤。

### Layer 6 — OR 连接（【10】）
GE 不支持 OR。需在 _executeViaGraphEngine 层分拆 OR 为独立查询合并。
