# MW2 Final Fix — STEP-GROUPS Minimal

## 方案

在 6e2674dd 的 `_executeViaGraphEngine` 中，当检测到 comma（`_ceComma`）时：

1. 找到逗号切点（source 不连续的第一个步索引）
2. 切分 steps 为 **mainSteps** (0..cutIndex-1) 和 **commaSteps** (cutIndex..end)
3. 对 mainSteps 做标准 walk（从所有节点出发，用 stepSourceFilters + labelFilter + scanLabel 过滤起点）
4. 对 commaSteps 做约束验证：从 main walk 产生的路径中提取 comma 步所需的起点变量，walk commaSteps，验证到达 boundedTarget
5. 跨组验证通过后，push 结果到 multiStepRaw

## 关键代码位置

- `query-executor.ts` line 818-830: `_ceComma` 检测
- `query-executor.ts` line 848-915: walkMultiSteps → boundedTargets 处理
- `query-executor.ts` line 922-930: geNode 构建 → allVars 填充

## MW2[1] 具体示例

- mainSteps[0..3]: a→b, b→c, c→d, d→a
- commaSteps[4]: a→d (ANTLR 生成)
- 从 B(1) 出发 main walk 3 步 → d 节点 → allVars 正确映射
- comma 约束: 从 d 出发（或从 b 出发）再 walk 1 步验证 b→d 连通
- boundedTargets: main walk 的 d 节点 (D(3) 和...)

等等，这个方案的问题是逗号步的 source='a' 在 ANTLR 中是 a，在链式匹配中 a 是 steps[3] 的 targetAlias。所以逗号步实际上是从 steps 中已知的某个节点出发的简短路。

正确：对于 `(b)--(d)`，逗号步的 source='b'，walk 1 步验证与 d 的连通性。但 ANTLR 把它解析为 source='a'——这是 ANTLR 的问题。

**更根本**：我们需在 AST 层修复 source 的识别。不过既然 Lambert 说只改 query-executor 和 query-parser，那我们在 executor 中做个精准启发式：

如果 comma 步的 source 是主链中已有的 targetAlias，就用那个 targetAlias 对应的节点；如果不是，就保持原样。

但 source='a' 在主链中也是 targetAlias（步 3 d→a），所以 a 对应 A(0)。如果 we walk commaStep (a→d) from A(0)，那就是验证 A→D = 应该返回 D(3)。这完全正确！

**最终方案**：

1. 当 comma 时，拆分 steps 为 groups
2. 主 group walk 作为 standard walk
3. 逗号 group 作为额外约束：对主 group 产生的每条路径，验证逗号步是否满足连通性
4. 只保留同时满足主 walk 和逗号约束的 boundedTargets
5. allVars 从主 group walk 的 matchingPath 填充（正确映射所有变量）
