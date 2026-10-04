#!/bin/bash
cd /home/admin/openclaw/workspace/agentiX-graphvec
OUT=temp/expr_results.txt
: > "$OUT"
for dir in src/query/cypher-tck/features/expressions/*/; do
  name=$(basename "$dir")
  echo "=== $name ===" >> "$OUT"
  timeout 600 npx cucumber-js "$dir*.feature" --require-module tsx --require src/query/cypher-tck/step-definitions.ts --format json 2>/dev/null | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
except Exception as e:
  print('PARSE_ERR', e); sys.exit(0)
tot=0;fail=[]
for feat in d:
  for el in feat.get('elements',[]):
    if el.get('type') in ('scenario','scenario_outline'):
      exs = el.get('elements',[]) if el.get('type')=='scenario_outline' else [el]
      for ex in exs:
        tot+=1
        sts=[s.get('result',{}).get('status') for s in ex.get('steps',[])]
        if any(s!='passed' for s in sts):
          err=[s.get('result',{}).get('error_message','') for s in ex.get('steps',[]) if s.get('result',{}).get('status')!='passed'][0]
          fail.append((ex['name'], err[:80].replace(chr(10),' ')))
print('  TOTAL', tot, 'FAILED', len(fail))
for n,e in fail: print('    X', n, '->', e)
" >> "$OUT" 2>&1
done
echo "DONE" >> "$OUT"
