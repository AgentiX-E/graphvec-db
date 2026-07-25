import sys
with open('src/query/query-executor.ts') as f:
    e = f.read()

old = 'const _cands: number[] = []'
new = 'process.stderr.write(`CE_CANDS sIdx=${_sIdx} src=${cs.source} tgt=${cs.targetAlias}\\n`)\n                const _cands: number[] = []'
e = e.replace(old, new, 1)

old2 = 'if (tgt >= 0 && tgt < allNodes.length && allNodes[tgt] && !_cands.includes(tgt))'
new2 = 'if (tgt >= 0) { process.stderr.write(`  ed: src=${ed.srcIdx} dst=${ed.dstIdx} tgt=${tgt}\\n`) }\n                  if (tgt >= 0 && tgt < allNodes.length && allNodes[tgt] && !_cands.includes(tgt))'
e = e.replace(old2, new2, 1)

with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
print('debug added')
