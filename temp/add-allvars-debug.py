with open('src/query/query-executor.ts') as f:
    e = f.read()

# Add debug after allVars is populated
old = 'geNode.__targetProps[k] = targetNode[k]'
new = 'geNode.__targetProps[k] = targetNode[k]\n              // Debug\n              process.stderr.write("ALLVARS: a=" + JSON.stringify(allVars.a) + " b=" + JSON.stringify(allVars.b) + " c=" + JSON.stringify(allVars.c) + " d=" + JSON.stringify(allVars.d) + " i=" + i + " targetIdx=" + targetIdx + " boundedPaths=" + (boundedPaths ? boundedPaths.length : 0) + "\\n")'

e = e.replace(old, new, 1)
with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
print('debug')
