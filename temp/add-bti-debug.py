import sys

with open('src/query/query-executor.ts') as f:
    e = f.read()

old = "const isSelfStep = plan.steps?.[0]?.source && plan.steps?.[0]?.targetAlias &&"
new = 'process.stderr.write("MW2_BTI: " + JSON.stringify({btLen:boundedTargetIndices.length,peLen:pathEnds.length,ieLen:interEnds?.size,bpLen:boundedPaths?.length}) + "\\n")\n        ' + old

if old in e:
    e = e.replace(old, new, 1)
    print('btti debug added')
else:
    print('NOT FOUND')
    
with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
