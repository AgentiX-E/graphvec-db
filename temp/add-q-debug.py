with open('src/query/query-executor.ts') as f:
    e = f.read()

# Add debug for comma pattern matching
old = "const _commaPattern = new RegExp("
new = "process.stderr.write(\"CE_QUERY: \" + (query || \"NULL\").slice(0,200) + \"\\\\n\")\n                  const _commaPattern = new RegExp("

e = e.replace(old, new, 1)

with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
print('debug')
