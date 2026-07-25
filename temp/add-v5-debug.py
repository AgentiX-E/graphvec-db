with open('src/query/query-executor.ts') as f:
    e = f.read()

old = 'if (_sIdx < 0) continue'
new = 'process.stderr.write("CE_SIDX sidx=" + _sIdx + " src=" + _srcVar + " tgt=" + cs.targetAlias + "\\n")\n                if (_sIdx < 0) continue'
e = e.replace(old, new, 1)

old2 = 'if (!_sNode?.__edges) continue'
new2 = 'process.stderr.write("CE_EDGES nid=" + _sIdx + " edges=" + JSON.stringify(_sNode?.__edges?.map((e2:any) => ({s:e2.srcIdx,d:e2.dstIdx}))) + "\\n")\n                if (!_sNode?.__edges) continue'
e = e.replace(old2, new2, 1)

old3 = 'const _cands: number[] = []'
new3 = 'process.stderr.write("CE_INCOMING check\\n")\n                const _cands: number[] = []'
e = e.replace(old3, new3, 1)

with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
print('debug')
