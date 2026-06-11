# Phase 3: ANTLR → TCK 适配计划

## 目标
在 `_executeQuery` 中无缝替换 PEG parser 为 ANTLR parser，通过全部 TCK 1016 个测试。

## 策略

### 方案 A（推荐）：一层透明的 Parser 开关
在 `cypher-lite-parser.ts` 中增加 ANTLR 解析模式。
只有当 ANTLR 失败时才 fallback 到 PEG。
这样可以逐步迁移：ANTLR 负责新查询，PEG 兜底旧查询。

### 方案 B（激进）：直接替换
用 `parseQueryAntlr` 替换所有 `parseQuery` 引用。
需要一次过 1016 TCK，风险较高。

## Phase 3 子步骤

### Step 3.1: Parser 桥接层
- [ ] 在 `cypher-lite-parser.ts` 添加 `parseCypherAntlr()` 函数
- [ ] 支持 fallback: PEG 在 ANTLR 失败时

### Step 3.2: 缺失的 AST 功能补齐
- [x] MATCH + RETURN + WHERE (单条件)
- [ ] AND/OR 组合 WHERE
- [ ] OPTIONAL MATCH
- [ ] 多 MATCH（逗号分隔）
- [ ] CREATE (a)-[:REL]->(b) 带边
- [ ] SET n.prop = val
- [ ] REMOVE n:Label
- [ ] SHOW / INDEX / CONSTRAINT
- [ ] subqueries (CALL { ... })
- [ ] EXISTS { ... }

### Step 3.3: TCK 子集验证
- [ ] 取 100 个 TCK query，ANTLR parse + _executeQuery 运行
- [ ] 对比 PEG + _executeQuery 结果
- [ ] 统计通过率

### Step 3.4: 迭代补齐
逐批补齐缺失语法，直到 TCK 全部通过。

### Step 3.5: 最终替换
PEG → ANTLR 全量替换，删除 PEG 文件。
