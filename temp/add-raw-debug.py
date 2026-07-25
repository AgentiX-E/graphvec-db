with open('src/query/query-executor.ts') as f:
    e = f.read()

old = '          return multiStepRaw'
new = """          process.stderr.write("MW2_RAW_L: " + multiStepRaw.length + " propsLabels:" + (multiStepRaw[0]?.props?._label || "*") + "\\n")
          return multiStepRaw"""

e = e.replace(old, new, 1)

with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
print('added')
