with open('src/query/query-executor.ts') as f:
    e = f.read()

old = "    const rawResult: QueryRow[] = rawWithEdges.map((r: any) => {"
new = """    process.stderr.write("MW2_RWRESULT: " + JSON.stringify({rweLen:rawWithEdges?.length}) + "\\n")
    const rawResult: QueryRow[] = rawWithEdges.map((r: any) => {"""

e = e.replace(old, new, 1)

with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
print('done')
