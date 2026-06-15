# P1: SKIP/LIMIT Pushdown

目标：`_postProcessResults` 末尾应用 `plan.skip`/`plan.limit`。
文件：`src/query/query-engine.ts`（只改 `_postProcessResults` 函数）
验证：TCK RETURN-SKIP-LIMIT 3/3 通过（真正截断验证），无退化
