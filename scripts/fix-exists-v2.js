const fs = require('fs');
let c = fs.readFileSync('src/query/query-engine.ts', 'utf8');

// Replace the inline EXISTS filter to scan all allNodes edges
const oldFunc = `} else if (/^exists\\s*\\{/i.test(plan.whereBody.trim())) {
          // EXISTS { ... } 子查询：检查 allNodes 中该节点是否有出边
          const ebody = plan.whereBody.trim()
          const srcMatch = ebody.match(/\\((\\w+)/)
          let existsVal = false
          if (srcMatch && allNodes?.length) {
            const srcVar = srcMatch[1]
            const srcNode = ctx[srcVar]
            if (srcNode) {
              const srcProps = srcNode.props || srcNode
              const srcLabel = srcProps._label || ''
              for (const anode of allNodes) {
                if (anode._label !== srcLabel) continue
                let pm = true
                for (const k of Object.keys(srcProps)) {
                  if (k.startsWith('_') || k === 'name' || k === '__edges') continue
                  if (anode[k] !== srcProps[k]) { pm = false; break }
                }
                if (!pm) continue
                if (anode.__edges?.length) existsVal = true
                break
              }
            }
          }
          evalVal = existsVal`;

const newFunc = `} else if (/^exists\\s*\\{/i.test(plan.whereBody.trim())) {
          // EXISTS { ... } 子查询：扫描 allNodes 所有边，检查当前节点是否有匹配的边
          const ebody = plan.whereBody.trim()
          const srcMatch = ebody.match(/\\((\\w+)/)
          let existsVal = false
          if (srcMatch && allNodes?.length) {
            const srcVar = srcMatch[1]
            const srcNode = ctx[srcVar]
            if (srcNode) {
              const srcProps = srcNode.props || srcNode
              const srcLabel = srcProps._label || ''
              // 扫描 allNodes 中所有节点的 __edges
              for (const anode of allNodes) {
                if (anode._label !== srcLabel) continue
                let pm = true
                for (const k of Object.keys(srcProps)) {
                  if (k.startsWith('_') || k === 'name' || k === '__edges') continue
                  if (anode[k] !== srcProps[k]) { pm = false; break }
                }
                if (!pm) continue
                // 检查该节点是否有边（__edges 可能在 any allNodes entry 中）
                if (anode.__edges?.length) { existsVal = true; break }
                // 也检查其他节点的 __edges 中是否有以此节点为 src/dst 的边
                const anodeIdx = allNodes.indexOf(anode)
                for (const other of allNodes) {
                  if (other.__edges && Array.isArray(other.__edges)) {
                    for (const e of other.__edges) {
                      if (e.srcIdx === anodeIdx || e.dstIdx === anodeIdx) {
                        existsVal = true; break
                      }
                    }
                    if (existsVal) break
                  }
                }
                if (existsVal) break
              }
            }
          }
          evalVal = existsVal`;

c = c.replace(oldFunc, newFunc);
console.log('F1 done');

// Same for second location
// Find "evalVal = existsVal2" pattern
const oldFunc2 = `} else if (/^exists\\s*\\{/i.test(plan.whereBody.trim())) {
              const ebody2 = plan.whereBody.trim()
              const srcMatch2 = ebody2.match(/\\((\\w+)/)
              let existsVal2 = false
              if (srcMatch2 && allNodes?.length) {
                const srcVar2 = srcMatch2[1]
                const srcNode2 = ctx[srcVar2]
                if (srcNode2) {
                  const srcProps2 = srcNode2.props || srcNode2
                  const srcLabel2 = srcProps2._label || ''
                  for (const anode of allNodes) {
                    if (anode._label !== srcLabel2) continue
                    let pm2 = true
                    for (const k of Object.keys(srcProps2)) {
                      if (k.startsWith('_') || k === 'name' || k === '__edges') continue
                      if (anode[k] !== srcProps2[k]) { pm2 = false; break }
                    }
                    if (!pm2) continue
                    if (anode.__edges?.length) existsVal2 = true
                    break
                  }
                }
              }
              evalVal = existsVal2`;

const newFunc2 = `} else if (/^exists\\s*\\{/i.test(plan.whereBody.trim())) {
              const ebody2 = plan.whereBody.trim()
              const srcMatch2 = ebody2.match(/\\((\\w+)/)
              let existsVal2 = false
              if (srcMatch2 && allNodes?.length) {
                const srcVar2 = srcMatch2[1]
                const srcNode2 = ctx[srcVar2]
                if (srcNode2) {
                  const srcProps2 = srcNode2.props || srcNode2
                  const srcLabel2 = srcProps2._label || ''
                  for (const anode of allNodes) {
                    if (anode._label !== srcLabel2) continue
                    let pm2 = true
                    for (const k of Object.keys(srcProps2)) {
                      if (k.startsWith('_') || k === 'name' || k === '__edges') continue
                      if (anode[k] !== srcProps2[k]) { pm2 = false; break }
                    }
                    if (!pm2) continue
                    const anodeIdx = allNodes.indexOf(anode)
                    for (const other of allNodes) {
                      if (other.__edges && Array.isArray(other.__edges)) {
                        for (const e of other.__edges) {
                          if (e.srcIdx === anodeIdx || e.dstIdx === anodeIdx) { existsVal2 = true; break }
                        }
                        if (existsVal2) break
                      }
                    }
                    if (existsVal2) break
                  }
                }
              }
              evalVal = existsVal2`;

c = c.replace(oldFunc2, newFunc2);
console.log('F2 done');

fs.writeFileSync('src/query/query-engine.ts', c);
console.log('ALL DONE');
