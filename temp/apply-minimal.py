"""
Minimal fix: only _ceComma + boundedTarget guard + comma-step edge verification.
No comma-expansion (independent walk).
"""
with open('src/query/query-executor.ts') as f:
    e = f.read()

# Fix 1: _ceComma
old1 = """          const savedEdgeLabel = plan.steps?.[0]?.edgeLabel ?? null
          if (plan.steps?.[0]) plan.steps[0].edgeLabel = null
          for (let i = 0; i < allNodes.length; i++) {"""

new1 = """          const savedEdgeLabel = plan.steps?.[0]?.edgeLabel ?? null
          if (plan.steps?.[0]) plan.steps[0].edgeLabel = null
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

# Fix 2: boundedTarget guard
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

with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
print('Minimal fix applied')
