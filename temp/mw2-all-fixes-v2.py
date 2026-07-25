#!/usr/bin/env python3
"""
Apply all MW2 fixes to agentiX-graphvec
Fix 1: direction='in' reverse edge walk (query-parser.ts)
Fix 2: __crossVarRows allVars injection (query-executor.ts)
Fix 3: multiDef retVar unionEnds + mergedPaths (query-executor.ts)
Fix 4: _executeViaGraphEngine 返回 QueryResult 而非 raw 数组（query-executor.ts）
"""

with open('src/query/query-parser.ts') as f:
    p = f.read()

with open('src/query/query-executor.ts') as f:
    e = f.read()

# Fix 1: direction='in' reverse edge walk
old1 = "      // 无向边：其他节点到当前节点的反向边\n      if (isAny) {"
new1 = """      // [FIX]: direction='in' 反向边遍历 — 查找其他节点中指向当前 idx 的边
      if (step.direction === 'in') {
        for (let j = 0; j < allNodes.length; j++) {
          if (j === idx) continue
          const other = allNodes[j] as any
          if (other.__edges) {
            for (const e of other.__edges) {
              if (e.dstIdx === idx) {
                if (step.edgeLabel) {
                  const targetLabels = step.edgeLabel.split('|')
                  if (!targetLabels.includes(e.label)) continue
                }
                const neighborIdx = e.srcIdx
                if (!nextSet.has(neighborIdx) && _stepMatchConstraint(neighborIdx, step, allNodes)) {
                  nextSet.add(neighborIdx)
                }
              }
            }
          }
        }
      }
      // 无向边：其他节点到当前节点的反向边
      if (isAny) {"""
if old1 in p:
    p = p.replace(old1, new1)
    print('[FIX 1] direction=in reverse edge walk applied')
else:
    print('[FIX 1] already applied (skip)')

# Fix 2: allVars → __crossVarRows
old2 = """                }\n                // Pattern Comprehension 适配：当 targetAlias 为空（匿名目标）且 RETURN 列是 source 变量时，"""
new2 = """                }
                // [FIX]: allVars → __crossVarRows 全量注入
                if (allVars) {
                  for (const [vn, vdata] of Object.entries(allVars as Record<string, unknown>)) {
                    if (geNode.__crossVarRows[vn]) continue
                    const vObj = vdata as Record<string, unknown>
                    const cvrEntry: Record<string, unknown> = {}
                    for (const k of Object.keys(vObj)) {
                      if (k !== '__edges' && k !== 'props' && !k.startsWith('__')) cvrEntry[k] = vObj[k]
                    }
                    if (vObj._label !== undefined) cvrEntry._label = vObj._label
                    geNode.__crossVarRows[vn] = { ...cvrEntry, props: { ...cvrEntry } }
                  }
                }
                // Pattern Comprehension 适配：当 targetAlias 为空（匿名目标）且 RETURN 列是 source 变量时，"""
if old2 in e:
    e = e.replace(old2, new2)
    print('[FIX 2] crossVarRows allVars injection applied')
else:
    print('[FIX 2] already applied (skip)')

# Fix 3a: multiDef retVar — find all def indices
old3 = "          const defStep = plan.steps.find(s => s.targetAlias === effectiveRetVar)"
new3 = """          // [FIX]: 逗号分隔 MATCH 中同一变量可能被多个 step 定义
          // 收集所有定义 effectiveRetVar 的 step 索引
          const retVarDefIndices: number[] = plan.steps
            .map((s: any, si: number) => s.targetAlias === effectiveRetVar ? si : -1)
            .filter((si: number) => si >= 0)
          const defStep = plan.steps.find(s => s.targetAlias === effectiveRetVar)"""
if old3 in e:
    e = e.replace(old3, new3)
    print('[FIX 3a] multiDef indices collection applied')
else:
    print('[FIX 3a] already applied (skip)')

# Fix 3b: unionEnds for multiDef retVar
old4 = """              const lastStep = plan.steps[plan.steps.length - 1]
              if (lastStep && lastStep.targetAlias === effectiveRetVar) {
                boundedTargetIndices = [...pathEnds].filter(idx => interEnds.has(idx))
                // 同时筛选 boundedPaths
                boundedPaths = pathResults.filter(p => interEnds.has(p[p.length - 1]))
              } else {
                boundedTargetIndices = [...interEnds]
                boundedPaths = intermediate
              }"""
new4 = """              const lastStep = plan.steps[plan.steps.length - 1]
              // [FIX]: retVar 有多个定义步 → 用所有 def step 的 intermediate paths
              // 避免 full-path pathEnds 过滤掉中间定义步的值
              if (retVarDefIndices && retVarDefIndices.length > 1) {
                // 收集所有定义步 intermediate 的终点并集
                boundedTargetIndices = [...interEnds]
                const allDefIntermediates: number[][] = []
                for (const dsi of retVarDefIndices) {
                  const dsiInter = _walkMultiSteps(
                    i, plan.steps.slice(0, dsi + 1),
                    allNodes, undefined, plan.filters, stepSourceFilters
                  )
                  for (const p of dsiInter) {
                    const end = p[p.length - 1]
                    if (!boundedTargetIndices.includes(end)) boundedTargetIndices.push(end)
                    allDefIntermediates.push(p)
                  }
                }
                // 用所有 intermediates 的路径作为 boundedPaths
                boundedPaths = allDefIntermediates
              } else if (lastStep && lastStep.targetAlias === effectiveRetVar) {
                boundedTargetIndices = [...pathEnds].filter(idx => interEnds.has(idx))
                // 同时筛选 boundedPaths
                boundedPaths = pathResults.filter(p => interEnds.has(p[p.length - 1]))
              } else {
                boundedTargetIndices = [...interEnds]
                boundedPaths = intermediate
              }"""
if old4 in e:
    e = e.replace(old4, new4)
    print('[FIX 3b] multiDef unionEnds+mergedPaths applied')
else:
    print('[FIX 3b] already applied (skip)')

# Fix 4: wrap evgeReturn into QueryResult
old5 = "    const evgeReturn = _postProcessResults(result, plan)\n    return evgeReturn"
new5 = """    const evgeReturn = _postProcessResults(result, plan)
    // [FIX]: 确保返回值符合 QueryResult { rows, rowCount } 格式
    if (Array.isArray(evgeReturn)) {
      return { rows: evgeReturn, rowCount: evgeReturn.length }
    }
    return { rows: evgeReturn?.rows ?? evgeReturn, rowCount: evgeReturn?.rowCount ?? (Array.isArray(evgeReturn) ? evgeReturn.length : 0) }"""
if old5 in e:
    e = e.replace(old5, new5)
    print('[FIX 4] QueryResult wrap applied')
else:
    print('[FIX 4] already applied (skip)')

with open('src/query/query-parser.ts', 'w') as f:
    f.write(p)
with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)

print('\nAll fixes applied.')
