#!/usr/bin/env python3
import sys, re

with open(sys.argv[1], 'r') as f:
    content = f.read()

# The target block to replace:
old_block = """  // ── WITH WHERE 过滤 ──
  // WITH ... WHERE 的过滤在 parseQuery 中没有被提取到 filters。
  // 从原始 query 文本提取 WHERE 子句，用表达式引擎逐行过滤。
  if (query && !plan.aggregate && rows.length > 1) {
    const withWhereMatch = query.match(/\\bWHERE\\s+(.+?)(?:\\s+(?:RETURN|WITH|CREATE|MERGE|SET|DELETE|ORDER\\s+BY|SKIP|LIMIT)\\s|$)/is)
    if (withWhereMatch && !withWhereMatch[1].includes('[')) {
      // 有 MATCH 的 WHERE 由 MATCH 路径处理（hasMatch=true），只有无 MATCH 的 WITH WHERE 才在此处理
      if (!plan.hasMatch) {
        const whereExpr = withWhereMatch[1].trim()
        // 过滤：避免与 MATCH+WHERE 的 GE post-filter 重复（它只在 hasMatch 时执行）
        rows = rows.filter(row => {
          const val = _evaluateExpression(whereExpr, row)
          return val === true
        })
      }
    }
  }"""

new_block = """  // ── WITH WHERE 过滤 ──
  // WITH ... WHERE 的过滤在 parseQuery 中没有被提取到 filters。
  // 从原始 query 文本提取 WHERE 子句，用表达式引擎逐行过滤。
  if (query && !plan.aggregate && rows.length > 1) {
    // 对于多级 WITH，提取最后一个 WITH 的 WHERE
    // 优先级：最后一个 WITH 的 WHERE > 全局 WHERE
    let lastWhereText = ''
    if (plan.unwind && query.toLowerCase().includes('with')) {
      const withParts = query.split(/\\bWITH\\s+/i).filter(Boolean)
      if (withParts.length > 1) {
        const lastWith = withParts[withParts.length - 1]
        const whereMatch = lastWith.match(/\\bWHERE\\s+(.+?)(?:\\s+(?:RETURN|WITH|CREATE|MERGE|SET|DELETE|ORDER\\s+BY|SKIP|LIMIT)\\s|$)/is)
        if (whereMatch) lastWhereText = whereMatch[1].trim()
      }
    }
    // 无多级 WITH 时 Fallback：全局第一个 WHERE
    const globalWhereMatch = !lastWhereText ? query.match(/\\bWHERE\\s+(.+?)(?:\\s+(?:RETURN|WITH|CREATE|MERGE|SET|DELETE|ORDER\\s+BY|SKIP|LIMIT)\\s|$)/is) : null
    const whereText = lastWhereText || (globalWhereMatch && !globalWhereMatch[1].includes('[') ? globalWhereMatch[1].trim() : '')
    if (whereText) {
      rows = rows.filter(row => {
        const val = _evaluateExpression(whereText, row)
        return val === true
      })
    }
  }"""

if old_block in content:
    content = content.replace(old_block, new_block)
    with open(sys.argv[1], 'w') as f:
        f.write(content)
    print("Replaced successfully")
else:
    print("ERROR: old_block not found!")
    # Debug: find similar text
    idx = content.find('WITH WHERE 过滤')
    if idx >= 0:
        print(f"Found at {idx}: {content[idx:idx+200]}")
