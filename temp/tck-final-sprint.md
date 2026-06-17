# TCK Final Sprint Plan

Base: master (4d45db63) — 122/122 vitest ✅

## Remaining Fails (21)

### Category 1: Pattern Comprehension (~16 fails)
- List6 [7-10]: multi-CREATE 后边创建未正确映射
- List11 (12 fails): 匿名节点匹配失败
- Sub-agent: pattern-comprehension-fix

### Category 2: avg precision (2 fails)
- Aggregation6: avg of decimals precision
- Sub-agent: avg-precision-fix

### Category 3: ANTLR adapter (3 fails)
- Comparison2 >= and >: plan.with = null when RETURN has = alias
- Sub-agent: antlr-comparison-fix

## Execution
All 3 sub-agents in parallel.
After all complete: full regression + commit + report.
