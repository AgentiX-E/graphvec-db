with open('src/query/query-executor.ts') as f:
    e = f.read()

# Find and replace the regex construction
old = "const _qtVar = cs.targetAlias\n                const _commaSrcRe = new RegExp(\n                  ',\\\\\\\\s*\\\\\\\\(([a-zA-Z_]\\\\\\\w*)\\\\\\\\\)\\\\\\\s*--\\\\\\\s*\\\\\\\(' + _qtVar.replace(/[.*+?^${}()|[\\]\\\\\\\/]/g, '\\\\$&') + '\\\\)', 'i'\n                )\n                const _cm = query.match(_commaSrcRe)\n                const _srcVar = _cm?.[1]"

# Replace with direct regex literal
new = """const _qtVar = cs.targetAlias
                const _commaSrcRe = /,\\s*\\(([a-zA-Z_]\\w*)\\)\\s*--\\s*\\(X\\)/i
                const _reSource = new RegExp(
                  ',\\\\s*\\\\(([a-zA-Z_]\\\\w*)\\\\)\\\s*--\\\s*\\\\('
                  + _qtVar.replace(/[.*+?^${}()|[\\]\\\\\\/]/g, '\\\\$&') + '\\\\)', 'i'
                )
                const _cm = query.match(_reSource)
                const _srcVar = _cm?.[1]"""

e = e.replace(old, new)
with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
print('done')
