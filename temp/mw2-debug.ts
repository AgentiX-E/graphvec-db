import { parseQuery, _executeQuery } from '../src/query/query-engine';

const nodes: any[] = [
  {_label:"A", _alias:"a"},
  {_label:"B", _alias:"b", id:1},
  {_label:"C", _alias:"c", id:2},
  {_label:"D", _alias:"d"},
];
const edges = [
  [0,1], [0,2], [0,3], [1,2], [1,3], [2,3],
];
for (const [a,b] of edges) {
  if (!nodes[a].__edges) nodes[a].__edges = [];
  (nodes[a].__edges as any).push({srcIdx:a, dstIdx:b, label:"T"});
}

const q = "MATCH (a)--(b)--(c)--(d)--(a), (b)--(d) WHERE a.id = 1 AND c.id = 2 RETURN d";
const plan = parseQuery(q);
console.log("steps:", plan.steps?.length, plan.steps?.map((s:any)=>s.source+'-'+s.targetAlias));
console.log("filters:", plan.filters);
console.log("scanLabel:", plan.scanLabel);

_executeQuery(plan, nodes, q).then(r => {
  console.log("result:", r.length, JSON.stringify(r));
}).catch(e => console.error(e));
