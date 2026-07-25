with open('src/query/query-executor.ts') as f:
    e = f.read()

old = "    if (crossVarFilters.length && filteredWithLabels?.length) {"
new = """    process.stderr.write("MW2_CVF: " + JSON.stringify({cvfLen:crossVarFilters.length,fwlLen:filteredWithLabels?.length}) + "\\n")
    if (crossVarFilters.length && filteredWithLabels?.length) {"""

e = e.replace(old, new, 1)

with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
print('done')
