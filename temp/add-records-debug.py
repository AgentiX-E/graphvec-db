with open('src/query/query-executor.ts') as f:
    e = f.read()

old = '    let records = rawRecords'
new = """    process.stderr.write("MW2_RECORDS: " + JSON.stringify({rawLen:rawRecords?.length,firstLabel:rawRecords?.[0]?.props?._label}) + "\\n")
    let records = rawRecords"""

e = e.replace(old, new, 1)

# After records filter
old2 = '    if (queryEngineFilters.length && rawRecords?.length) {'
new2 = """    process.stderr.write("MW2_QEF: " + JSON.stringify({qefLen:queryEngineFilters.length,rawLen:rawRecords?.length}) + "\\n")
    if (queryEngineFilters.length && rawRecords?.length) {"""

e = e.replace(old2, new2, 1)

# Before formatting
old3 = '    const rawWithEdges = records.map((r: any) => {'
new3 = """    process.stderr.write("MW2_BEFORE_FORMAT: " + JSON.stringify({recordsLen:records?.length}) + "\\n")
    const rawWithEdges = records.map((r: any) => {"""

e = e.replace(old3, new3, 1)

with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
print('added')
