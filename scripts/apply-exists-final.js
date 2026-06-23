const fs = require('fs');
let c = fs.readFileSync('src/query/query-engine.ts', 'utf8');

// ===== 1. EXISTS keyword in _TCK_KEYWORDS =====
// Find the line with 'UNION','ALL','OPTIONAL', and replace it
c = c.replace(
  "'UNION','ALL','OPTIONAL',",
  "'UNION','ALL','OPTIONAL','EXISTS',"
);
console.log('1. EXISTS keyword added');

// ===== 2. __edges init in allNodes copy =====
// Find the anchor comment
c = c.replace(
  "    // 确保多标签节点有 __fullLabel 属性（传入的 nodes 可能没有）",
  "    // 确保多标签节点有 __fullLabel 属性（传入的 nodes 可能没有）\n    // 确保 __edges 存在（EXISTS 子查询需要）\n    for (const node of allNodes) {\n      if (!(node as any).__edges) (node as any).__edges = []\n    }"
);
console.log('2. __edges init added');

// ===== 3. EXISTS branch in first WHERE filter (GE path) =====
// Pattern: pattern pred block ends with evalVal = isNegated ? false : true
const firstPatternBlock = `        } else if (/^exists\s*\{/i.test(plan.whereBody.trim())) {
          // EXISTS { ... } 子查询
          const ebody = plan.whereBody.trim()
          const srcMatch = ebody.match(/\((\w+)/)
          let existsVal = false
          if (srcMatch && allNodes?.length) {
            const srcVar = srcMatch[1]
            const srcNodeRef = ctx[srcVar]
            if (srcNodeRef) {
              const srcLabel = (srcNodeRef.props || srcNodeRef)._label || ''
              const labelMatch = ebody.match(/\[:(\w+)\]/)
              const edgeLabel = labelMatch ? labelMatch[1] : null
              for (const anode of allNodes) {
                if (anode._label !== srcLabel) continue
                const anodeIdx = allNodes.indexOf(anode)
                // 检查 anode 自身的 __edges
                if (anode.__edges && Array.isArray(anode.__edges)) {
                  for (const e of anode.__edges) {
                    if (edgeLabel && e.label !== edgeLabel) continue
                    existsVal = true; break
                  }
                }
                // 也检查其他节点的 __edges 中引用此节点的边
                if (!existsVal) {
                  for (const other of allNodes) {
                    if (other.__edges) {
                      for (const e of other.__edges) {
                        if (e.srcIdx === anodeIdx || e.dstIdx === anodeIdx) {
                          if (edgeLabel && e.label !== edgeLabel) continue
                          existsVal = true; break
                        }
                      }
                      if (existsVal) break
                    }
                  }
                }
                if (existsVal) break
              }
            }
          }
          const isNegatedExists = /^not\s+exists/i.test(ebody)
          evalVal = isNegatedExists ? !existsVal : existsVal`;

// Insert after: evalVal = isNegated ? false : true
// Pattern:        } else {
// where _isPatternPredicate chain ends
// Find "evalVal = isNegated ? false : true" → then find next "} else {"
const firstPP = c.indexOf('evalVal = isNegated ? false : true');
const firstElse = c.indexOf('} else {', firstPP);
c = c.substring(0, firstElse) + firstPatternBlock + '\n        ' + c.substring(firstElse);
console.log('3. First EXISTS filter added');

// ===== 4. EXISTS branch in second WHERE filter (WITH pipeline) =====
const secondPP = c.indexOf('evalVal = isNegated ? false : true', firstElse + 10);
if (secondPP > 0) {
  const secondElse = c.indexOf('} else {', secondPP);
  const patternBlock2 = `} else if (/^exists\s*\{/i.test(plan.whereBody.trim())) {
              const ebody2 = plan.whereBody.trim()
              const srcMatch2 = ebody2.match(/\((\w+)/)
              let existsVal2 = false
              if (srcMatch2 && allNodes?.length) {
                const srcVar2 = srcMatch2[1]
                const srcNodeRef2 = ctx[srcVar2]
                if (srcNodeRef2) {
                  const srcLabel2 = (srcNodeRef2.props || srcNodeRef2)._label || ''
                  const labelMatch2 = ebody2.match(/\[:(\w+)\]/)
                  const edgeLabel2 = labelMatch2 ? labelMatch2[1] : null
                  for (const anode of allNodes) {
                    if (anode._label !== srcLabel2) continue
                    const anodeIdx2 = allNodes.indexOf(anode)
                    if (anode.__edges && Array.isArray(anode.__edges)) {
                      for (const e of anode.__edges) {
                        if (edgeLabel2 && e.label !== edgeLabel2) continue
                        existsVal2 = true; break
                      }
                    }
                    if (!existsVal2) {
                      for (const other of allNodes) {
                        if (other.__edges) {
                          for (const e of other.__edges) {
                            if (e.srcIdx === anodeIdx2 || e.dstIdx === anodeIdx2) {
                              if (edgeLabel2 && e.label !== edgeLabel2) continue
                              existsVal2 = true; break
                            }
                          }
                          if (existsVal2) break
                        }
                      }
                    }
                    if (existsVal2) break
                  }
                }
              }
              evalVal = existsVal2`;

  c = c.substring(0, secondElse) + patternBlock2 + '\n            ' + c.substring(secondElse);
  console.log('4. Second EXISTS filter added');
} else {
  console.log('4. Second EXISTS NOT FOUND');
}

// ===== 5. Fix Having executed split logic in step-definitions =====
const sd = fs.readFileSync('src/query/cypher-tck/step-definitions.ts', 'utf8');
let sd_updated = sd.replace(
  `  const q = query.trim()
  // 支持多语句：按行分割，逐条执行
  const lines = q.split('\\n').map(s => s.trim()).filter(Boolean)
  if (lines.length > 1) {`,
  `  const q = query.trim()
  // 支持多语句：按行分割，逐条执行。
  // 改进：合并以逗号结尾的行（多行 CREATE 链不被切碎）
  const rawLines = q.split('\\n').map(s => s.trim()).filter(Boolean)
  const lines: string[] = []
  let pending = ''
  for (const line of rawLines) {
    if (pending) {
      pending += '\\n' + line
      if (!line.endsWith(',')) { lines.push(pending); pending = '' }
    } else {
      if (line.endsWith(',')) { pending = line }
      else { lines.push(line) }
    }
  }
  if (pending) lines.push(pending)
  if (lines.length > 1) {`
);
fs.writeFileSync('src/query/cypher-tck/step-definitions.ts', sd_updated);
console.log('5. Having executed split logic fixed');

fs.writeFileSync('src/query/query-engine.ts', c);
console.log('ALL DONE');
