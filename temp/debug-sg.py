with open('src/query/query-executor.ts') as f:
    e = f.read()

# Add debug: SG groups and path result
old = 'let pathResults'
new = 'process.stderr.write("SG groups=" + _sgGroups.length + " multi=" + _sgMulti + "\\n")\n            process.stderr.write("SG group0 len=" + _sgGroups[0].length + " steps=" + JSON.stringify(_sgGroups[0].map(s=>[s.source,s.targetAlias])) + "\\n")\n            let pathResults'

e = e.replace(old, new, 1)

# Add debug: cross validation result
old2 = 'pathResults = _sgCrossPassed'
new2 = 'process.stderr.write("SG crossPassed=" + _sgCrossPassed.length + "\\n")\n                pathResults = _sgCrossPassed'

e = e.replace(old2, new2, 1)

with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
print('done')
