with open('src/query/ast-to-plan-v2.ts') as f:
    e = f.read()

old = "  const _commaVars = new Set<string>()"
new = """  const _commaVars = new Set<string>()
  // debug
  process.stderr.write("[COMMA_DEBUG] nodePatterns len=" + nodePatterns.length + " commaVars=" + JSON.stringify([..._commaVars]) + "\\n")"""

e = e.replace(old, new, 1)

with open('src/query/ast-to-plan-v2.ts', 'w') as f:
    f.write(e)
print('done')
