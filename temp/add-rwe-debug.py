with open('src/query/query-executor.ts') as f:
    e = f.read()

old = "let rawWithEdges = (edgeVarCols.length && (hasMatchingEdgeLabel || edgesPayload.length))"
new = """process.stderr.write("MW2_RWE: " + JSON.stringify({evcLen:edgeVarCols.length,epLen:edgePropFilteredRecords?.length}) + "\\n")
    let rawWithEdges = (edgeVarCols.length && (hasMatchingEdgeLabel || edgesPayload.length))"""

e = e.replace(old, new, 1)

with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
print('done')
