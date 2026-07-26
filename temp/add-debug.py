with open('src/query/query-executor.ts') as f:
    e = f.read()

old = 'let matchingPath: number[] | null = null'
new = 'let matchingPath: number[] | null = null\n              process.stderr.write("ALLVARS0 defStepIdx=" + (plan.steps?.findIndex((st: any) => st.targetAlias === lastTargetVar)) + " targetIdx=" + targetIdx + " boundedPathsLen=" + (boundedPaths ? boundedPaths.length : 0) + "\\n")'

e = e.replace(old, new, 1)

with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
print('done')
