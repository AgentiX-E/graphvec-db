// Minimal type declarations for the ANTLR4 runtime and the generated Cypher
// grammar module, neither of which ships its own TypeScript declarations.
// Only the members actually used by src/query/ast-to-plan-v2.ts are declared.

declare module 'antlr4' {
  export class InputStream {
    constructor(data: string | Uint8Array)
    readonly size: number
    readonly index: number
  }

  export class CommonTokenStream {
    constructor(lexer: unknown)
    fill(): void
  }

  const antlr4: {
    InputStream: typeof InputStream
    CommonTokenStream: typeof CommonTokenStream
  }
  export default antlr4
}

declare module '@neo4j-cypher/antlr4' {
  export class CypherLexer {
    constructor(input: unknown)
  }
  export class CypherParser {
    constructor(input: unknown)
    buildParseTrees: boolean
    cypher(): unknown
  }
  export class CypherListener {
    constructor()
  }
}
