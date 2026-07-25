with open('src/query/query-executor.ts') as f:
    e = f.read()

# Find the boundedTargetIndices calculation section
# After `const lastStep = plan.steps[plan.steps.length - 1]` check
old = """              const lastStep = plan.steps[plan.steps.length - 1]
              if (lastStep && lastStep.targetAlias === effectiveRetVar) {
                boundedTargetIndices = [...pathEnds].filter(idx => interEnds.has(idx))
                // 同时筛选 boundedPaths
                boundedPaths = pathResults.filter(p => interEnds.has(p[p.length - 1]))
              } else {
                boundedTargetIndices = [...interEnds]
                boundedPaths = intermediate
              }"""

# When _sgHasComma, pathEnds includes the last comma step's target which may differ from
# the def step's end. Use interEnds directly.
new = """              const lastStep = plan.steps[plan.steps.length - 1]
              if (_sgHasComma) {
                // Comma-separated MATCH: pathEnds reflects the full path including
                // added comma steps which may change the path endpoint.
                // Use the interEnds from the def step walk directly.
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

if old in e:
    e = e.replace(old, new)
    print('replaced boundedTargetIndices for comma')
else:
    print('NOT FOUND')

with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
