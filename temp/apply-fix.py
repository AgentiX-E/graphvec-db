#!/usr/bin/env python3
"""Apply MW2 final fix to query-executor.ts — no debug code, clean implementation."""
import re

with open('src/query/query-executor.ts', 'r') as f:
    code = f.read()

# === Fix 1: scanLabel case-insensitive filtering ===
old1 = """            // 根据 scanLabel 过滤起始节点（支持多标签 __fullLabel）
            if (plan.scanLabel) {
              const node = allNodes[i]
              const nodeLabel = String(node?.['_label'] || '')
              const fullLabel = node?.__fullLabel
              if (fullLabel && typeof fullLabel === 'string') {
                if (!fullLabel.split(':').includes(plan.scanLabel)) continue
              } else if (nodeLabel !== plan.scanLabel) {
                continue
              }"""

new1 = """            // scanLabel filter: case-insensitive (ANTLR falls back to variable name, e.g. 'a' vs 'A')
            if (plan.scanLabel) {
              const node = allNodes[i]
              const nodeLabel = String(node?.['_label'] || '')
              const fullLabel = node?.__fullLabel
              const sll = plan.scanLabel.toLowerCase()
              if (fullLabel && typeof fullLabel === 'string') {
                if (!fullLabel.split(':').some((l: string) => l.toLowerCase() === sll)) continue
              } else if (nodeLabel.toLowerCase() !== sll) {
                continue
              }"""

assert old1 in code, "Fix 1: old text not found"
code = code.replace(old1, new1)

# === Fix 2: _ceComma detection with commaCutIdx ===
old2 = """          const _ceComma = plan.steps?.length > 1 && plan.steps.some(
            (s: any, si: number) => {
              if (si === 0) return false
              if (s.source !== plan.steps[si - 1].targetAlias) return true
              for (let pj = 0; pj < si; pj++)
                if (plan.steps[pj].targetAlias === s.targetAlias && s.targetAlias) return true
              return false
            }
          )"""

new2 = """          let _ceComma = false
          let commaCutIdx = 0
          if (plan.steps?.length && plan.steps.length > 1) {
            for (let si = 1; si < plan.steps.length; si++) {
              const s = plan.steps[si]
              if (s.source !== plan.steps[si - 1].targetAlias) { _ceComma = true; commaCutIdx = si; break }
              let reused = false
              for (let pj = 0; pj < si; pj++) {
                if (plan.steps[pj].targetAlias === s.targetAlias && s.targetAlias) {
                  reused = true; break
                }
              }
              if (reused) { _ceComma = true; commaCutIdx = si; break }
            }
          }"""

assert old2 in code, "Fix 2: old text not found"
code = code.replace(old2, new2)

# === Fix 3: STEP-GROUPS comma handling (replace _ceComma block) ===
old3 = """              if (_ceComma) {
                boundedTargetIndices = [...interEnds]
                boundedPaths = intermediate
              } else if (lastStep && lastStep.targetAlias === effectiveRetVar) {"""

new3 = """              if (_ceComma) {
                // ── Comma-separated MATCH: split mainSteps + commaSteps, cross-group verify ──
                const mainSteps = plan.steps!.slice(0, commaCutIdx)
                const commaSteps = plan.steps!.slice(commaCutIdx)
                // Walk main steps from i, up to the defStep for effectiveRetVar
                const mainDefStep = mainSteps.find(s => s.targetAlias === effectiveRetVar)
                const mainWalk = mainDefStep !== undefined
                  ? _walkMultiSteps(i, mainSteps.slice(0, mainSteps.indexOf(mainDefStep) + 1), allNodes, undefined, plan.filters, stepSourceFilters)
                  : _walkMultiSteps(i, mainSteps, allNodes, undefined, plan.filters, stepSourceFilters)
                const mainEnds = _pathEndIndices(mainWalk)
                // Comma constraint: for each mainPath, walk commaSteps verifying connectivity
                const validTargets = new Set<number>()
                const validPaths: number[][] = []
                for (const mainPath of mainWalk) {
                  const mainEnd = mainPath[mainPath.length - 1]
                  // Build pathVars from mainSteps for comma-step source variable resolution
                  const pathVars: Record<string, number> = {}
                  for (let psi = 0; psi < mainSteps.length && psi < mainPath.length - 1; psi++) {
                    const step = mainSteps[psi]
                    if (step.source) pathVars[step.source] = mainPath[psi]
                    if (step.targetAlias && mainPath[psi + 1] !== undefined)
                      pathVars[step.targetAlias] = mainPath[psi + 1]
                  }
                  // Execute comma constraint walk
                  let passesComma = true
                  let currentIdx = mainEnd
                  const fullCommaPath = [...mainPath]
                  for (const cs of commaSteps) {
                    const csStartIdx = (cs.source && pathVars[cs.source] !== undefined)
                      ? pathVars[cs.source]
                      : currentIdx
                    const csWalk = _walkMultiSteps(csStartIdx, [cs], allNodes, undefined, plan.filters, stepSourceFilters)
                    if (csWalk.length === 0) { passesComma = false; break }
                    currentIdx = csWalk[0][csWalk[0].length - 1]
                    fullCommaPath.push(currentIdx)
                  }
                  if (passesComma) {
                    validTargets.add(mainEnd)
                    validPaths.push(fullCommaPath)
                  }
                }
                boundedTargetIndices = [...validTargets]
                boundedPaths = validPaths.length > 0 ? validPaths : mainWalk
              } else if (lastStep && lastStep.targetAlias === effectiveRetVar) {"""

assert old3 in code, "Fix 3: old text not found"
code = code.replace(old3, new3)

# === Fix 4: allVars fill from matchingPath (effSteps-aware) ===
old4 = """              // 构建所有步骤变量的节点数据（存于 props._allVars 以避免属性丢失）
              const allVars: Record<string, unknown> = geNode.props._allVars as Record<string, unknown>
              const lastStepV = plan.steps?.[plan.steps.length - 1]
              if (lastStepV?.targetAlias) {
                allVars[lastStepV.targetAlias] = { _label: targetNode._label || 'Default' }
                for (const k of Object.keys(targetNode)) {
                  if (k !== '__edges' && k !== 'props' && !k.startsWith('__')) allVars[lastStepV.targetAlias][k] = targetNode[k]
                }
              }
              // 用 boundedPaths 补充中间节点和边标签Info
              if (boundedPaths?.length > 0) {
                const matchingPath = boundedPaths.find(p => p[p.length - 1] === targetIdx)
                if (matchingPath && matchingPath.length >= 2) {
                  const pathEdges: string[] = []
                  for (let psi = 0; psi < plan.steps.length && psi < matchingPath.length - 1; psi++) {
                    const step = plan.steps[psi]
                    const fromNode = allNodes[matchingPath[psi]] as any
                    if (fromNode?.__edges) {
                      const edge = fromNode.__edges.find((e: any) => {
                        const neighborIdx = e.dstIdx === matchingPath[psi] ? e.srcIdx : (e.srcIdx === matchingPath[psi] ? e.dstIdx : -1)
                        return neighborIdx === matchingPath[psi + 1]
                      })
                      if (edge?.label) pathEdges.push(edge.label)
                    }
                    // 中间节点：填充 _allVars 中对应步骤的 targetAlias
                    if (psi < plan.steps.length - 1 && matchingPath[psi + 1] !== targetIdx) {
                      const midNode = allNodes[matchingPath[psi + 1]]
                      const midAlias = plan.steps[psi]?.targetAlias
                      if (midAlias && midNode) {
                        allVars[midAlias] = { _label: midNode._label || 'Default' }
                        for (const k of Object.keys(midNode)) {
                          if (k !== '__edges' && k !== 'props' && !k.startsWith('__')) allVars[midAlias][k] = midNode[k]
                        }
                      }
                    }
                  }
                  if (pathEdges.length >= edgeVarColsLen) {
                    geNode.props.__stepEdges = pathEdges
                    stepEdgesCache.set(targetIdx, pathEdges)
                  }
                }
              }
              // source 节点——使用起始节点 allNodes[i] 而非 targetNode
              if (lastStepV?.source) {
                allVars[lastStepV.source] = { _label: (allNodes[i]?._label || 'Default') as string }
                for (const k of Object.keys(allNodes[i] || {})) {
                  if (k !== '__edges' && k !== 'props' && !k.startsWith('__')) (allVars[lastStepV.source] as any)[k] = (allNodes[i] as any)[k]
                }
              }"""

new4 = """              // ── allVars: full variable population from matchingPath ──
              const allVars: Record<string, unknown> = geNode.props._allVars as Record<string, unknown>
              if (boundedPaths?.length > 0) {
                const matchingPath = boundedPaths.find(p => p[p.length - 1] === targetIdx)
                if (matchingPath && matchingPath.length >= 2) {
                  // Comma case: only iterate mainSteps (before commaCutIdx); non-comma: full steps
                  const effSteps = (_ceComma && commaCutIdx > 0)
                    ? plan.steps!.slice(0, commaCutIdx)
                    : plan.steps!
                  const pathEdges: string[] = []
                  for (let psi = 0; psi < effSteps.length && psi < matchingPath.length - 1; psi++) {
                    const step = effSteps[psi]
                    // Edge label collection
                    const fromNode = allNodes[matchingPath[psi]] as any
                    if (fromNode?.__edges) {
                      const edge = fromNode.__edges.find((e: any) => {
                        const neighborIdx = e.dstIdx === matchingPath[psi] ? e.srcIdx : (e.srcIdx === matchingPath[psi] ? e.dstIdx : -1)
                        return neighborIdx === matchingPath[psi + 1]
                      })
                      if (edge?.label) pathEdges.push(edge.label)
                    }
                    // source variable → matchingPath[psi]
                    if (step.source && matchingPath[psi] !== undefined) {
                      const sn = allNodes[matchingPath[psi]]
                      if (sn && !allVars[step.source]) {
                        allVars[step.source] = { _label: sn._label || 'Default' }
                        for (const k of Object.keys(sn)) {
                          if (k !== '__edges' && k !== 'props' && !k.startsWith('__'))
                            (allVars[step.source] as any)[k] = sn[k]
                        }
                      }
                    }
                    // targetAlias → matchingPath[psi+1]
                    if (step.targetAlias && matchingPath[psi + 1] !== undefined) {
                      const tn = allNodes[matchingPath[psi + 1]]
                      if (tn && !allVars[step.targetAlias]) {
                        allVars[step.targetAlias] = { _label: tn._label || 'Default' }
                        for (const k of Object.keys(tn)) {
                          if (k !== '__edges' && k !== 'props' && !k.startsWith('__'))
                            (allVars[step.targetAlias] as any)[k] = tn[k]
                        }
                      }
                    }
                  }
                  if (pathEdges.length >= edgeVarColsLen) {
                    geNode.props.__stepEdges = pathEdges
                    stepEdgesCache.set(targetIdx, pathEdges)
                  }
                }
              }"""

assert old4 in code, "Fix 4: old text not found"
code = code.replace(old4, new4)

with open('src/query/query-executor.ts', 'w') as f:
    f.write(code)

print("All 4 fixes applied successfully.")
