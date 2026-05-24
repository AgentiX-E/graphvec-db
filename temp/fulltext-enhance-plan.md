# fulltext.ts 增强 — 执行计划

创建时间: 2026-05-23 11:00

## 目标
在 `fulltext.ts` 中增加字段权重、搜索高亮、拼写矫正功能，不破坏现有 API。

## 步骤

- [x] 步骤1: 阅读现有代码，确认现有 weights 已实现
- [x] 步骤2: 新增 `highlight()` 方法 — 搜索高亮，上下文窗口各20字符
- [x] 步骤3: 新增拼写矫正 — 搜索前 Levenshtein 编辑距离矫正，threshold=0.8
- [x] 步骤4: 新增测试 — 14个新测试（8 highlight + 6 spellCorrect），不修改现有29个测试
- [x] 步骤5: 验证 — 43/43 测试通过, tsc 零新增错误（仅保留 backup.ts 中 2 个遗留错误）

## 交付物
### `src/search/fulltext.ts` 新增
1. `highlight(query, options?)` — 返回 `{ docId, snippets: Record<field, string[]> }[]`
   - 支持精确匹配和模糊匹配两种模式
   - 上下文窗口各 20 字符，匹配词前后截取
   - 支持 field filtering、mode（AND/OR）
2. `spellCorrect(query, threshold?)` — 编辑距离拼写矫正，默认 threshold=0.8
3. `makeContextSnippet()` — 私有方法，基于字符位置生成上下文片段

### `src/search/fulltext.spec.ts` 新增
- 8 个 highlight 测试
- 6 个 spellCorrect 测试
- 不修改任何现有测试
