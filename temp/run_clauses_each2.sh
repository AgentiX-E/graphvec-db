#!/bin/bash
cd /home/admin/openclaw/workspace/agentiX-graphvec
OUT=temp/clauses_each_result2.txt
> "$OUT"
for d in call create delete match match-where merge remove return return-orderby return-skip-limit set union unwind with with-orderBy with-skip-limit with-where; do
  echo "=== $d ===" >> "$OUT"
  r=$(timeout 150 npx cucumber-js "src/query/cypher-tck/features/clauses/$d/*.feature" \
    --require-module tsx --require src/query/cypher-tck/step-definitions.ts \
    --format json 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except: print('JSON_FAIL'); sys.exit(0)
tot=0;fail=0;fl=[]
for feat in d:
  for el in feat.get('elements',[]):
    if el.get('type')=='scenario':
      tot+=1
      sts=[s.get('result',{}).get('status') for s in el.get('steps',[])]
      if any(s!='passed' for s in sts):
        fail+=1; fl.append(el['name'])
print(f'  TOTAL {tot} FAILED {fail}')
for n in fl: print('   X '+n[:80])
" >> "$OUT" 2>&1)
done
echo "CLAUSES_ALL_DONE" >> "$OUT"
