#!/bin/bash
set -uo pipefail
export NODE_OPTIONS="--max-old-space-size=4096"
cd "$(dirname "$0")/.."
dirs=(call create delete match match-where merge remove return return-orderby return-skip-limit set union unwind with with-orderBy with-skip-limit with-where aggregation boolean comparison conditional existentialSubqueries graph list literals map mathematical null path pattern precedence quantifier string temporal typeConversion)
total_pass=0; total_fail=0; total_scen=0
echo "DIR | PASS/FAIL"
for d in "${dirs[@]}"; do
  feat="src/query/cypher-tck/features/clauses/$d/**/*.feature"
  [ -d "src/query/cypher-tck/features/expressions/$d" ] && feat="src/query/cypher-tck/features/expressions/$d/**/*.feature"
  out=$(timeout 200 npx cucumber-js "$feat" --require-module tsx --require src/query/cypher-tck/step-definitions.ts --format json 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
total=0; fail=0; fails=[]
for f in d:
  for e in f.get('elements',[]):
    if e.get('type')=='scenario':
      total+=1
      sts=[s.get('result',{}).get('status') for s in e.get('steps',[])]
      if not all(x=='passed' for x in sts):
        fail+=1; fails.append(e['name'][:50])
print(f'{total-fail}/{total}')
for x in fails[:8]: print('  FAIL:', x)
")
  rc=$?
  line=$(echo "$out" | head -1)
  echo "[$d] $line"
  p=$(echo "$line" | cut -d/ -f1); f=$(echo "$line" | cut -d/ -f2)
  total_pass=$((total_pass + p)); total_fail=$((total_fail + f))
  total_scen=$((total_scen + p + f))
  if [ "$f" != "0" ]; then
    echo "$out" | grep "FAIL:" | sed 's/^/  /'
  fi
done
echo "======================================"
echo "TOTAL: $total_pass PASS, $total_fail FAIL, $total_scen scenarios"
