#!/bin/bash
cd /home/admin/openclaw/workspace/agentiX-graphvec
npx cucumber-js 'src/query/cypher-tck/features/clauses/{call,create,delete,match,match-where,merge,remove,return,return-orderby,return-skip-limit,set,union,unwind,with,with-orderBy,with-skip-limit,with-where}/**/*.feature' \
  --require-module tsx --require src/query/cypher-tck/step-definitions.ts \
  --format json 2>/dev/null | python3 scripts/tck-verify.py
echo "CLAUSES_DONE rc=$?"
