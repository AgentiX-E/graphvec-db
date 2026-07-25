import { parseCypherToPlan } from '../src/query/ast-to-plan-v2'
import { findChild, findAllChildren, findSymbolicName } from '../src/query/parser-helpers'

// Crawl the parser directly
import { getParser, parseCypher } from '../src/query/query-parser'
const result = parseCypher("MATCH (a)--(b)--(c)--(d)--(a), (b)--(d) WHERE a.id=1 AND c.id=2 RETURN d")
const ctx = (result as any).ctx

const matches = findAllChildren(ctx, 'MatchClauseContext')
for (const m of matches) {
  const np = findAllChildren(m, 'NodePatternContext')
  console.log('nodePatterns count:', np.length)
  for (let i = 0; i < np.length; i++) {
    const v = findSymbolicName(findChild(np[i], 'VariableContext'))
    console.log(`  nodePattern[${i}]: var="${v}" text="${np[i].getText()}"`)
  }
  const chains = findAllChildren(m, 'PatternElementChainContext')
  console.log('chains count:', chains.length)
  for (let i = 0; i < chains.length; i++) {
    console.log(`  chain[${i}]: text="${chains[i].getText()}"`)
  }
}
