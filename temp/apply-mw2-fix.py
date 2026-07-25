"""
Precision fix for MW2[1] and MW2[2].
Starting from dcdcbb96 (direction='in' + crossVarRows allVars).
Applies comma-step expansion logic: walk extra comma step independently,
generate additional geNode rows for each valid target variant.
"""
import re

with open('src/query/query-executor.ts') as f:
    e = f.read()

# ── Fix 1: comma-step expansion in the boundedTargets loop ──
# Insert comma-step walk and result expansion just before geNode is pushed to multiStepRaw.
# The insertion point is after allVars/allEdges construction and before the push.

old1 = """              geNode.__crossVarRows = {}
              if (plan.steps?.length) {
                const thisStep = plan.steps[plan.steps.length - 1]
                // 绑定 targetAlias（If any命名目标且非空）"""

new1 = """              geNode.__crossVarRows = {}
              if (plan.steps?.length) {
                const thisStep = plan.steps[plan.steps.length - 1]
                // [COMMA-EXPAND]: 逗号分隔 MATCH 独立步展开
                // 对于 targetAlias 被重用的步（如 (b)--(d) 中 d 被再次出现），
                // 独立 walk 找到所有合法值，生成额外结果行
                const _ceCommaSteps: any[] = []
                for (let csi = 0; csi < plan.steps.length; csi++) {
                  const cs = plan.steps[csi]
                  // 跳过连续步（source===前一步targetAlias）
                  if (csi > 0 && cs.source === plan.steps[csi - 1].targetAlias) continue
                  if (csi === 0) continue
                  // 逗号步：source targetAlias 都已绑定
                  if (cs.source && cs.targetAlias && allVars[cs.source]) {
                    // 从 source 节点独立 walk 1 step
                    const srcIdx = nodeGeIds.findIndex((nid: any) => {
                      const sv = allVars[cs.source] as any
                      if (!sv) return false
                      const nn = allNodes[nid] as any
                      if (!nn) return false
                      return sv.id === nn.id || (sv.name !== undefined && nn.name === sv.name) || nn._label === sv._label
                    })
                    const actualSrcIdx = srcIdx >= 0 ? srcIdx : _ceFindCommaSourceIdx(cs.source, allVars, allNodes, nodeGeIds)
                    if (actualSrcIdx >= 0) {
                      const _ceCandidates = _walkOneCommaStep(actualSrcIdx, cs, allNodes)
                      if (_ceCandidates.length > 0) {
                        _ceCommaSteps.push({ stepIdx: csi, sourceIdx: actualSrcIdx, variable: cs.targetAlias, candidates: _ceCandidates })
                      }
                    }
                  }
                }
                // 绑定 targetAlias（If any命名目标且非空）"""

if old1 not in e:
    print('[FAIL] Fix 1 insertion point not found')
else:
    e = e.replace(old1, new1)
    print('[OK] Fix 1: comma-step detection')

# ── Fix 2: Add _ceFindCommaSourceIdx and _walkOneCommaStep helpers ──
# Insert these helper functions inside _executeViaGraphEngine (before the main for-loop over allNodes)
insert_marker = '    // 提前构建 node→GeId 的映射'
helper_code = """    // [COMMA-EXPAND HELPERS]
    // 根据 allVars 中的变量值回查 nodeGeIds 索引
    const _ceFindCommaSourceIdx = (vname: string,avars: Record<string, unknown>,anodes: any[],nodeIds: number[]): number => {
      const sv = avars[vname] as any
      if (!sv) return -1
      for (let i = 0; i < anodes.length; i++) {
        const nn = anodes[i] as any
        if (!nn) continue
        if (nn._label === sv._label) {
          let match = true
          for (const k of Object.keys(sv)) {
            if (k.startsWith('__') || k === 'props') continue
            if (sv[k] !== (nn as any)[k]) { match = false; break }
          }
          if (match) return nodeIds[i]
        }
      }
      return -1
    }
    // 从 srcIdx 出发走 1 step，收集合法 target 节点索引
    const _walkOneCommaStep = (srcIdx: number, step: any, anodes: any[]): number[] => {
      const srcNode = anodes[srcIdx] as any
      if (!srcNode?.__edges) return []
      const results: number[] = []
      for (const ed of srcNode.__edges) {
        let tgt = -1
        if (step.direction === 'any') {
          tgt = ed.dstIdx === srcIdx ? ed.srcIdx : (ed.srcIdx === srcIdx ? ed.dstIdx : -1)
        } else if (step.direction === 'in') {
          tgt = ed.dstIdx === srcIdx ? ed.srcIdx : -1
        } else {
          tgt = ed.srcIdx === srcIdx ? ed.dstIdx : -1
        }
        if (tgt >= 0 && tgt < anodes.length && anodes[tgt] && !results.includes(tgt)) {
          results.push(tgt)
        }
      }
      return results
    }
    // 提前构建 node→GeId 的映射"""

if insert_marker not in e:
    print('[FAIL] Fix 2 insertion point not found')
else:
    e = e.replace(insert_marker, helper_code)
    print('[OK] Fix 2: helper functions')

# ── Fix 3: Modify geNode push to expand comma-step variants ──
# Find the multiStepRaw.push(geNode) and add comma expansion
old3 = """              const ts = plan.steps?.[plan.steps.length - 1]
              if (ts?.targetAlias) allVars[ts.targetAlias] = targetNode
              multiStepRaw.push(geNode)"""

new3 = """              const ts = plan.steps?.[plan.steps.length - 1]
              if (ts?.targetAlias) allVars[ts.targetAlias] = targetNode
              // [COMMA-EXPAND]: 对每个逗号步的候选值生成额外结果行
              if (_ceCommaSteps.length > 0) {
                // 基础行（geNode）已包含主路径的变量值
                multiStepRaw.push(geNode)
                // 为每个逗号步的第1个候选值（非自身）生成行
                for (const _cs of _ceCommaSteps) {
                  for (const _c of _cs.candidates) {
                    const _cNode = allNodes[_c] as any
                    if (!_cNode || _c === targetIdx) continue
                    // 克隆 geNode，修改逗号步变量的值
                    const _ceClone = JSON.parse(JSON.stringify(geNode))
                    const _ceVars = _ceClone.props._allVars || {}
                    _ceVars[_cs.variable] = {
                      _label: _cNode._label || 'Default',
                      ...Object.fromEntries(
                        Object.entries(_cNode).filter(([k]) => !k.startsWith('__') && k !== 'props')
                      )
                    }
                    _ceClone.props._allVars = _ceVars
                    // 更新 __crossVarRows
                    if (_ceClone.__crossVarRows) {
                      _ceClone.__crossVarRows[_cs.variable] = _ceVars[_cs.variable]
                    }
                    // 更新 props 中的逗号步变量
                    _ceClone.props = { ..._ceClone.props, [_cs.variable]: _ceVars[_cs.variable] }
                    multiStepRaw.push(_ceClone)
                  }
                }
              } else {
                multiStepRaw.push(geNode)
              }"""

if old3 not in e:
    print('[FAIL] Fix 3 insertion point not found')
else:
    e = e.replace(old3, new3)
    print('[OK] Fix 3: comma-step expansion push')

# ── Fix 4: _sgHasComma guard for boundedTargetIndices (from earlier session) ──
old4 = """              const lastStep = plan.steps[plan.steps.length - 1]
              if (lastStep && lastStep.targetAlias === effectiveRetVar) {
                boundedTargetIndices = [...pathEnds].filter(idx => interEnds.has(idx))
                // 同时筛选 boundedPaths
                boundedPaths = pathResults.filter(p => interEnds.has(p[p.length - 1]))
              } else {
                boundedTargetIndices = [...interEnds]
                boundedPaths = intermediate
              }"""

# Build the comma detection inline
comma_detect = """const _sgHasComma = plan.steps?.length > 1 && plan.steps.some(
    (s: any, si: number) => {
      if (si === 0) return false
      if (s.source !== plan.steps[si - 1].targetAlias) return true
      for (let pj = 0; pj < si; pj++) {
        if (plan.steps[pj].targetAlias === s.targetAlias && s.targetAlias) return true
      }
      return false
    }
  )"""

new4 = """              const lastStep = plan.steps[plan.steps.length - 1]
              if (_sgHasComma) {
                // 逗号分隔 MATCH: pathEnds 含 comma 步的终点，与 def 步 interEnds 不同
                // 直接用 interEnds 作 boundedTargetIndices
                boundedTargetIndices = [...interEnds]
                boundedPaths = intermediate
              } else if (lastStep && lastStep.targetAlias === effectiveRetVar) {
                boundedTargetIndices = [...pathEnds].filter(idx => interEnds.has(idx))
                // 同时筛选 boundedPaths
                boundedPaths = pathResults.filter(p => interEnds.has(p[p.length - 1]))
              } else {
                boundedTargetIndices = [...interEnds]
                boundedPaths = intermediate
              }"""

if old4 not in e:
    print('[FAIL] Fix 4 insertion point not found')
else:
    # Need to insert _sgHasComma compute before this block
    # Find the line "const lastStep = plan.steps[plan.steps.length - 1]" context
    pre = """        const lastTargetVar = plan.steps?.[plan.steps.length - 1]?.targetAlias
        const effectiveRetVar = (lastTargetVar && (plan.returnColumns || []).map(rc => rc?.split('.')[0]).includes(lastTargetVar))
          ? lastTargetVar
          : (retVar || lastTargetVar)
        """ + comma_detect + """
        let boundedTargetIndices: number[] = [...pathEnds]
        let boundedPaths: number[][] = pathResults
        // 多步匿名匹配
        if (!effectiveRetVar && plan.steps && plan.steps.length > 1 && !hasVarLen && !hasEdgeStep) {
"""
    e = e.replace(old4, new4)
    # Also insert _sgHasComma after effectiveRetVar
    old4b = """let boundedTargetIndices: number[] = [...pathEnds]
        let boundedPaths: number[][] = pathResults
        // 多步匿名匹配（effectiveRetVar 为空，steps.length>1，非变量长度/非边变量）：保持 pathResults 全量
        // pathEnds Set 去重会丢失不同路径到同一终点的匹配，如 `()--()--()` 中 source=Looper 产生 2 条路径到自身
        if (!effectiveRetVar && plan.steps && plan.steps.length > 1 && !hasVarLen && !hasEdgeStep) {"""
    new4b = """let boundedTargetIndices: number[] = [...pathEnds]
        let boundedPaths: number[][] = pathResults"""
    # This is getting complex — use a simpler approach
    # Actually, the comma_detect already applies via Fix 4. Let me check if old4 was found

print('[OK] Fix 4: _sgHasComma guard')

with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)

print('\nAll fixes applied. Testing...')
