# TCK 测试套件实现计划

创建时间: 2026-06-04 11:58
完成时间: 2026-06-04 12:02

## 目标
在 `src/query/cypher-tck/` 下创建完整的 openCypher TCK 兼容性测试套件。

## 步骤

- [x] Step 1: 分析现有项目结构和测试模式
- [x] Step 2: 创建 cypher-tck 目录
- [x] Step 3: 编写 tck-adapter.ts — TCK 适配器
- [x] Step 4: 编写 tck-parser.ts — Gherkin .feature 文件解析器
- [x] Step 5: 编写 tck-runner.ts — TCK 场景执行引擎
- [x] Step 6: 编写 openCypher-tck.spec.ts — 56 个 TCK 标准测试
- [x] Step 7: 运行验证 ✅ 56/56 通过

## 结果
- 实现 56 个 TCK 测试，全部通过
- 覆盖 MATCH (10), WHERE (8), RETURN (8), DML (10), WITH (6), OPTIONAL MATCH (4), UNION (4), 扩展 (6)
- 已知差异已记录在测试注释中
