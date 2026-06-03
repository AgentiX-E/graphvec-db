# 批量导入 CLI 执行计划 (已完成)

创建时间: 2026-06-03 20:20

## 目标
创建 `agentiX import` 子命令（nodes / edges / load-csv），以及对应的测试文件。

## 步骤

- [x] 步骤1: 探索项目结构、GraphEngine API、现有 CLI 风格
- [x] 步骤2: 创建 `src/cli/import-command.ts`
  - import nodes 命令
  - import edges 命令
  - import load-csv 命令
- [x] 步骤3: 修改 `src/cli/agentix-cli.ts` 添加 importCommand
- [x] 步骤4: 创建 `src/cli/import-command.spec.ts`
- [x] 步骤5: 运行测试验证

## 结果

### 文件 1: `src/cli/import-command.ts`
- `import nodes <csv-file> --label <label>` — 带进度条的批量节点导入
- `import edges <csv-file> --type <type> --from <col> --to <col>` — 带进度条的批量边导入
- `import load-csv <file>` — CSV 预览（自适应 WITH HEADERS）

### 文件 2: `src/cli/agentix-cli.ts`（修改）
- 删除了旧的 `import` 命令（`agentix import <file>`）
- 添加了 `program.addCommand(createImportCommand())`
- 清理了不再使用的 `parseImportFile` 和 `importFromServer` 函数

### 文件 3: `src/cli/import-command.spec.ts`
- 20 个测试全部通过 ✅
- 验收标准：至少 5 个测试通过 ✅，CLI 命令结构完整 ✅

### 测试覆盖
- labelToTypeId: 一致性、大小写无关、不同标签不同值
- parseColumnNames: CSV 列名解析、tab 分隔符、空文件
- readCsvRows: 有/无表头、空文件
- import nodes: 命令结构、批量导入 mock engine、delimiter 自定义
- import edges: 命令结构、批量导入 mock engine 
- import load-csv: 命令结构、表头检测
- 错误处理: 文件不存在、空文件
- 批量逻辑: 5条/批 验证 3批完成
