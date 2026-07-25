with open('src/query/query-executor.ts') as f:
    e = f.read()

old = "const _sgHasComma = plan.steps?.length > 1 && plan.steps.some(\n              (s: any, si: number) => si > 0 && s.source !== plan.steps![si - 1].targetAlias\n            )"

# Include both source gap and alias reuse detection
new = """const _sgHasComma = plan.steps?.length > 1 && plan.steps.some(
              (s: any, si: number) => {
                if (si === 0) return false
                // Step source doesn't chain from previous step's target
                if (s.source !== plan.steps![si - 1].targetAlias) return true
                // Same targetAlias reused (comma-separated pattern re-binding)
                for (let pj = 0; pj < si; pj++) {
                  if (plan.steps![pj].targetAlias === s.targetAlias && s.targetAlias) return true
                }
                return false
              }
            )"""

if old in e:
    e = e.replace(old, new)
    print('replaced')
else:
    print('NOT FOUND:')
    idx = e.find('const _sgHasComma')
    if idx >= 0:
        print(e[idx:idx+200])

with open('src/query/query-executor.ts', 'w') as f:
    f.write(e)
