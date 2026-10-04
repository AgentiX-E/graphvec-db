import { default as antlr4 } from 'antlr4'
import { CypherLexer, CypherParser } from '@neo4j-cypher/antlr4'

function findAll(ctx: any, name: string): any[] {
  const out: any[] = []
  function walk(n: any) {
    if (!n) return
    if (n.constructor && n.constructor.name === name) out.push(n)
    if (n.children) for (const c of n.children) walk(c)
  }
  walk(ctx)
  return out
}

async function main() {
  for (const text of ['(dur2:DurTwo)', '(dur2: DurTwo)']) {
    const q = `MATCH ${text} RETURN 1`
    const is = new antlr4.InputStream(q)
    const lexer = new CypherLexer(is)
    const tokens = new antlr4.CommonTokenStream(lexer)
    const parser = new CypherParser(tokens)
    parser.buildParseTrees = true
    const tree = parser.cypher()
    const labels = findAll(tree, 'NodeLabelContext')
    console.log('=== text:', JSON.stringify(text))
    for (const l of labels) {
      console.log('  NodeLabel getText()=', JSON.stringify(typeof l.getText === 'function' ? l.getText() : '(no getText)'))
      const syms = findAll(l, 'SymbolicNameContext')
      for (const s of syms) {
        console.log('    SymbolicName getText()=', JSON.stringify(typeof s.getText === 'function' ? s.getText() : '(none)'), 'getSymbol=', s.getSymbol ? JSON.stringify(s.getSymbol().text) : '(none)')
      }
    }
  }
}
main().catch(e => console.error('ERR', e))
