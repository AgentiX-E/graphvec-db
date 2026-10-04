import { parseQuery, _executeQuery } from '../src/query/query-engine'
const q = `MATCH (a:S)-[:X]->(b1) WITH a, collect(b1) AS bees UNWIND bees AS b2 MATCH (a)-[:Y]->(b2) RETURN a, b2`
const plan = parseQuery(q)
// 构造图
const s = {_label:'S', _alias:'a'}
const n = {_label:undefined, _alias:undefined}
const e = {_label:'E', _alias:'b1'}
// edges: s-X->e, s-Y->e, n-Y->e
;(s as any).__edges = [{srcIdx:1,dstIdx:2,label:'X'},{srcIdx:1,dstIdx:2,label:'Y'}]
;(n as any).__edges = [{srcIdx:0,dstIdx:2,label:'Y'}]
const nodes = [n, s, e]  // idx 0=n, 1=s, 2=e
// 修正 s.__edges 的 srcIdx
;(s as any).__edges = [{srcIdx:1,dstIdx:2,label:'X'},{srcIdx:1,dstIdx:2,label:'Y'}]
_executeQuery(plan, nodes as any, q).then(r => console.log('result:', JSON.stringify(r))).catch(e=>console.log('ERR:', e.message))
