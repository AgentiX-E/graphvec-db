#!/usr/bin/env bash
# run-suite.sh — 分块执行 TCK 子句/表达式回归，输出 JSON 汇总
# 用法: bash scripts/run-suite.sh [suite] [suite...]
#   suite: quick | clauses | expressions | useCases | all
# 输出: temp/regression-result.json
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p temp
RESULT_FILE="temp/regression-result.json"
START=$(date +%s)

declare -A RESULTS

run_vitest() {
  local name="$1" files="$2"
  echo "[run-suite] vitest: $files"
  local tmpf
  tmpf=$(mktemp)
  npx vitest run --coverage.enabled=false $files > "$tmpf" 2>&1
  local rc=$?
  # Strip ANSI codes; use printf for the escape char
  local clean
  clean=$(sed $'s/\x1b\\[[0-9;]*[a-zA-Z]//g' "$tmpf")
  if echo "$clean" | grep -qE "Tests[[:space:]]+[0-9]+ passed"; then
    RESULTS["$name"]="PASS"
  else
    RESULTS["$name"]="FAIL"
  fi
  rm -f "$tmpf"
}

run_tck() {
  local name="$1" glob="$2"
  echo "[run-suite] TCK: $name ($glob)"
  # Run with timeout, capture JSON result
  local out
  out=$(timeout 120 npx cucumber-js "$glob" --format json 2>/dev/null)
  local rc=$?
  # If timeout, fail
  if [ $rc -eq 124 ]; then
    RESULTS["$name"]="TIMEOUT"
    return
  fi
  # Parse JSON
  local all=0 passed=0
  if echo "$out" | python3 -c "
import json,sys
try:
    data=json.load(sys.stdin)
except:
    sys.exit(1)
all=0;passed=0
for f in data:
    for e in f.get('elements',[]):
        all+=1
        steps=e.get('steps',[])
        st=steps[-1].get('result',{}).get('status','') if steps else ''
        if st=='passed': passed+=1
print(f'{passed}/{all}')
sys.exit(0 if all==passed and all>0 else 1)
" 2>/dev/null; then
    RESULTS["$name"]="PASS"
  else
    RESULTS["$name"]="FAIL"
  fi
}

run_tck_glob() {
  local name="$1" base="$2" tags="$3"
  # Build feature glob
  local glob=""
  IFS=',' read -ra dirs <<< "$tags"
  for dir in "${dirs[@]}"; do
    [ -n "$glob" ] && glob+=" "
    glob+="'$base/$dir/**/*.feature'"
  done
  run_tck "$name" "$glob"
}

# ── quick ──
if [[ "$*" =~ "quick" || "$*" =~ "all" ]]; then
  run_vitest "graph-engine" "src/core/graph-engine.spec.ts"
  run_vitest "query-engine" "src/query/query-engine.spec.ts"
  run_tck "old-top-level" "src/query/cypher-tck/features/0*.feature"
  run_tck "MatchWhere" "src/query/cypher-tck/features/clauses/match-where/**/*.feature"
fi

# ── clauses ──
if [[ "$*" =~ "clauses" || "$*" =~ "all" ]]; then
  CLAUSES=(
    "match-where:clauses/match-where"
    "match:clauses/match"
    "create:clauses/create"
    "delete:clauses/delete"
    "merge:clauses/merge"
    "set:clauses/set"
    "remove:clauses/remove"
    "return:clauses/return"
    "return-orderby:clauses/return-orderby"
    "return-skip-limit:clauses/return-skip-limit"
    "union:clauses/union"
    "unwind:clauses/unwind"
    "with:clauses/with"
    "with-orderBy:clauses/with-orderBy"
    "with-skip-limit:clauses/with-skip-limit"
    "with-where:clauses/with-where"
    "call:clauses/call"
  )
  for entry in "${CLAUSES[@]}"; do
    nm="${entry%%:*}"
    dir="${entry##*:}"
    run_tck "clauses-$nm" "src/query/cypher-tck/features/$dir/**/*.feature"
  done
fi

# ── expressions ──
if [[ "$*" =~ "expressions" || "$*" =~ "all" ]]; then
  EXPRS=(
    "aggregation:aggregation"
    "boolean:boolean"
    "comparison:comparison"
    "conditional:conditional"
    "existentialSubqueries:existentialSubqueries"
    "graph:graph"
    "list:list"
    "literals:literals"
    "map:map"
    "mathematical:mathematical"
    "null:null"
    "path:path"
    "pattern:pattern"
    "precedence:precedence"
    "quantifier:quantifier"
    "string:string"
    "temporal:temporal"
    "typeConversion:typeConversion"
  )
  for entry in "${EXPRS[@]}"; do
    nm="${entry%%:*}"
    dir="${entry##*:}"
    run_tck "expr-$nm" "src/query/cypher-tck/features/expressions/$dir/**/*.feature"
  done
fi

# ── useCases ──
if [[ "$*" =~ "useCases" || "$*" =~ "all" ]]; then
  run_tck "useCases" "src/query/cypher-tck/features/useCases/**/*.feature"
fi

# ── summary ──
END=$(date +%s)
echo ""
echo "═══════════════════════════════════════════"
echo "  Regression Summary ($((END-START))s)"
echo "═══════════════════════════════════════════"
PASS=0
FAIL=0
for k in "${!RESULTS[@]}"; do
  v="${RESULTS[$k]}"
  echo "  $([ "$v" = "PASS" ] && echo "✅" || echo "❌") $k: $v"
  [ "$v" = "PASS" ] && ((PASS++)) || ((FAIL++))
done
echo "PASS: $PASS  |  FAIL: $FAIL"
echo "{\"pass\":$PASS,\"fail\":$FAIL,\"duration\":$((END-START)),\"results\":$(printf '%s\n' "${!RESULTS[@]}" | jq -Rn '[inputs as $k | {$k, v: $ARGS.named[$k]}]' --argjson "$(echo "${RESULTS[@]}")" 2>/dev/null || echo '{}')}" > "$RESULT_FILE"
[ "$FAIL" -eq 0 ]
