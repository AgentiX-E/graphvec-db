# 下一轮攻击计划

## 当前全景（经过 String 26/32 修复后）
| 目录 | pass/total | 改方向 |
|------|-----------|--------|
| ✅ Precedence/Boolean/Literals/Conditional | 324/324 | — |
| **String** | **26/32** | 6 fail (2 String8[4]、[5]，2 String9，2 String10) |
| Map | 34/44 | 10 fail |
| Comparison | 48/72 | 24 fail |
| Null | 41/44 | 3 fail |
| List | 117/185 | 68 fail |
| Mathematical | 5/6 | 1 fail |
| Path | 2/7 | 5 fail |

## 策略优先序
Lambert 要求全部，我来确定最优路径。

### 优先级 1: Comparison（最快出成果）
Comparison 24 fail 中 20 是 GE ROWCNT。单变量无边 MATCH+WHERE 场景。
只需要让单变量 GE 路径处理过滤 + 正确 result 构建。
修复后 String 的 6 个 GE fail 可能也被修复（同为单变量 GE 路径问题）

### 优先级 2: String 6 fail
String 8/9/10 各剩 2 fail，[4] 空格 [5] 换行 —— 也是单变量 GE 路径问题。
如果 Comparison 修复同时修了 String，那又 +6。

### 优先级 3: Map 10 fail
更分散（参数化+GE+类型检查），不是单一根因。

### 优先级 4: List 68 fail
最大头，但 GE 状态污染（21）是独立根因，列表推导和 GE 全链路是另外两条。

## 具体执行

### Phase 1: 诊断 Comparison ROWCNT 根因
1. 看 Comparison 具体 fail 清单
2. 看单变量 GE 路径的 filteredRecords/filteredWithLabels 重建是否正确
3. 确认 `rawWithEdges` → `filteredWithLabels` 传递是否丢失信息

### Phase 2: 修复单变量 GE 路径过滤
- WHERE 后处理 fallback 已加但 String [4][5] 仍失败
- 根因可能是 `rwe.props` 在单变量 GE 路径中构造格式不对

### Phase 3: 全量回归
- vitest: 759/759 ✅
- TCK 目录全量扫描
- git commit
