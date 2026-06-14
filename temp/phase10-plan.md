# Phase 10: CATALOG 多图命名空间 + DML async + 原生过程 + 基准

## 顺序
1. **CATALOG 多图命名空间** — CREATE/DROP DATABASE + SHOW DATABASES + USE
2. **DML async 全链路** — DELETE/SET/MERGE 持久化到 GE
3. **原生过程实现** — db.labels() 等函数调用
4. **性能基准套件** — 索引/遍历 benchmark

## 当前基线
- Git: 0495b0ee chore(phase9): C4 docfix + M1/M2 cleanup
- Tests: 708/708 vitest, 3878/3878 TCK
- USE 解析骨架已存在（type='USE', QueryPlan.type）
