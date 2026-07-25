with open('src/query/query-executor.ts') as f:
    e = f.read()
old = 'const _sVar = (_avars as any)[cs.source]'
new = 'process.stderr.write("CE_VARS a=" + (JSON.stringify((_avars as any).a)) + " b=" + (JSON.stringify((_avars as any).b)) + " c=" + (JSON.stringify((_avars as any).c)) + " d=" + (JSON.stringify((_avars as any).d)) + "\\n")\n                const _sVar = (_avars as any)[cs.source]'
e = e.replace(old, new, 1)
with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
print('debug')
