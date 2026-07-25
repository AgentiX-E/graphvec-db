with open('src/query/query-executor.ts') as f:
    e = f.read()

# After pathEnds computed, before boundedTargetIndices
old = '        const retVars: string[] = []'
new = """        process.stderr.write("MW2_PATHENDS: " + JSON.stringify({peLen:pathEnds.length,peVals:[...new Set(pathEnds)].slice(0,5)}) + "\\n")
        process.stderr.write("MW2_STEPS: " + JSON.stringify(plan.steps?.map((s:any,i:number) => ({i,src:s.source,tgt:s.targetAlias}))) + "\\n")
        const retVars: string[] = []"""

e = e.replace(old, new, 1)

# After effectiveRetVar computed
old2 = 'let boundedTargetIndices: number[] = [...pathEnds]'
new2 = """process.stderr.write("MW2_ERV: " + JSON.stringify({erv:effectiveRetVar,retVar,lastTargetVar}) + "\\n")
        let boundedTargetIndices: number[] = [...pathEnds]"""

e = e.replace(old2, new2, 1)

# After boundedTargetIndices computation, before the self-step check
old3 = '        // 自环模式'
new3 = """process.stderr.write("MW2_BTI: " + JSON.stringify({btLen:boundedTargetIndices.length,peLen:pathEnds.length,bpLen:boundedPaths?.length}) + "\\n")
        // 自环模式"""

e = e.replace(old3, new3, 1)

with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
print('debug added')
