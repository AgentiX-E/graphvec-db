#!/bin/bash
cd /home/admin/openclaw/workspace/agentiX-graphvec
# Replace line 4127-4131
# Old: return (ge as any)._executeQueryPlan(planForGe)
# New: console.error + const gr = ... + console.error + return gr
LINE=$(grep -n "return (ge as any)._executeQueryPlan(planForGe)" src/query/query-engine.ts | head -1 | cut -d: -f1)
echo "Found at line $LINE"
sed -i "${LINE}s|return (ge as any)._executeQueryPlan(planForGe)|const gr = (ge as any)._executeQueryPlan(planForGe);console.error('GE-RES len='+(gr?.length||0)+' first='+JSON.stringify(gr?.[0]||'none'));return gr|" src/query/query-engine.ts
echo "Done"
