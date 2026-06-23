const fs = require('fs');
let c = fs.readFileSync('src/query/query-engine.ts', 'utf8');

// 在 EXISTS 过滤分支开头加 console.log
const marker = `} else if (/^exists\\s*\\{/i.test(plan.whereBody.trim())) {
          // EXISTS { ... } 子查询：扫描 allNodes 所有边，检查当前节点是否有匹配的边
          const ebody = plan.whereBody.trim()
          const srcMatch = ebody.match(/\\((\\w+)/)
          let existsVal = false`;

const debugMarker = `} else if (/^exists\\s*\\{/i.test(plan.whereBody.trim())) {
          // EXISTS { ... } 子查询：扫描 allNodes 所有边，检查当前节点是否有匹配的边
          console.log('[DBG EXISTS] whereBody:', plan.whereBody)
          console.log('[DBG EXISTS] ctx keys:', Object.keys(ctx))
          console.log('[DBG EXISTS] allNodes:', JSON.stringify(allNodes.map((n:any) => ({_label: n._label, props: Object.keys(n).filter(k => !k.startsWith('_')).reduce((o:any,k) => {o[k]=n[k];return o}, {}), __edges: n.__edges?.length || 0}))))
          const ebody = plan.whereBody.trim()
          const srcMatch = ebody.match(/\\((\\w+)/)
          let existsVal = false`;

c = c.replace(marker, debugMarker);
fs.writeFileSync('src/query/query-engine.ts', c);
console.log('debug added');
