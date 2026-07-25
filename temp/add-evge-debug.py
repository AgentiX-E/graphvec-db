with open('src/query/query-executor.ts') as f:
    e = f.read()

old = "    const evgeReturn = _postProcessResults(result, plan)"
new = """    process.stderr.write("MW2_EVGE: " + JSON.stringify({rLen:result?.length,isArr:Array.isArray(result)}) + "\\n")
    const evgeReturn = _postProcessResults(result, plan)"""

e = e.replace(old, new, 1)

with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
print('done')
