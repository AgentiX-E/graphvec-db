"""
V2: Fix scope issue — compute _ceComma at IIFE level, before the for-loop.
"""
with open('src/query/query-executor.ts') as f:
    e = f.read()

# Find the IIFE start (right after 'let rawRecords: any[] = (useEdgeWalk)')
iife_start = e.find('let rawRecords: any[] = (useEdgeWalk)')
# Find 'const multiStepRaw: any[] = []' inside IIFE
msr = e.find('const multiStepRaw: any[] = []')
# Find where to insert _ceComma — after multiStepRaw init, before 'for (const i'
for_i = e.find('for (const i of useEdgeWalk', msr)

if iife_start < 0 or msr < 0 or for_i < 0:
    print('Anchors not found')
    exit(1)

ce_comma_code = """  // [COMMA] 检测逗号分隔 MATCH
  const _ceComma = plan.steps?.length > 1 && plan.steps.some(
    (s: any, si: number) => {
      if (si === 0) return false
      if (s.source !== plan.steps[si - 1].targetAlias) return true
      for (let pj = 0; pj < si; pj++)
        if (plan.steps[pj].targetAlias === s.targetAlias && s.targetAlias) return true
      return false
    }
  )
  """

# Insert _ceComma before 'for (const i'
e = e[:for_i] + ce_comma_code + e[for_i:]

print('[OK] _ceComma at IIFE level')

# === Fix B: boundedTarget guard ===
oldB = """              const lastStep = plan.steps[plan.steps.length - 1]
              if (lastStep && lastStep.targetAlias === effectiveRetVar) {
                boundedTargetIndices = [...pathEnds].filter(idx => interEnds.has(idx))
                // 同时筛选 boundedPaths
                boundedPaths = pathResults.filter(p => interEnds.has(p[p.length - 1]))
              } else {
                boundedTargetIndices = [...interEnds]
                boundedPaths = intermediate
              }"""

newB = """              const lastStep = plan.steps[plan.steps.length - 1]
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

if oldB in e:
    e = e.replace(oldB, newB)
    print('[OK] Fix B')
else:
    print('[FAIL] Fix B')

# === Fix C: comma expansion before return multiStepRaw ===
oldC = """          return multiStepRaw
        })()
      : multiTypeStep"""

newC = """          // [COMMA-EXPAND]: 逗号分隔 MATCH 独立步展开
          if (_ceComma && plan.steps) {
            const _ceExtras: any[] = []
            for (const geNode of multiStepRaw) {
              const _avars: Record<string, unknown> = geNode.props?._allVars || ({} as Record<string, unknown>)
              for (let si = 0; si < plan.steps.length; si++) {
                const cs = plan.steps[si]
                if (si === 0) continue
                const _isChain = cs.source === plan.steps[si - 1].targetAlias
                const _isReuse = plan.steps.slice(0, si).some(ps => ps.targetAlias === cs.targetAlias && cs.targetAlias)
                if (_isChain && !_isReuse) continue
                if (!cs.source || !cs.targetAlias) continue
                const _sVar = _avars[cs.source] as any
                if (!_sVar) continue
                let _sIdx = -1
                for (let ni = 0; ni < allNodes.length; ni++) {
                  const nn = allNodes[ni] as any
                  if (!nn) continue
                  if (nn._label === _sVar._label) { _sIdx = ni; break }
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
                  if (_clone.props?._allVars) _clone.props._allVars[_tVar] = _tVal
                  if (_clone.__crossVarRows) _clone.__crossVarRows[_tVar] = _tVal
                  if (_clone.props) _clone.props[_tVar] = _tVal
                  _ceExtras.push(_clone)
                }
              }
            }
            multiStepRaw.push(..._ceExtras)
          }
          return multiStepRaw
        })()
      : multiTypeStep"""

if oldC in e:
    e = e.replace(oldC, newC)
    print('[OK] Fix C')
else:
    print('[FAIL] Fix C')

with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
print('\nAll done')
