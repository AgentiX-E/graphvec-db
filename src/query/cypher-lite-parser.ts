/**
 * cypher-lite-parser.ts — Parser 桥接层
 *
 * 支持 Peggy（遗留）和 ANTLR（新）两种解析器。
 * 通过环境变量 ANTLR_PARSE=true 启用 ANTLR。
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const peggy = require('./cypher-lite-parser-gen.js')

import { parseCypherToPlan } from './ast-to-plan-v2'
import type { QueryPlan } from './ast-to-plan-v2'

export const useAntlr = typeof process !== 'undefined' && process.env?.ANTLR_PARSE === 'true'

// parser.parse 返回 PEG 格式的 AST（供 query-engine 内部使用）
// ANTLR 模式下仍使用 PEG 的 provider.parse 方式（parse()保持PEG输出）
// 外部调用方通过 toPlan() 获得 QueryPlan
export const parser = {
  parse(input: string): any {
    return peggy.parse(input)
  },
}

export { parseCypherToPlan as parseCypherAntlr }

/**
 * 获取 QueryPlan，根据 ANTLR_PARSE 选择解析器。
 * 这是 parseQuery 的替代入口。
 */
export function toPlan(query: string): any {
  if (!useAntlr) {
    return parseLegacy(query)
  }

  try {
    return parseCypherToPlan(query.trim())
  } catch (antlrErr) {
    console.warn('[ANTLR] parse failed, falling back to PEG:', (antlrErr as Error).message?.slice(0, 100))
    return parseLegacy(query)
  }
}

function parseLegacy(query: string): any {
  return peggy.parse(query)
}
