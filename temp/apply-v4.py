"""
V4: Precision comma-step expansion — extract real source var from query text.
"""
with open('src/query/query-executor.ts') as f:
    e = f.read()

# === Fix 1: _ceComma detection ===
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

# === Fix 3: comma expansion with text-based source extraction ===
old3 = """          return multiStepRaw
        })()
      : multiTypeStep"""

new3 = """          // [COMMA-EXPAND]: 逗号步独立 walk 展开。
          // 逗号步 (b)--(d) 的 source 是逗号分隔 MATCH 中逗号后的第一个变量。
          // ANTLR 给逗号步的 source 错误地赋值为链式延续值，我们直接从 query 文本提取。
          if (_ceComma && plan.steps && query) {
            const _ceExtras: any[] = []
            for (const geNode of multiStepRaw) {
              const _avars: Record<string, unknown> = geNode.props?._allVars as any || {}
              for (let si = 0; si < plan.steps.length; si++) {
                const cs = plan.steps[si]
                if (si === 0) continue
                const _isChain = cs.source === plan.steps[si - 1].targetAlias
                const _hadBefore = plan.steps.slice(0, si).some(
                  (ps: any) => ps.targetAlias === cs.targetAlias && cs.targetAlias
                )
                if (_isChain && !_hadBefore) continue
                if (!cs.targetAlias) continue
                // 从 query 文本中提取逗号步的真实 source 变量
                // 格式: ",  (srcVar)--(tgtVar)" 或类似
                const _escapedTgt = cs.targetAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&')
                const _cmRe = new RegExp(
                  `,\\\\s*\\\\(([a-zA-Z_]\\\\w*)\\\\)\\\\s*--\\\\s*\\\\(` + _escapedTgt + `\\\\)`, 'i'
                )
                const _cmMatch = query.match(_cmRe)
                const _srcVars: Set<string> = new Set()
                if (_cmMatch && _cmMatch[1]) {
                  _srcVars.add(_cmMatch[1])
                } else {
                  // 回退：从前面的步收集变量（排除 cs.source）
                  for (let pj = 0; pj < si; pj++) {
                    const ps = plan.steps[pj]
                    if (ps.source && ps.source !== cs.source) _srcVars.add(ps.source)
                    if (ps.targetAlias && ps.targetAlias !== cs.source) _srcVars.add(ps.targetAlias)
                  }
                }
                for (const _srcVar of _srcVars) {
                  const _sVar = (_avars as any)[_srcVar]
                  if (!_sVar) continue
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
print('V4 fixes applied')
