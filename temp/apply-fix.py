"""
Apply comma-step expansion fix to query-executor.ts.
Clean approach: insert expansion logic just before 'return multiStepRaw'.
"""
with open('src/query/query-executor.ts') as f:
    e = f.read()

# ==== Fix A: _sgHasComma detection ====
# Insert before boundedTargetIndices computation
oldA = """        const lastTargetVar = plan.steps?.[plan.steps.length - 1]?.targetAlias
        const effectiveRetVar = (lastTargetVar && (plan.returnColumns || []).map(rc => rc?.split('.')[0]).includes(lastTargetVar))
          ? lastTargetVar
          : (retVar || lastTargetVar)
        let boundedTargetIndices: number[] = [...pathEnds]"""

newA = """        const lastTargetVar = plan.steps?.[plan.steps.length - 1]?.targetAlias
        const effectiveRetVar = (lastTargetVar && (plan.returnColumns || []).map(rc => rc?.split('.')[0]).includes(lastTargetVar))
          ? lastTargetVar
          : (retVar || lastTargetVar)
        // [COMMA] 检测逗号分隔 MATCH: source 不连续或 targetAlias 重用
        const _ceComma = plan.steps?.length > 1 && plan.steps.some(
          (s: any, si: number) => {
            if (si === 0) return false
            if (s.source !== plan.steps[si - 1].targetAlias) return true
            for (let pj = 0; pj < si; pj++)
              if (plan.steps[pj].targetAlias === s.targetAlias && s.targetAlias) return true
            return false
          }
        )
        let boundedTargetIndices: number[] = [...pathEnds]"""

if oldA in e:
    e = e.replace(oldA, newA)
    print('[OK] Fix A: _ceComma detection')
else:
    print('[FAIL] Fix A')

# ==== Fix B: _ceComma guard for boundedTargetIndices ====
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
    print('[OK] Fix B: _ceComma boundedTarget guard')
else:
    print('[FAIL] Fix B')

# ==== Fix C: comma-step expansion before return multiStepRaw ====
# Insert expansion logic just before 'return multiStepRaw' in the IIFE
oldC = """          return multiStepRaw
        })()
      : multiTypeStep"""

newC = """          // [COMMA-EXPAND]: 逗号分隔 MATCH 独立步展开
          // 对 _ceComma 为 true 的查询，在 multiStepRaw 后面追加来自逗号步独立 walk 的新行
          if (_ceComma && plan.steps) {
            const _ceExtras: any[] = []
            for (const geNode of multiStepRaw) {
              const _avars = geNode.props?._allVars || {}
              // 找出逗号步（source 不连续或 targetAlias 重用）
              for (let si = 0; si < plan.steps.length; si++) {
                const cs = plan.steps[si]
                if (si === 0) continue
                // 判断是否为逗号步
                const _isChain = cs.source === plan.steps[si - 1].targetAlias
                const _isReuse = plan.steps.slice(0, si).some(ps => ps.targetAlias === cs.targetAlias && cs.targetAlias)
                if (_isChain && !_isReuse) continue
                if (!cs.source || !cs.targetAlias) continue
                const _sVar = _avars[cs.source]
                if (!_sVar) continue
                // 在 allNodes 中找 source 节点索引
                let _sIdx = -1
                for (let ni = 0; ni < allNodes.length; ni++) {
                  const nn = allNodes[ni] as any
                  if (!nn) continue
                  if (nn._label === (_sVar as any)._label) {
                    _sIdx = ni
                    break
                  }
                }
                if (_sIdx < 0) continue
                // 从 _sIdx 独立 walk 1 step，收集候选 target
                const _sNode = allNodes[_sIdx] as any
                if (!_sNode?.__edges) continue
                const _cands: number[] = []
                for (const ed of _sNode.__edges) {
                  let tgt = -1
                  if (cs.direction === 'any') {
                    tgt = ed.dstIdx === _sIdx ? ed.srcIdx : (ed.srcIdx === _sIdx ? ed.dstIdx : -1)
                  } else if (cs.direction === 'in') {
                    tgt = ed.dstIdx === _sIdx ? ed.srcIdx : -1
                  } else {
                    tgt = ed.srcIdx === _sIdx ? ed.dstIdx : -1
                  }
                  if (tgt >= 0 && tgt < allNodes.length && allNodes[tgt] && !_cands.includes(tgt)) {
                    _cands.push(tgt)
                  }
                }
                // 生成 variant 行
                for (const _c of _cands) {
                  const _cn = allNodes[_c] as any
                  if (!_cn) continue
                  const _tVar = cs.targetAlias
                  const _tVal: Record<string, unknown> = { _label: _cn._label || 'Default' }
                  for (const k of Object.keys(_cn)) {
                    if (k !== '__edges' && k !== 'props' && !k.startsWith('__')) _tVal[k] = (_cn as any)[k]
                  }
                  // 克隆 geNode，替换逗号步变量
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
    print('[OK] Fix C: comma expansion')
else:
    print('[FAIL] Fix C')

with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
print('\nDone')
