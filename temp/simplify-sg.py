import re

with open('src/query/query-executor.ts') as f:
    e = f.read()

# Find the full SG block start (from "// [STEP-GROUPS]" to "const pathEnds")
sg_start = e.find('// [STEP-GROUPS]')
path_ends = e.find('const pathEnds = _pathEndIndices(pathResults)', sg_start)

if sg_start < 0 or path_ends < 0:
    print('NOT FOUND')
    exit(1)

# The SG block spans from sg_start to path_ends + line
# Replace with simplified version
replacement = """// [COMMA-STEP]: 逗号分隔 MATCH 的跨步边验证
            const _sgHasComma = plan.steps?.length > 1 && plan.steps.some(
              (s: any, si: number) => si > 0 && s.source !== plan.steps![si - 1].targetAlias
            )
            let pathResults = _walkMultiSteps(i, plan.steps, allNodes, skipNodeIndices, plan.filters, stepSourceFilters)
            if (_sgHasComma && pathResults.length > 0) {
              // 跨 pattern 边验证：检查 comma 不连续步的边是否存在
              const _commaFiltered: number[][] = []
              for (const p of pathResults) {
                const _cmap: Record<string, number> = {}
                _cmap[plan.steps![0].source] = i
                for (let si = 0; si < plan.steps!.length && si < p.length - 1; si++) {
                  if (plan.steps![si]?.targetAlias) _cmap[plan.steps![si].targetAlias] = p[si + 1]
                }
                let _cpass = true
                for (let si = 0; si < plan.steps!.length; si++) {
                  // 跳过 source 连续的步（非 comma 分隔）
                  if (si > 0 && plan.steps![si].source === plan.steps![si - 1].targetAlias) continue
                  if (si === 0) continue
                  // comma 分隔步：验证边存在性
                  const cs = plan.steps![si]
                  const cSrc = cs.source ? _cmap[cs.source] : -1
                  const cTgt = cs.targetAlias ? _cmap[cs.targetAlias] : -1
                  if (cSrc >= 0 && cTgt >= 0) {
                    let cFound = false
                    for (const ni of [cSrc, cTgt]) {
                      const cn = allNodes[ni] as any
                      if (!cn?.__edges) continue
                      for (const ed of cn.__edges) {
                        const match = cs.direction === 'any'
                          ? ((ed.srcIdx === cSrc && ed.dstIdx === cTgt) || (ed.srcIdx === cTgt && ed.dstIdx === cSrc))
                          : cs.direction === 'in'
                          ? (ed.dstIdx === cSrc && ed.srcIdx === cTgt)
                          : (ed.srcIdx === cSrc && ed.dstIdx === cTgt)
                        if (match) { cFound = true; break }
                      }
                      if (cFound) break
                    }
                    if (!cFound) { _cpass = false; break }
                  } else {
                    _cpass = false; break
                  }
                }
                if (_cpass) _commaFiltered.push(p)
              }
              pathResults = _commaFiltered
            }
        const pathEnds = _pathEndIndices(pathResults)"""

before_sg = e[:sg_start]
after_path_ends = e[path_ends + len('const pathEnds = _pathEndIndices(pathResults)'):]

e = before_sg + replacement + after_path_ends

with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
print(f'Replaced SG block ({sg_start}-{path_ends}, {path_ends - sg_start} chars) with simplified comma-step check')
