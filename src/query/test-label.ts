// Test NodeLabel labeling for multi-label MATCH
import { parseQuery } from './query-engine'
import { parseCypherToPlan } from './ast-to-plan-v2'
import antlr4 from 'antlr4'

// Direct parse to see ANTLR structure
const input = "MATCH (a:A:B) RETURN a"
const parsed = parseCypherToPlan(input)
console.log("parseCypherToPlan result:")
console.log("  scanLabel:", parsed.scanLabel)
console.log("  labelExpr:", JSON.stringify(parsed.labelExpr))

// Try extracting label from nodeLabel context using ANTLR parse tree
const CypherLexer = (antlr4 as any).require?.('./src/query/antlr/CypherLexer') || require('./antlr/CypherLexer')
const CypherParser = (antlr4 as any).require?.('./src/query/antlr/CypherParser') || require('./antlr/CypherParser')

console.log("\nCypherParser rules:", CypherParser.ruleNames?.slice(0, 20))
