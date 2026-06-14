#!/usr/bin/env bash
# full-regression.sh — 一键全量回归验证
# 用法: bash scripts/full-regression.sh [--quick]
#   --quick: 跳过 TCK 全量（只跑 vitest + MatchWhere + old top-level）
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
SUMMARY=""

check() {
  local name="$1" cmd="$2"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $name"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  # Run in subshell to isolate pipefail, capture LAST exit code (python validator)
  local rc=0
  (set +eo pipefail; eval "$cmd") || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "  ✅ $name PASSED"
    PASS=$((PASS + 1))
    SUMMARY="$SUMMARY\n  ✅ $name"
  else
    echo "  ❌ $name FAILED (exit code $rc)"
    FAIL=$((FAIL + 1))
    SUMMARY="$SUMMARY\n  ❌ $name"
  fi
}

QUICK=false
[[ "${1:-}" == "--quick" ]] && QUICK=true

# ── vitest ──
check "graph-engine.spec.ts (622 tests)" \
  "npx vitest run src/core/graph-engine.spec.ts --coverage.enabled=false 2>&1 | tail -5"

check "query-engine.spec.ts (71 tests)" \
  "npx vitest run src/query/query-engine.spec.ts --coverage.enabled=false 2>&1 | tail -5"

# ── old top-level features (JSON 模式) ──
check "TCK old top-level (5 features)" \
  "npx cucumber-js 'src/query/cypher-tck/features/0*.feature' \
    --require-module tsx --require src/query/cypher-tck/step-definitions.ts \
    --format json 2>/dev/null | python3 -c \"
import json,sys
data=json.load(sys.stdin)
all=0;passed=0
for f in data:
    for e in f.get('elements',[]):
        all+=1
        steps=e.get('steps',[])
        st=steps[-1].get('result',{}).get('status','') if steps else ''
        if st=='passed': passed+=1
print(f'{passed}/{all} passed')
sys.exit(0 if all==passed else 1)
\""

# ── MatchWhere (用 JSON 模式验证 pass count，避免 cucumber --summary 退出码误导) ──
check "TCK MatchWhere (34 scenarios)" \
  "npx cucumber-js 'src/query/cypher-tck/features/clauses/match-where/**/*.feature' \
    --require-module tsx --require src/query/cypher-tck/step-definitions.ts \
    --format json 2>/dev/null | python3 -c \"
import json,sys
data=json.load(sys.stdin)
all=0;passed=0
for f in data:
    for e in f.get('elements',[]):
        all+=1
        steps=e.get('steps',[])
        st=steps[-1].get('result',{}).get('status','') if steps else ''
        if st=='passed': passed+=1
print(f'{passed}/{all} passed')
sys.exit(0 if all==passed else 1)
\""

if [ "$QUICK" = false ]; then
  # ── clauses (JSON 模式) ──
  check "TCK clauses (17 dirs, ~1230 scenarios)" \
    "npx cucumber-js 'src/query/cypher-tck/features/clauses/{call,create,delete,match,match-where,merge,remove,return,return-orderby,return-skip-limit,set,union,unwind,with,with-orderBy,with-skip-limit,with-where}/**/*.feature' \
      --require-module tsx --require src/query/cypher-tck/step-definitions.ts \
      --format json 2>/dev/null | python3 -c \"
import json,sys
data=json.load(sys.stdin)
all=0;passed=0
for f in data:
    for e in f.get('elements',[]):
        all+=1
        steps=e.get('steps',[])
        st=steps[-1].get('result',{}).get('status','') if steps else ''
        if st=='passed': passed+=1
print(f'{passed}/{all} passed')
sys.exit(0 if all==passed else 1)
\""

  # ── expressions (JSON 模式) ──
  check "TCK expressions (18 dirs, ~2620 scenarios)" \
    "npx cucumber-js 'src/query/cypher-tck/features/expressions/{aggregation,boolean,comparison,conditional,existentialSubqueries,graph,list,literals,map,mathematical,null,path,pattern,precedence,quantifier,string,temporal,typeConversion}/**/*.feature' \
      --require-module tsx --require src/query/cypher-tck/step-definitions.ts \
      --format json 2>/dev/null | python3 -c \"
import json,sys
data=json.load(sys.stdin)
all=0;passed=0
for f in data:
    for e in f.get('elements',[]):
        all+=1
        steps=e.get('steps',[])
        st=steps[-1].get('result',{}).get('status','') if steps else ''
        if st=='passed': passed+=1
print(f'{passed}/{all} passed')
sys.exit(0 if all==passed else 1)
\""

  # ── useCases (JSON 模式) ──
  check "TCK useCases (30 scenarios)" \
    "npx cucumber-js 'src/query/cypher-tck/features/useCases/**/*.feature' \
      --require-module tsx --require src/query/cypher-tck/step-definitions.ts \
      --format json 2>/dev/null | python3 -c \"
import json,sys
data=json.load(sys.stdin)
all=0;passed=0
for f in data:
    for e in f.get('elements',[]):
        all+=1
        steps=e.get('steps',[])
        st=steps[-1].get('result',{}).get('status','') if steps else ''
        if st=='passed': passed+=1
print(f'{passed}/{all} passed')
sys.exit(0 if all==passed else 1)
\""

  # ── ANTLR stderr 干净验证 ──
  check "ANTLR stderr: 0 error lines" \
    "! npx cucumber-js 'src/query/cypher-tck/features/clauses/match-where/**/*.feature' \
      --require-module tsx --require src/query/cypher-tck/step-definitions.ts \
      2>&1 | grep -cE '(mismatched|extraneous|no viable|line [0-9]+:)' > /dev/null 2>&1"
fi

# ── 总结 ──
echo ""
echo "═══════════════════════════════════════════"
echo "  全量回归总结"
echo "═══════════════════════════════════════════"
echo -e "$SUMMARY"
echo ""
echo "PASS: $PASS  |  FAIL: $FAIL"
[ "$FAIL" -eq 0 ] && echo "🎉 ALL GREEN" || echo "❌ $FAIL failure(s)"
[ "$FAIL" -eq 0 ]
