# Expression TCK 非聚合失败修复计划

创建时间: 2026-08-31 22:46

## 目标
修复 expressions/ 目录下所有历史既有失败（非聚合范畴），达到全绿。

## 已知失败清单（需精确盘点）
- graph: 25 failed (36/61)
- quantifier: 44 failed (560/604)
- typeConversion: 26 failed (21/47)
- precedence: [22] ...
- existentialSubqueries / map / null / path / pattern / string 若干

## 步骤
- [ ] Step 1: 精确盘点所有 expression 失败场景（feature + scenario + 根因分类）
- [ ] Step 2: 按影响力排序（失败数多优先 + 根因相似聚合）
- [ ] Step 3: 逐个目录修复 + 单元测试（覆盖率 ≥95%）
- [ ] Step 4: 每目录验收（该目录 TCK 全绿 + 核心回归零退化）
- [ ] Step 5: Lambertyan 提交

## 当前进度
正在执行: Step 1
