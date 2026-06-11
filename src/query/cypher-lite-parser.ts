/**
 * cypher-lite-parser.ts — Parser 桥接层
 *
 * 同时支持 Peggy（遗留）和 ANTLR（新）两种解析器。
 * 优先级：ANTLR → PEG fallback
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const peggy = require('./cypher-lite-parser-gen.js')

import { parseCypherToPlan } from './ast-to-plan-v2'
import type { QueryPlan } from './ast-to-plan-v2'

export const parser = {
  parse(input: string): any {
    return peggy.parse(input)
  },
}

export { parseCypherToPlan as parseCypherAntlr }

/**
 * 解析 Cypher 查询。
 * 优先使用 ANTLR parser（更快、更稳定），失败时 fallback 到 PEG。
 *
 * @param useAntlr 设为 true 强制使用 ANTLR（默认为 false 向后兼容）
 */
let _preferAntlr = false

export function setPreferAntlr(value: boolean) {
  _preferAntlr = value
}

export function isAntlrPreferred(): boolean {
  return _preferAntlr
}

/**
 * 获取当前 QueryPlan。
 * 根据 _preferAntlr 状态选择解析器。
 */
export function toPlan(query: string): any {
  if (!_preferAntlr) {
    return parseLegacy(query)
  }

  try {
    return parseCypherToPlan(query)
  } catch (antlrErr) {
    // ANTLR 失败时 fallback 到 PEG
    console.warn('[ANTLR] parse failed, falling back to PEG:', (antlrErr as Error).message?.slice(0, 100))
    return parseLegacy(query)
  }
}

function parseLegacy(query: string): any {
  return peggy.parse(query)
}
