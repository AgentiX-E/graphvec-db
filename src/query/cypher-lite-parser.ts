/**
 * cypher-lite-parser.ts — Wrapper for the Peggy-generated parser
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const peggy = require('./cypher-lite-parser-gen.js')

export const parser = {
  parse(input: string): any {
    return peggy.parse(input)
  },
}
