"""
V3: Clean comma-step fix — properly derive comma step source from prior bindings.
"""
with open('src/query/query-executor.ts') as f:
    e = f.read()

# === Fix 1: _ceComma at IIFE level ===
old1 = """          const savedEdgeLabel = plan.steps?.[0]?.edgeLabel ?? null
          if (plan.steps?.[0]) plan.steps[0].edgeLabel = null
          for (let i = 0; i < allNodes.length; i++) {"""

new1 = """          const savedEdgeLabel = plan.steps?.[0]?.edgeLabel ?? null
          if (plan.steps?.[0]) plan.steps[0].edgeLabel = null
          // [COMMA] 逗号分隔 MATCH 检测
          const _ceComma = plan.steps?.length > 1 && plan.steps.some(
            (s: any, si: number) => {
              if (si === 0) return false
              if (s.source !== plan.steps[si - 1].targetAlias) return true
              for (let pj = 0; pj < si; pj++)
                if (plan.steps[pj].targetAlias === s.targetAlias && s.targetAlias) return true
              return false
            }
          )
          for (let i = 0; i < allNodes.length; i++) {"""

e = e.replace(old1, new1)

# === Fix 2: boundedTarget guard ===
old2 = """              const lastStep = plan.steps[plan.steps.length - 1]
              if (lastStep && lastStep.targetAlias === effectiveRetVar) {
                boundedTargetIndices = [...pathEnds].filter(idx => interEnds.has(idx))
                // 同时筛选 boundedPaths
                boundedPaths = pathResults.filter(p => interEnds.has(p[p.length - 1]))
              } else {
                boundedTargetIndices = [...interEnds]
                boundedPaths = intermediate
              }"""

new2 = """              const lastStep = plan.steps[plan.steps.length - 1]
              if (_ceComma) {
                boundedTargetIndices = [...interEnds]
                boundedPaths = intermediate
              } else if (lastStep && lastStep.targetAlias === effectiveRetVar) {
                boundedTargetIndices = [...pathEnds].filter(idx => interEnds.has(idx))
                boundedPaths = pathResults.filter(p => interEnds.has(p[p.length - 1]))
              } else {
                boundedTargetIndices = [...interEnds]
                boundedPaths = intermediate
              }"""

e = e.replace(old2, new2)

# === Fix 3: comma expansion ===
old3 = """          return multiStepRaw
        })()
      : multiTypeStep"""

# The comma expansion walks from ALL prior bound variables, not just cs.source
new3 = """          // [COMMA-EXPAND]: 逗号步独立 walk 展开
          if (_ceComma && plan.steps) {
            const _ceExtras: any[] = []
            for (const geNode of multiStepRaw) {
              const _avars: Record<string, unknown> = geNode.props?._allVars || {}
              for (let si = 0; si < plan.steps.length; si++) {
                const cs = plan.steps[si]
                if (si === 0) continue
                // 判断逗号步：source 不连续或 targetAlias 被复用
                const _isChain = cs.source === plan.steps[si - 1].targetAlias
                const _hadTargetBefore = plan.steps.slice(0, si).some(
                  (ps: any) => ps.targetAlias === cs.targetAlias && cs.targetAlias
                )
                if (_isChain && !_hadTargetBefore) continue
                if (!cs.targetAlias) continue
                // [COMMA-SRC-FIX]: ANTLR 给逗号步的 source 设为链式 source 而非真实变量。
                // 真实 source 变量是前面已 bound 的任意变量（targetAlias 或 source），
                // 这些变量在 _avars 中已绑定到节点。
                // 收集所有可能的 source 变量（前面步中 source 和 targetAlias 的全集）
                const _candidateSrcVars = new Set<string>()
                for (let pj = 0; pj < si; pj++) {
                  const ps = plan.steps[pj]
                  if (ps.source) _candidateSrcVars.add(ps.source)
                  if (ps.targetAlias) _candidateSrcVars.add(ps.targetAlias)
                }
                for (const _srcVar of _candidateSrcVars) {
                  const _sVar = (_avars as any)[_srcVar]
                  if (!_sVar) continue
                  // 找 source 变量对应的节点索引
                  let _sIdx = -1
                  for (let ni = 0; ni < allNodes.length; ni++) {
                    const nn = allNodes[ni] as any
                    if (!nn) continue
                    let _m = true
                    for (const k of Object.keys(_sVar)) {
                      if (k.startsWith('__') || k === 'props') continue
                      if (k === '_label' && nn._label !== _sVar._label) { _m = false; break }
                      if ((nn as any)[k] !== _sVar[k]) { _m = false; break }
                    }
                    if (_m) { _sIdx = ni; break }
                  }
                  if (_sIdx < 0) continue
                  // 从该 source 独立 walk 1 step
                  const _sNode = allNodes[_sIdx] as any
                  if (!_sNode?.__edges) continue
                  const _cands: number[] = []
                  for (const ed of _sNode.__edges) {
                    let tgt = -1
                    if (cs.direction === 'any')
                      tgt = ed.dstIdx === _sIdx ? ed.srcIdx : (ed.srcIdx === _sIdx ? ed.dstIdx : -1)
                    else if (cs.direction === 'in')
                      tgt = ed.dstIdx === _sIdx ? ed.srcIdx : -1
                    else
                      tgt = ed.srcIdx === _sIdx ? ed.dstIdx : -1
                    if (tgt >= 0 && tgt < allNodes.length && allNodes[tgt] && !_cands.includes(tgt))
                      _cands.push(tgt)
                  }
                  for (const _c of _cands) {
                    const _cn = allNodes[_c] as any
                    if (!_cn) continue
                    const _tVar = cs.targetAlias
                    const _tVal: Record<string, unknown> = { _label: _cn._label || 'Default' }
                    for (const k of Object.keys(_cn))
                      if (k !== '__edges' && k !== 'props' && !k.startsWith('__'))
                        _tVal[k] = (_cn as any)[k]
                    const _clone = JSON.parse(JSON.stringify(geNode))
                    if (_clone.props?._allVars) (_clone.props._allVars as any)[_tVar] = _tVal
                    if (_clone.__crossVarRows) (_clone.__crossVarRows as any)[_tVar] = _tVal
                    if (_clone.props) (_clone.props as any)[_tVar] = _tVal
                    _ceExtras.push(_clone)
                  }
                }
              }
            }
            multiStepRaw.push(..._ceExtras)
          }
          return multiStepRaw
        })()
      : multiTypeStep"""

e = e.replace(old3, new3)

with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
print('All 3 fixes applied')
