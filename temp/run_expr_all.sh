#!/bin/bash
# 逐目录跑 expressions，避免单进程全量超时
cd /home/admin/openclaw/workspace/agentiX-graphvec
OUT=temp/expr_all_result.txt
> "$OUT"
for d in aggregation boolean comparison conditional existentialSubqueries graph list literals map mathematical null path pattern precedence quantifier string temporal typeConversion; do
  echo "=== $d ===" >> "$OUT"
  timeout 180 npx cucumber-js "src/query/cypher-tck/features/expressions/$d/*.feature" \
    --require-module tsx --require src/query/cypher-tck/step-definitions.ts \
    --format json 2>/dev/null | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
except:
  print('   (json parse fail)'); sys.exit(0)
tot=0;fail=[]
for feat in d:
  for el in feat.get('elements',[]):
    if el.get('type')=='scenario':
      tot+=1
      sts=[s.get('result',{}).get('status') for s in el.get('steps',[])]
      if any(s!='passed' for s in sts):
        fail.append(el['name'])
print('   TOTAL', tot, 'FAILED', len(fail))
for n in fail: print('   X', n)
" >> "$OUT" 2>&1
done
echo "DONE" >> "$OUT"
