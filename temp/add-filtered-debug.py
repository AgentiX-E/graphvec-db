with open('src/query/query-executor.ts') as f:
    e = f.read()

# Add debug at filteredRecords
old = '    const filteredRecords = plan.labelExpr?.items?.length'
new = """    process.stderr.write("MW2_FILTERED: recsLen=" + (records?.length||0) + " rawLen=" + (rawRecords?.length||0) + "\\n")
    const filteredRecords = plan.labelExpr?.items?.length"""

e = e.replace(old, new, 1)

with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
print('done')
