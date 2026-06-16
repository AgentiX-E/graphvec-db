# TCK Expression 目录进展（2026-06-16 14:50）

| 目录 | 进度 | 状态 |
|------|------|------|
| Precedence | 30/30 | ✅ 100% |
| Boolean | 150/150 | ✅ 100% |
| Literals | 131/131 | ✅ 100% |
| String | 16/32 | ⏳ 50% (16 fail: GE WHERE 路径) |
| Conditional | 13/13 | ✅ 100% |
| Mathematical | 5/6 | ✅ 83% (1 fail: GE 全链路) |
| Null | 42/44 | ✅ 95% (2 fail: OPTIONAL MATCH 路径) |
| Comparison | 48/72 | ⏳ 67% (24 fail: GE 全链路问题) |

## 当前 Git
- HEAD: `d7f64391` feat: Null TCK 42/44

## 规则（绝对遵守）
1. 所有 vitest 回归由 sub-agent 跑，不等
2. 写代码 → cucumber 快测 → git commit → sub-agent 回归 → 推下一个目录
3. 回复不超过 15 行
4. 不要同步等 vitest
