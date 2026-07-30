/**
 * executor-validators.ts — 查询验证与辅助提取函数
 *
 * 从 query-executor.ts 拆分。
 */

import { parseQuery } from './query-parser'
import type { QueryPlan, QueryRow } from './query-types'

// TCK 验证用：内置函数白名单（不在正常执行路径中，仅用于 _validateUnknownFunctions）
const BUILTIN_FN_NAMES = new Set([
  'length', 'toboolean', 'tointeger', 'tofloat', 'tostring',
  'keys', 'labels', 'nodes', 'relationships', 'type',
  'id', 'properties', 'head', 'last', 'range', 'reverse', 'tail',
  'trim', 'ltrim', 'rtrim', 'upper', 'lower', 'substring', 'replace',
  'left', 'right', 'contains', 'startswith', 'endswith', 'size',
  'reverse', 'toupper', 'tolower',
  'replace', 'split', 'coalesce', 'exists', 'abs', 'ceil', 'floor',
  'round', 'sign', 'rand', 'sqrt', 'exp', 'log', 'log10',
  'sin', 'cos', 'tan', 'cot', 'asin', 'acos', 'atan', 'atan2',
  'pi', 'degrees', 'radians', 'haversin',
  'datetime', 'localtime', 'locatetime', 'time', 'date', 'localdatetime',
  'duration',
  'timestamp',
  // temporal static methods accessed via dot notation
  'fromepoch', 'fromepochmillis',
])

/** 从 Cypher 查询中提取 MATCH 子句的字符串 */
export function extractMatchClause(query: string): string {
  const match = query.match(/MATCH\s+(.*?)(?:\s+(WHERE|WITH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|INVOKE|CALL)\s|$)/is)
  return match ? match[1].trim() : ''
}

/**
 * 检测 pattern 出现在Error的位置（RETURN, WITH, SET 列中）
 * Cypher TCK: MATCH (n) RETURN (n)-[]->() 应报 UnexpectedSyntax
 */
export function _validatePatternPosition(query: string): void {
  // Pattern 语法 = `(...)-[...]-(...)` 或 `(...)-[...]->(...)` 或 `(...)<-[...]-(...)`
  // 不能与 MATCH / WHERE / CREATE / MERGE 等子句开头混淆
  const patternRE = /\([^)]*\)\s*(?:<-\s*\[[^\]]*\]\s*-|-\s*\[[^\]]*\]\s*(?:->|-)|\s*--\s*)\([^)]*\)/
  // 检测 RETURN 列中的裸 pattern（不是在函数参数中）
  const returnMatch = query.match(/RETURN\s+(.+?)(?:\s+(?:ORDER\s+BY|SKIP|LIMIT|WHERE|CREATE|MERGE|MATCH|WITH|CALL|UNWIND)\s|$)/is)
  if (returnMatch) {
    const returnBody = returnMatch[1]
    const barePattern = patternRE.exec(returnBody)
    if (barePattern) {
      const before = returnBody.substring(0, barePattern.index)
      // pattern 不在函数参数中 → 是裸 pattern
      if (!before.includes('(') || before.lastIndexOf('(') < before.lastIndexOf(')')) {
        throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
      }
    }
  }
  // 检测 WITH 列中的 pattern
  const withMatch = query.match(/WITH\s+(.+?)(?:\s+(?:WHERE|MATCH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|CALL)\s|$)/is)
  if (withMatch) {
    const withBody = withMatch[1]
    const barePattern = patternRE.exec(withBody)
    if (barePattern) {
      const before = withBody.substring(0, barePattern.index)
      if (!before.includes('(') || before.lastIndexOf('(') < before.lastIndexOf(')')) {
        throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
      }
    }
  }
  // 检测 SET 列右值中的 pattern
  const setMatch = query.match(/SET\s+(.+?)(?:\s+(?:RETURN|WITH|CREATE|MERGE|DELETE|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|CALL)\s|$)/is)
  if (setMatch) {
    const setBody = setMatch[1]
    const eqIdx = setBody.indexOf('=')
    if (eqIdx >= 0) {
      const rhs = setBody.substring(eqIdx + 1).trim()
      if (patternRE.test(rhs)) {
        throw Object.assign(new Error('SyntaxError: UnexpectedSyntax'), { tckError: 'UnexpectedSyntax' })
      }
    }
  }
}

/**
 * 检测 WHERE (n) 自我模式（InvalidArgumentType）
 * MATCH (n) WHERE (n) RETURN n → 应报错
 */
export function _validateWhereSelfPattern(query: string): void {
  const whereMatch = query.match(/WHERE\s+(.+?)(?:\s+(?:WITH|RETURN|ORDER\s+BY|SKIP|LIMIT|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|CALL)\s|$)/is)
  if (!whereMatch) return
  const whereBody = whereMatch[1].trim()
  // 检测 WHERE (n) 或 WHERE (n:Label) — 只有单个节点模式
  const selfNodePattern = /^\s*\(\s*\w+(?::\w+)?\s*\)\s*$/
  if (selfNodePattern.test(whereBody)) {
    throw Object.assign(new Error('SyntaxError: InvalidArgumentType'), { tckError: 'InvalidArgumentType' })
  }
}

/** 共享的 Cypher 关键字 + 内置函数名 Set（用于 _validateUndefinedVariables 排除误判） */
const _TCK_KEYWORDS: Set<string> = new Set([
  'AND','OR','XOR','NOT','IN','IS','NULL','TRUE','FALSE',
  'STARTS','CONTAINS','ENDS','THEN','ELSE','END','CASE','WHEN',
  'MATCH','CREATE','DELETE','SET','MERGE','REMOVE','UNWIND','RETURN','WITH',
  'ORDER','BY','SKIP','LIMIT','DISTINCT','AS','ON','WHERE',
  'DETACH','FOREACH','CALL','YIELD','SHOW','INDEX','CONSTRAINT',
  'UNION','ALL','OPTIONAL','EXISTS',
  // 已知标量/聚合/列表函数名
  'TOINTEGER','TOFLOAT','TOSTRING','TOBOOLEAN','SIZE','LENGTH','LABELS','KEYS',
  'COALESCE','HEAD','LAST','TAIL','REVERSE','RANGE',
  'LEFT','RIGHT','SUBSTRING','REPLACE','TRIM',
  'COUNT','SUM','AVG','MAX','MIN','COLLECT',
  'PERCENTILECONT','PERCENTILEDISC',
  // 数学函数
  'ABS','SQRT','CEIL','FLOOR','ROUND','SIGN','RAND',
  // 其他内置函数
  'TOUPPER','TOLOWER','ISNAN','SPLIT','TYPE','PROPERTIES','ID','ELEMENTID',
  // 时态函数
  'DATE','TIME','DATETIME','LOCALDATETIME','LOCALTIME','DURATION',
  'FROMEPOCH','FROMEPOCHMILLIS',
])

/** 检测 WHERE 子句中引用未定义变量（SyntaxError: UndefinedVariable） */
/** 从 WHERE 子句文本中去除 Pattern Comprehension 语法（只保留裸变量引用） */
export function _stripPatternPredicateSyntax(text: string): string {
  // 去掉字符串常量
  let cleaned = text.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '')
  // 反复去除所有 [...] 模式（关系模式，如 [:REL1], [r:REL], [r])
  let prev = ''
  while (prev !== cleaned) {
    prev = cleaned
    cleaned = cleaned.replace(/\[[^\[\]]*\]/g, ' ')
  }
  // 去除箭头和连接符：->, <-, -, -- 
  cleaned = cleaned.replace(/<-[ \t]*-/g, ' ').replace(/-[ \t]*->/g, ' ').replace(/--/g, ' ')
  cleaned = cleaned.replace(/<[ \t]*-/g, ' ').replace(/-[ \t]*>/g, ' ')
  // 去除节点模式 (...): 先反复去除括号内的内容，直到不包含括号
  prev = ''
  while (prev !== cleaned) {
    prev = cleaned
    cleaned = cleaned.replace(/\([^()]*\)/g, ' ')
  }
  return cleaned
}

/** 检测 WHERE 子句是否为 Pattern Comprehension（如 (n)-[]->()) */
export function _isPatternPredicate(text: string): boolean {
  const t = text.trim()
  // Pattern comprehension 以 (var) 或 (var:Label) 开头
  // 并包含关系模式连接：-[], ->, --
  if (!t.startsWith('(')) return false
  return /\([^)]*\)\s*(?:<-\s*\[|-\s*\[|-\s*\(|--)/.test(t)
}

/** Represents an embedded pattern predicate extracted from a WHERE clause. */
export type PatternPredicate = {
  fullText: string         // e.g. "(a)-[:T]->(b:TheLabel)"
  sourceVar: string        // e.g. "a"
  targetVar: string        // e.g. "b"
  edgeLabel: string | null // e.g. "T" or null for unlabelled
  targetLabel: string | null // e.g. "TheLabel" or null
  isVarLength: boolean     // true for [:T*] patterns
  direction: 'out' | 'in' | 'any' // direction of edge
  negated: boolean         // true for NOT (a)-[]->()
}

/**
 * Detects whether a WHERE expression contains embedded pattern predicates
 * (e.g. `a.id = 0 AND (a)-[:T]->(b)**`). Returns true even if mixed with AND/OR.
 */
export function _hasEmbeddedPatternPredicate(text: string): boolean {
  // Pattern: (var) followed by edge syntax
  return /\((\w+)\)\s*(?:<-\s*\[|-\s*\[|--)[^)]*->\s*\((\w+)/.test(text)
    || /\((\w+)\)\s*<-\[[^)]*\]\s*-(\w+)/.test(text)
}

/**
 * Extracts all embedded pattern predicates from a WHERE expression.
 * Returns them in order of appearance, each with a unique replacement token.
 */
export function _extractPatternPredicates(text: string): {
  patterns: PatternPredicate[]
  replacedExpr: string   // expression with patterns replaced by __PPn tokens
  tokens: Map<string, PatternPredicate>  // __PPn → pattern mapping
} {
  const patterns: PatternPredicate[] = []
  const tokens = new Map<string, PatternPredicate>()
  let replaced = text

  // Match directed patterns: (src)-[:LABEL*?]->(tgt) or (src)<-[:LABEL*?]-(tgt)
  // Match pattern predicates: (src)-[edge]->(tgt) with optional arrow directions
  // Groups: 1=NOT prefix, 2=src var, 3=left arrow (e.g. "->"), 4=edge content,
  //         5=right arrow (e.g. "->"), 6=tgt var, 7=tgt label
  const ppRegex = /([!]?NOT\s+)?\((\w+)\)\s*(<-|-)\s*\[([^\[\]]*)\]\s*(->|-)\s*\((\w+)(?::(\w+))?\)/g

  let match
  let idx = 0
  while ((match = ppRegex.exec(text)) !== null) {
    const negated = !!(match[1] && /not/i.test(match[1]))
    const sourceVar = match[2]
    const edgeLabelRaw = match[4] || ''
    const isVarLength = edgeLabelRaw.includes('*')
    const edgeLabel = edgeLabelRaw.startsWith(':') ? edgeLabelRaw.slice(1).replace(/\*$/, '') : ((edgeLabelRaw && !isVarLength) ? edgeLabelRaw : null)
    const targetVar = match[6]
    const targetLabel = match[7] || null
    const leftArrow = match[3] === '<-'
    const rightArrow = match[5] === '->'
    const direction: 'in' | 'out' | 'any' = rightArrow && !leftArrow ? 'out' : leftArrow && !rightArrow ? 'in' : 'any'

    const fullText = match[0]
    const pattern: PatternPredicate = {
      fullText,
      sourceVar,
      targetVar,
      edgeLabel,
      targetLabel,
      isVarLength,
      direction,
      negated,
    }
    patterns.push(pattern)

    const token = `__PP${idx}`
    tokens.set(token, pattern)
    replaced = replaced.replace(fullText, token)
    idx++
  }

  return { patterns, replacedExpr: replaced, tokens }
}

export function _validateUndefinedVariables(query: string, plan?: any): void {
  const whereMatch = query.match(/WHERE\s+(.+?)(?:\s+(?:WITH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|CALL)\s|$)/is)
  const matchVars = extractMatchVariables(query)
  // 也提取 CREATE/MERGE 中的变量（节点和边变量）作为已定义变量
  const createEdgeVars: string[] = [...query.matchAll(/\[(\w+)\s*(?::|])/g)].map(m => m[1]).filter(v => v && !/^[\d]/.test(v))
  const createNodeVars: string[] = [...query.matchAll(/(?:CREATE|MERGE)\s+(.*?)(?:\s+(?:SET|DELETE|MERGE|REMOVE|WITH|RETURN|UNWIND)\b|$)/gis)].flatMap(cm => {
    const clause = cm[1];
    return [...clause.matchAll(/\((\w+)\s*(?::|\))/g)].map(m => m[1]).filter(v => v && !/^[\d]/.test(v));
  })
  // 提取 CALL YIELD 定义的变量
  const callYieldVars: string[] = [...query.matchAll(/YIELD\s+(.+?)(?:\s+(?:RETURN|WITH|WHERE|CALL)\s|$)/gis)].flatMap(ym => {
    const clause = ym[1];
    return clause.split(',').map(s => s.trim()).filter(Boolean).map(s => {
      const asMatch = s.match(/^(\w+)\s+AS\s+(\w+)$/i)
      return asMatch ? asMatch[2] : s.match(/^\w+$/) ? s : ''
    }).filter(Boolean)
  })
  // 提取 WITH/UNWIND 子句中定义的变量（提前，以便 RETURN 和 WHERE 检查都能使用）
  const withVars: string[] = []
  // 方式1：从 WITH ... AS 提取
  // 用括号感知的截断，避免列表谓词/列表推导中的 WHERE 提前中断匹配
  const withMatches = query.matchAll(/\bWITH\s+(.+?)(?:\s+(?:WHERE|MATCH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|CALL)\s|$)/gis)
  for (const wm of withMatches) {
    const clauseBody = wm[1];
    // 从 clauseBody 末尾向前扫描，找到第一个不在括号内的 WHERE/MATCH 等关键字
    // 因为 clauseBody 可能包含列表谓词 all/any/none/single(...WHERE...)
    // 简单方法：如果 clauseBody 没有括号，直接处理；If any括号，用深度Trace截断
    let effectiveBody = clauseBody;
    if (/[()\[\]]/.test(clauseBody)) {
      // 括号感知截断：找到第一个不在括号内的 WHERE/MATCH/等
      // 遍历 clauseBody 字符
      let parenDepth = 0;
      let bracketDepth = 0;
      let cutoff = clauseBody.length;
      for (let i = 0; i < clauseBody.length; i++) {
        const ch = clauseBody[i];
        if (ch === '(') parenDepth++;
        else if (ch === ')') parenDepth--;
        else if (ch === '[') bracketDepth++;
        else if (ch === ']') bracketDepth--;
        else if (parenDepth === 0 && bracketDepth === 0) {
          // 不在括号内：检查是否遇到 WHERE/MATCH/RETURN 等关键字
          if (/\s+(?:WHERE|MATCH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND)\s/i.test(clauseBody.slice(i, i+20))) {
            cutoff = i;
            break;
          }
        }
        if (parenDepth < 0) parenDepth = 0; // 防御性
        if (bracketDepth < 0) bracketDepth = 0;
      }
      effectiveBody = clauseBody.slice(0, cutoff).trim();
    }
    const items = effectiveBody.split(',').map(s => s.trim())
    for (const item of items) {
      const asMatch = item.match(/\bAS\s+(\w+)\s*$/i)
      if (asMatch) withVars.push(asMatch[1])
    }
  }
  // 方式2：从整句 WITH/UNWIND 提取 AS 变量（包括子查询路径中的 WITH）
  const allAsMatches = query.matchAll(/\b(?:WITH|UNWIND)\b[^]*?\bAS\s+(\w+)/gi)
  for (const am of allAsMatches) {
    withVars.push(am[1])
  }
  // 方式3：从 MATCH p = (n)-[r]->() 提取路径变量
  const pathVars = query.matchAll(/\bMATCH\s+(\w+)\s*=/gi)
  for (const pv of pathVars) {
    withVars.push(pv[1])
  }
  // 方式4：从列表谓词 all/any/none/single(x IN ... WHERE ...) 提取迭代变量
  const listPredVars = [...query.matchAll(/\b(?:ALL|ANY|NONE|SINGLE)\s*\(\s*(\w+)\s+IN\s+/gi)].map(m => m[1])
  for (const lpv of listPredVars) {
    withVars.push(lpv)
  }
  // 检查 RETURN 列中的未定义变量（如 MATCH () RETURN foo）
  const returnMatch = query.match(/RETURN\s+(.+?)(?:\s+(?:ORDER\s+BY|SKIP|LIMIT)|$)/is)
  if (returnMatch) {
    let returnColStr = returnMatch[1]
    // 去除字符串字面量和 map/list 字面量内部的内容，只保留变量引用
    returnColStr = returnColStr.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '')
    // 反复去除 {} 和 [] 字面量以处理嵌套 {id: '0001', batters: {batter: [...]}}
    let prev = ''
    while (prev !== returnColStr) {
      prev = returnColStr
      returnColStr = returnColStr.replace(/\{[^{}]*\}/g, ' ').replace(/\[[^\[\]]*\]/g, ' ')
    }
    // 扫描所有在 RETURN 中引用但未在 MATCH 中定义的变量（排除 AS 后的别名）
    // 用 /\bAS\s+/i 分割出 AS 之前的表达式主体
    const beforeAs = returnColStr.replace(/\bAS\s+\w+\s*/ig, '').trim()
    // 提取变量名：r.num → 只保留 r（变量），num 是属性名，排除在内
    const varSet = new Set<string>()
    // 把括号/方括号等非单词字符替换为空格，去掉 . 前的空格，让 .prop 能被正确识别
    const beforeAsClean = beforeAs.replace(/[()\]\[]/g, ' ').replace(/\s+\./g, '.').trim()
    const propRefs = [...beforeAsClean.matchAll(/(\b[a-zA-Z_]\w*)\.(\w+)/g)]
    for (const pr of propRefs) {
      varSet.add(pr[1])     // r.num → 'r' 是变量
    }
    // 从 propRefs 收集所有属性名（即 .后面的词），它们不是变量
    const propNames = new Set(propRefs.map(m => m[2]))
    // 也提取裸变量名（如 RETURN foo 中的 foo）
    // 移除 list predicate 模式 ALL(x IN ... WHERE cond)、ANY(...)、NONE(...)、SINGLE(...)
    // 使用平衡括号匹配
    let cleanedBeforeAs = beforeAs;
    const listPredRe = /\b(ALL|ANY|NONE|SINGLE)\s*\(/gi;
    let predMatch: RegExpExecArray | null;
    const parts: string[] = [];
    let lastIdx = 0;
    const predStarts: Array<{ start: number; end: number }> = [];
    while ((predMatch = listPredRe.exec(cleanedBeforeAs)) !== null) {
      const start = predMatch.index;
      let depth = 1;
      let i = predMatch.index + predMatch[0].length;
      while (i < cleanedBeforeAs.length && depth > 0) {
        if (cleanedBeforeAs[i] === '(') depth++;
        else if (cleanedBeforeAs[i] === ')') depth--;
        if (depth === 0) break;
        i++;
      }
      if (depth === 0) {
        predStarts.push({ start, end: i + 1 });
      }
    }
    if (predStarts.length > 0) {
      for (const { start, end } of predStarts) {
        parts.push(cleanedBeforeAs.slice(lastIdx, start));
        lastIdx = end;
      }
      parts.push(cleanedBeforeAs.slice(lastIdx));
      cleanedBeforeAs = parts.join(' ');
    }
    // 去掉反引号标识符：`name` → 'name'（使反引号内的标识符不作为裸变量被提取）
    cleanedBeforeAs = cleanedBeforeAs.replace(/`[^`]*`/g, "''")
    const bareVars = [...cleanedBeforeAs.matchAll(/\b([a-zA-Z_]\w*)\b/g)].map(m => m[1])
    for (const v of bareVars) {
      // 排除数字、关键字、函数名
      if (/^\d/.test(v)) continue
      if (_TCK_KEYWORDS.has(v.toUpperCase())) continue
      // 排除 AS 别名
      const aliasNames = [...beforeAs.matchAll(/\bAS\s+(\w+)/gi)].map(m => m[1])
      if (aliasNames.includes(v)) continue
      // 排除属性名（.name 中的 name 不是变量）
      if (propNames.has(v)) continue
      varSet.add(v)
    }
    // AS xxx 中的 xxx 可能也在 varNames 中，保留为别名
    const aliasNames = [...beforeAs.matchAll(/\bAS\s+(\w+)/gi)].map(m => m[1])
    for (const an of aliasNames) varSet.add(an)
    const varIdents = [...varSet]
    if (matchVars.length === 0 && varIdents.length > 0) {
      for (const v of varIdents) {
        const vu = v.toUpperCase()
        if (_TCK_KEYWORDS.has(vu)) continue
        // 检查是否在 MATCH、WITH 变量、CREATE 边变量、CREATE 节点变量中定义
        const allDefinedVars = [...matchVars, ...withVars, ...createEdgeVars, ...createNodeVars, ...callYieldVars]
        if (!allDefinedVars.includes(v)) {
          // 额外检查：如果 v 看起来是属性访问（有小数点），跳过
          if (v.includes('.') && allDefinedVars.includes(v.split('.')[0])) continue
          // 额外检查：参数变量（$xxx）不需要在查询中定义
          if (v.startsWith('$')) continue
          throw Object.assign(new Error('SyntaxError: UndefinedVariable'), { tckError: 'UndefinedVariable' })
        }
      }
    }
  }
  if (whereMatch && matchVars.length === 0) return
  const whereBody = whereMatch ? whereMatch[1] : ''
  // 如果 whereBody 以 ") AS alias" 结尾，剥离后缀（list predicate 的结束括号被误捕获）
  const whereClean = whereBody.replace(/\)\s*AS\s+\w+\s*$/i, '').trim()
  // 合并 MATCH 变量和 WITH 变量
  const definedVars = [...new Set([...matchVars, ...withVars, ...callYieldVars])]
  // 去掉字符串常量（替换为空格，避免字符串内容被当作变量名）
  let cleaned = whereClean
    .replace(/'[^']*'/g, ' ')
    .replace(/"[^"]*"/g, ' ')
  // 压缩多余空格
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim()
  // 去掉属性访问（x.y 格式）
  cleaned = cleaned.split(/\s+/).filter(word => !word.includes('.')).join(' ')
  // 去掉标签谓词模式：var:Label 或 var:Label1:Label2（冒号后的标签名不是变量引用）
  cleaned = cleaned.replace(/(\b[a-zA-Z_]\w*)(?::[a-zA-Z_]\w*)+(?!\w)/g, '$1')
  // 去掉函数调用参数：type(r), exists(n.name) 等中的参数是变量引用，已在 MATCH 中定义
  // 保留函数名 (type, exists 等在内置函数列表中)，去掉括号内的参数
  cleaned = cleaned.replace(/\b[a-zA-Z_]\w*\s*\(([^()]*)\)/g, (m, args) => {
    // 如果函数名在内置函数列表中，把参数中的变量引用去掉（它们是表达式参数，不是新变量定义）
    const funcName = m.match(/^\w+/)?.[0]?.toLowerCase() || ''
    if (_TCK_KEYWORDS.has(funcName.toUpperCase())) return ' '
    // 否则保留原字符串（可能是谓词等）
    return ' '
  })
  // 去掉 Pattern Comprehension 语法（(n)-[:REL]->() 中的 `REL` 不是变量)
  cleaned = _stripPatternPredicateSyntax(cleaned)
  // 提取裸标识符
  const idents = cleaned.match(/\b([a-zA-Z_]\w*)\b/g) || []
  for (const v of idents) {
    const vu = v.toUpperCase()
    if (_TCK_KEYWORDS.has(vu)) continue
    if (/^\d/.test(v)) continue
    if (!definedVars.includes(v) && !definedVars.includes(vu)) {
      throw Object.assign(new Error('SyntaxError: UndefinedVariable'), { tckError: 'UndefinedVariable' })
    }
  }
}

/** 验证 RETURN 列中的函数是已知的（SyntaxError: UnknownFunction） */
export function _validateUnknownFunctions(query: string): void {
  // 提取 RETURN 子句
  const returnMatch = query.match(/RETURN\s+((?:(?!\s+(?:ORDER\s+BY|SKIP|LIMIT|WHERE|CREATE|MERGE|MATCH|WITH|CALL|UNWIND)).)+)/is)
  if (!returnMatch) return
  const returnStr = returnMatch[1]
  // 跳过 temporal 静态方法调用（date.truncate(), datetime.fromepoch() 等），
  // 这些函数名由运行时 dispatch 解析，编译期无法穷举
  if (/^(date|datetime|time|localtime|localdatetime|duration)\(/i.test(returnStr.trim())) return
  // 匹配 functionName(args) 模式
  const fnPattern = /\b(\w+)\s*\(/g
  let fnMatch: RegExpExecArray | null
  while ((fnMatch = fnPattern.exec(returnStr)) !== null) {
    const fnName = fnMatch[1].toLowerCase()
    // 跳过点号调用（datetime.truncate(x) → truncate 被 datetime. 前缀修饰）
    const beforeFn = returnStr.slice(Math.max(0, fnMatch.index - 1), fnMatch.index)
    if (beforeFn === '.') continue
    // 跳过已定义的函数和关键字
    if (BUILTIN_FN_NAMES.has(fnName)) continue
    if (['and','or','xor','not','in','is','null','true','false','distinct',
        'all','any','none','single','case','when','then','else','end',
        'count','sum','avg','max','min','collect'].includes(fnName)) continue
    if (!BUILTIN_FN_NAMES.has(fnName)) {
      throw Object.assign(new Error('SyntaxError: UnknownFunction'), { tckError: 'UnknownFunction' })
    }
  }
}

/** 从查询文本中提取 RETURN 列中的边属性访问（如 r.num 表示边变量 r 的属性 num） */
export function extractEdgePropColumnsFromQuery(query: string): string[] {
  const edgeVars: string[] = []
  // 从 MATCH 子句中提取边变量
  const matchClause = query.match(/MATCH\s+(.*?)(?:\s+(?:WHERE|WITH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|INVOKE|CALL)\s|$)/is)
  if (matchClause) {
    const edgeVarMatches = matchClause[1].matchAll(/\[(\w+)\s*(?::|\]|\))/g)
    for (const m of edgeVarMatches) {
      if (m[1] && !/^[\d]/.test(m[1])) edgeVars.push(m[1])
    }
  }
  // 从 RETURN 列中提取 var.prop 模式
  const returnMatch = query.match(/RETURN\s+(.+?)(?:\s+(?:ORDER\s+BY|SKIP|LIMIT)|$)/is)
  if (!returnMatch) return []
  const returnCols = returnMatch[1].split(',').map(s => s.trim())
  const cols: string[] = []
  for (const col of returnCols) {
    const propMatch = col.match(/^(\w+)\.(\w+)$/)
    if (propMatch && edgeVars.includes(propMatch[1])) {
      cols.push(propMatch[1])
    }
  }
  return cols
}

/** 从查询文本中提取所有 MATCH 中绑定的变量名 */
export function extractMatchVariables(query: string): string[] {
  const vars: string[] = []
  // 提取 MATCH 子句中的所有括号模式中的变量
  if (!query) return vars
  const matches = query.matchAll(/MATCH\s+(.*?)(?:\s+(?:WHERE|WITH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|INVOKE|CALL)\s|$)/gis)
  for (const m of matches) {
    const clause = m[1]
    // 从 (n:Label), (n) 或 (n {prop: val}) 中提取变量名
    const nodeVars = clause.matchAll(/\((\w+)\s*(?::|\)|{)/g)
    for (const v of nodeVars) {
      if (v[1] && !/^[\d]/.test(v[1])) vars.push(v[1])
    }
    // 从 <-[r]- 或 -[r]-> 或 [r:T] 中提取边变量
    const edgeVars = clause.matchAll(/\[(\w+)\s*(?::|\]|\))/g)
    for (const v of edgeVars) {
      if (v[1] && !/^[\d]/.test(v[1])) vars.push(v[1])
    }
  }
  return [...new Set(vars)]
}

/** 从查询文本中提取所有引用过的变量名 */
export function extractVariablesFromQuery(query: string): string[] {
  const vars: string[] = []
  const allNodes = query.matchAll(/\((\w+)\s*(?::|\)|{)/g)
  for (const v of allNodes) {
    if (v[1] && !/^[\d]/.test(v[1])) vars.push(v[1])
  }
  const allEdges = query.matchAll(/\[(\w+)\s*(?::|\]|\))/g)
  for (const v of allEdges) {
    if (v[1] && !/^[\d]/.test(v[1])) vars.push(v[1])
  }
  return [...new Set(vars)]
}

/** 从一段 Cypher 子句文本中提取变量名 */
export function extractVariablesFromClause(clause: string): string[] {
  const vars: string[] = []
  const nodes = clause.matchAll(/\((\w+)\s*(?::|\)|{)/g)
  for (const v of nodes) {
    if (v[1] && !/^[\d]/.test(v[1])) vars.push(v[1])
  }
  const edges = clause.matchAll(/\[(\w+)\s*(?::|\]|\))/g)
  for (const v of edges) {
    if (v[1] && !/^[\d]/.test(v[1])) vars.push(v[1])
  }
  return [...new Set(vars)]
}

/** 调整后的无效查询检测：排除有效的 CREATE/ADMIN/UNION/CALL
 * 该函数在 _executeViaGraphEngine 之前 intercept 纯无效查询 */
export function _isInvalidPlan(plan: QueryPlan): boolean {
  return !plan.scanLabel && plan.steps?.length === 0 && plan.filters?.length === 0
    && plan.returnColumns?.length === 0 && !plan.hasMatch && !plan.createNodes?.length
    && !plan.create && !plan.show && !plan.with && !plan.unwind && !plan.unwinds?.length && !plan.unionType
    && !plan.caseColumns?.length && !plan.createConstraint && !plan.deleteEntities?.length
    && !plan.setItems?.length && !plan.removeItems?.length && !plan.mergeItems?.length
}

/**
 * 从 nodes 的 __edges 数组中提取边列表。
 * __edges 格式: [{srcIdx: 0, dstIdx: 1, label: 'T1'}, ...]
 */
export function extractEdgesFromNodes(nodes: Array<Record<string, unknown>>): Array<{ srcIdx: number; dstIdx: number; label: string; props?: Record<string, unknown> | null }> {
  const edges: Array<{ srcIdx: number; dstIdx: number; label: string; props?: Record<string, unknown> | null }> = []
  for (const n of nodes) {
    if (n.__edges && Array.isArray(n.__edges)) {
      for (const e of n.__edges) {
        // [CVE-H5]: TCK 中边索引可能以字符串形式传递（如 '"0"'），原实现只检查 === 'number' 导致静默丢弃。
        // 现改用 Number() 转换，既兼容 number 也兼容 string 格式。
        const srcIdx = typeof e.srcIdx === 'number' ? e.srcIdx : Number(e.srcIdx)
        const dstIdx = typeof e.dstIdx === 'number' ? e.dstIdx : Number(e.dstIdx)
        if (!isNaN(srcIdx) && !isNaN(dstIdx)) {
          edges.push({ srcIdx, dstIdx, label: String(e.label || ''), props: e.props || null })
        }
      }
    }
  }
  return edges
}


