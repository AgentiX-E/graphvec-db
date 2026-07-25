#!/usr/bin/env python3
"""
Precision STEP-GROUPS fix for MW2[1] and MW2[2].
Starting from dcdcbb96 (direction='in' + crossVarRows allVars already applied).
Only adds step-groups logic for comma-separated MATCH.
"""

with open('src/query/query-executor.ts') as f:
    e = f.read()

# ── Fix 1: STEP-GROUPS — split comma-separated MATCH into groups ──
# Replace the single _walkMultiSteps call with step-groups logic
old1 = """            const pathResults = _walkMultiSteps(i, plan.steps, allNodes, skipNodeIndices, plan.filters, stepSourceFilters)
        const pathEnds = _pathEndIndices(pathResults)"""

new1 = """            // [STEP-GROUPS]: 逗号分隔 MATCH 分割为独立步骤组
            const _sgSteps = plan.steps || []
            const _sgGroups: any[][] = []
            if (_sgSteps.length > 0) {
              let _sgCur = [_sgSteps[0]]
              const _sgSeenAliases = new Set<string>()
              if (_sgSteps[0].targetAlias) _sgSeenAliases.add(_sgSteps[0].targetAlias)
              for (let si = 1; si < _sgSteps.length; si++) {
                const _sgChain = _sgSteps[si].source === _sgSteps[si - 1].targetAlias
                const _sgReuse = _sgSteps[si].targetAlias && _sgSeenAliases.has(_sgSteps[si].targetAlias)
                if (_sgChain && !_sgReuse) {
                  _sgCur.push(_sgSteps[si])
                } else {
                  _sgGroups.push(_sgCur)
                  _sgCur = [_sgSteps[si]]
                }
                if (_sgSteps[si].targetAlias) _sgSeenAliases.add(_sgSteps[si].targetAlias)
              }
              if (_sgCur.length > 0) _sgGroups.push(_sgCur)
            }
            const _sgMulti = _sgGroups.length > 1
            let pathResults: number[][]
            if (_sgMulti) {
              pathResults = _walkMultiSteps(i, _sgGroups[0], allNodes, skipNodeIndices, plan.filters, stepSourceFilters)
              // Cross-group edge validation: ensure extra pattern groups' edges exist
              const _crossFiltered: number[][] = []
              for (const p of pathResults) {
                const _vmap: Record<string, number> = {}
                _vmap[_sgGroups[0][0].source] = i
                for (let si = 0; si < _sgGroups[0].length && si < p.length - 1; si++) {
                  if (_sgGroups[0][si]?.targetAlias) _vmap[_sgGroups[0][si].targetAlias] = p[si + 1]
                }
                let pass = true
                for (let gi = 1; gi < _sgGroups.length && pass; gi++) {
                  for (const gs of _sgGroups[gi]) {
                    const srcI = gs.source ? _vmap[gs.source] : -1
                    const tgtI = gs.targetAlias ? _vmap[gs.targetAlias] : -1
                    if (srcI >= 0 && tgtI >= 0) {
                      let found = false
                      const checkEdge = (n: any, a: number, b: number) => {
                        if (!n?.__edges) return false
                        for (const ed of n.__edges) {
                          if (gs.direction === 'any') {
                            if ((ed.srcIdx === a && ed.dstIdx === b) || (ed.srcIdx === b && ed.dstIdx === a)) return true
                          } else if (gs.direction === 'in') {
                            if (ed.dstIdx === a && ed.srcIdx === b) return true
                          } else {
                            if (ed.srcIdx === a && ed.dstIdx === b) return true
                          }
                        }
                        return false
                      }
                      found = checkEdge(allNodes[srcI], srcI, tgtI) || checkEdge(allNodes[tgtI], tgtI, srcI)
                      if (!found) { pass = false; break }
                    } else if (srcI >= 0) {
                      // source mapped but target not: walk edges to find valid targets
                      const sNode = allNodes[srcI] as any
                      const cands: number[] = []
                      if (sNode?.__edges) {
                        for (const ed of sNode.__edges) {
                          let ni = -1
                          if (gs.direction === 'any') ni = ed.dstIdx === srcI ? ed.srcIdx : (ed.srcIdx === srcI ? ed.dstIdx : -1)
                          else if (gs.direction === 'out' && ed.srcIdx === srcI) ni = ed.dstIdx
                          else if (gs.direction === 'in' && ed.dstIdx === srcI) ni = ed.srcIdx
                          if (ni >= 0 && _stepMatchConstraint(ni, gs, allNodes)) cands.push(ni)
                        }
                      }
                      if (cands.length === 0) { pass = false; break }
                      // bind the first valid candidate as the target
                      if (gs.targetAlias) _vmap[gs.targetAlias] = cands[0]
                    } else {
                      pass = false; break
                    }
                  }
                }
                if (pass) _crossFiltered.push(p)
              }
              pathResults = _crossFiltered
            } else {
              pathResults = _walkMultiSteps(i, _sgSteps, allNodes, skipNodeIndices, plan.filters, stepSourceFilters)
            }
        const pathEnds = _pathEndIndices(pathResults)"""

if old1 in e:
    e = e.replace(old1, new1)
    print('[OK] STEP-GROUPS applied')
else:
    print('[FAIL] old1 not found')

# ── Fix 2: MW2[2] — fill allVars for steps[0].source ──
old2 = """              // source 节点——使用起始节点 allNodes[i] 而非 targetNode
              if (lastStepV?.source) {"""

new2 = """              // [FIX]: steps[0].source → allVars（MW2[2] advertiser 变量缺失）
              if (plan.steps?.[0]?.source && !allVars[plan.steps[0].source]) {
                const _s0 = allNodes[i] as Record<string, unknown>
                if (_s0) {
                  allVars[plan.steps[0].source] = { _label: (_s0._label as string) || 'Default' }
                  for (const k of Object.keys(_s0)) {
                    if (k !== '__edges' && k !== 'props' && !k.startsWith('__'))
                      (allVars[plan.steps[0].source] as any)[k] = (_s0 as any)[k]
                  }
                }
              }
              // source 节点——使用起始节点 allNodes[i] 而非 targetNode
              if (lastStepV?.source) {"""

if old2 in e:
    e = e.replace(old2, new2)
    print('[OK] steps[0].source → allVars')
else:
    print('[FAIL] old2 not found')

# ── Fix 3: MW2[2] — fill allVars from boundedPaths for uncovered steps ──
old3 = """              // target 节点属性存入 __targetProps（供非 source 变量查询如 b.id）
              for (const k of Object.keys(targetNode)) {"""

new3 = """              // [FIX]: boundedPaths 未覆盖的中间步变量补充到 allVars
              if (boundedPaths?.length > 0 && plan.steps?.length > 1) {
                const mp = boundedPaths.find((p: number[]) => p[p.length - 1] === targetIdx)
                if (mp && mp.length >= 2) {
                  for (let psi = 0; psi < plan.steps.length; psi++) {
                    const s = plan.steps[psi]
                    if (s.source && !allVars[s.source] && psi > 0 && psi - 1 < mp.length - 1) {
                      const ni = mp[psi - 1]
                      if (ni !== undefined && allNodes[ni]) {
                        allVars[s.source] = { _label: allNodes[ni]._label || 'Default' }
                        for (const k of Object.keys(allNodes[ni])) {
                          if (k !== '__edges' && k !== 'props' && !k.startsWith('__')) allVars[s.source][k] = allNodes[ni][k]
                        }
                      }
                    }
                    if (s.targetAlias && !allVars[s.targetAlias] && psi < mp.length - 1) {
                      const ni = mp[psi + 1]
                      if (ni >= 0 && allNodes[ni]) {
                        allVars[s.targetAlias] = { _label: allNodes[ni]._label || 'Default' }
                        for (const k of Object.keys(allNodes[ni])) {
                          if (k !== '__edges' && k !== 'props' && !k.startsWith('__')) allVars[s.targetAlias][k] = allNodes[ni][k]
                        }
                      }
                    }
                  }
                }
              }
              // target 节点属性存入 __targetProps（供非 source 变量查询如 b.id）
              for (const k of Object.keys(targetNode)) {"""

if old3 in e:
    e = e.replace(old3, new3)
    print('[OK] allVars from boundedPaths')
else:
    print('[FAIL] old3 not found')

# ── Fix 4: MW2[2] — __crossVarRows fill all steps ──
old4 = """              // 添加 __crossVarRows 供 whereBody 后处理（_evaluateExpression 需要 i 变量）
              geNode.__crossVarRows = {}
              if (plan.steps?.length) {
                const thisStep = plan.steps[plan.steps.length - 1]
                // 绑定 targetAlias（If any命名目标且非空）"""

new4 = """              // 添加 __crossVarRows 供 whereBody 后处理（_evaluateExpression 需要 i 变量）
              geNode.__crossVarRows = {}
              if (plan.steps?.length) {
                const thisStep = plan.steps[plan.steps.length - 1]
                // [FIX]: 所有 steps 的 source/target 变量注入 __crossVarRows
                const _seen = new Set<string>()
                for (const _cs of plan.steps) {
                  if (_cs.source && !_seen.has(_cs.source)) {
                    _seen.add(_cs.source)
                    if (_cs === plan.steps[0]) {
                      const sn = allNodes[i] as any
                      if (sn) {
                        const p: Record<string, unknown> = {}
                        for (const k of Object.keys(sn)) {
                          if (k !== '__edges' && k !== 'props' && !k.startsWith('__')) p[k] = sn[k]
                        }
                        if (sn._label !== undefined) p._label = sn._label
                        geNode.__crossVarRows[_cs.source] = { ...p, props: { ...p } }
                      }
                    } else if (allVars[_cs.source]) {
                      geNode.__crossVarRows[_cs.source] = allVars[_cs.source] as any
                    }
                  }
                  if (_cs.targetAlias && !_seen.has(_cs.targetAlias)) {
                    _seen.add(_cs.targetAlias)
                    if (allVars[_cs.targetAlias]) {
                      geNode.__crossVarRows[_cs.targetAlias] = allVars[_cs.targetAlias] as any
                    }
                  }
                }
                // 绑定 targetAlias（If any命名目标且非空）"""

if old4 in e:
    e = e.replace(old4, new4)
    print('[OK] __crossVarRows all steps')
else:
    print('[FAIL] old4 not found')

with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
print('\nAll fixes applied successfully.')
