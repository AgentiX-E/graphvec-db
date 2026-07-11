/**
 * repl.ts — Interactive Cypher Shell for AgentiX GraphVec
 *
 * Features:
 * - readline-based interactive shell
 * - Multi-line input (; terminates statement)
 * - Built-in commands (:exit, :help, :schema, :clear)
 * - Cypher query execution via GraphEngine
 * - Pretty-printed output (console.table / JSON)
 *
 * Usage:
 *   node --loader ts-node/esm src/cli/repl.ts
 *   npx ts-node src/cli/repl.ts
 */

import { GraphEngine } from '../core/graph-engine'
import * as readline from 'readline'

// ──────────────────────────────────────────
// Types
// ──────────────────────────────────────────

export interface ReplContext {
  engine: GraphEngine
  verbose: boolean
}

export interface QueryResult {
  columns: string[]
  rows: Record<string, unknown>[]
  count: number
}

export type ReplCommand =
  | { type: 'exit' }
  | { type: 'help' }
  | { type: 'schema' }
  | { type: 'clear' }
  | { type: 'cypher'; query: string }

// ──────────────────────────────────────────
// 解析 : 命令
// ──────────────────────────────────────────

export function parseCommand(line: string): ReplCommand {
  const trimmed = line.trim()

  if (trimmed === ':exit' || trimmed === ':quit') {
    return { type: 'exit' }
  }
  if (trimmed === ':help') {
    return { type: 'help' }
  }
  if (trimmed === ':schema') {
    return { type: 'schema' }
  }
  if (trimmed === ':clear') {
    return { type: 'clear' }
  }

  return { type: 'cypher', query: trimmed }
}

// ──────────────────────────────────────────
// 执行查询
// ──────────────────────────────────────────

export function executeQuery(engine: GraphEngine, query: string): QueryResult {
  if (!query || query.trim().length === 0) {
    return { columns: [], rows: [], count: 0 }
  }

  const results = engine.query(query)

  if (!results || results.length === 0) {
    return { columns: [], rows: [], count: 0 }
  }

  // 收集所有字段作为列
  const columns = new Set<string>()
  columns.add('id')
  columns.add('type')
  columns.add('name')
  for (const row of results) {
    if (row.props) {
      for (const key of Object.keys(row.props)) {
        columns.add(key)
      }
    }
  }
  const colOrder = Array.from(columns)

  const rows = results.map(node => {
    const row: Record<string, unknown> = {}
    row['(id)'] = node.id
    row['(type)'] = node.type
    row['(name)'] = node.name
    if (node.props) {
      for (const key of Object.keys(node.props)) {
        row[key] = node.props[key]
      }
    }
    return row
  })

  return { columns: colOrder, rows, count: results.length }
}

// ──────────────────────────────────────────
// 格式化输出
// ──────────────────────────────────────────

export function printResult(result: QueryResult): void {
  if (result.count === 0) {
    console.log('(empty result)')
    return
  }

  if (result.rows.length <= 50) {
    console.table(result.rows)
  } else {
    // 打印前 50 行
    console.table(result.rows.slice(0, 50))
    console.log(`... and ${result.rows.length - 50} more rows`)
  }

  console.log(`\n(${result.count} rows)\n`)
}

// ──────────────────────────────────────────
// Schema 显示
// ──────────────────────────────────────────

export function displaySchema(ctx: ReplContext, log: (msg: string) => void = console.log): void {
  const { engine } = ctx
  const stats = engine.stats()

  log('=== Graph Schema ===')
  log(`Nodes: ${stats.nodeCount}`)
  log(`Edges: ${stats.edgeCount}`)

  // 从 label engine 获取类型Info
  const nodeIds = engine.scanAllNodes()
  const typeSet = new Set<number>()
  for (const node of nodeIds) {
    typeSet.add(node.type)
  }
  if (typeSet.size > 0) {
    log('\nNode Types:')
    for (const type of typeSet) {
      log(`  - Type ${type}: ${engine.findNodesByType(type).length} nodes`)
    }
  }

  // 尝试获取边类型（通过扫描节点边的类型）
  const edgeTypes = new Set<number>()
  for (const node of nodeIds.slice(0, 200)) {  // 限制样本量
    const result = engine.neighbors ? engine.neighbors(node.id) : { edges: [] }
    for (const entry of result.edges) {
      edgeTypes.add(entry.type)
    }
  }
  if (edgeTypes.size > 0) {
    log('\nEdge Types:')
    for (const type of edgeTypes) {
      log(`  - Type ${type}`)
    }
  }

  log('\n' + '='.repeat(30))
}

// ──────────────────────────────────────────
// 帮助Info
// ──────────────────────────────────────────

export function displayHelp(ctx: ReplContext, log: (msg: string) => void = console.log): void {
  log('')
  log('AgentiX Cypher Shell')
  log(''.repeat(40))
  log('')
  log('Commands:')
  log('  :exit, :quit    Exit the shell')
  log('  :help           Show this help message')
  log('  :schema         Display graph schema (labels, edge types)')
  log('  :clear          Clear the screen')
  log('')
  log('Cypher Queries:')
  log('  MATCH (n) RETURN n')
  log('  MATCH (n) WHERE n.prop = value RETURN n')
  log('  MATCH (n)-[r]->(m) RETURN n, r, m')
  log('')
  log('  End your statement with ; to execute.')
  log('  Press Ctrl+C or Ctrl+D to exit.')
  log('')
}

// ──────────────────────────────────────────
// 交互式 REPL
// ──────────────────────────────────────────

export async function startRepl(ctx: ReplContext): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'agentiX> ',
    terminal: true,
  })

  let multilineBuffer = ''

  console.log('AgentiX Cypher Shell (type :help for help)')
  rl.prompt()

  rl.on('line', (line: string) => {
    const trimmed = line.trim()

    // If any累积 buffer，处理多行输入
    if (multilineBuffer) {
      multilineBuffer += ' ' + trimmed
      if (trimmed.endsWith(';')) {
        const fullQuery = multilineBuffer.replace(/;\s*$/, '').trim()
        multilineBuffer = ''
        executeCypher(ctx, fullQuery)
        rl.prompt()
      } else {
        // 继续多行输入
        rl.prompt()
      }
      return
    }

    // 空行
    if (!trimmed) {
      rl.prompt()
      return
    }

    // 以 ; 结尾 — 单行 Cypher
    if (trimmed.endsWith(';')) {
      const query = trimmed.replace(/;\s*$/, '').trim()
      executeCypher(ctx, query)
      rl.prompt()
      return
    }

    // 冒号命令
    if (trimmed.startsWith(':')) {
      const cmd = parseCommand(trimmed)
      handleCommand(ctx, cmd, rl)
      rl.prompt()
      return
    }

    // 不以 ; 结尾的 Cypher 语句 — 可能有多行
    // 检查是否是 MATCH / RETURN / CREATE 等
    if (/^(MATCH|RETURN|CREATE|MERGE|DELETE|SET|WHERE|WITH|UNWIND|CALL|OPTIONAL)\b/i.test(trimmed)) {
      multilineBuffer = trimmed
      rl.setPrompt('  ..> ')
      rl.prompt()
      return
    }

    // 不认识的内容
    console.log(`Unknown command: ${trimmed}`)
    rl.prompt()
  })

  rl.on('close', () => {
    console.log('\nGoodbye!')
    process.exit(0)
  })

  rl.on('SIGINT', () => {
    if (multilineBuffer) {
      multilineBuffer = ''
      rl.setPrompt('agentiX> ')
      console.log('^C')
      rl.prompt()
      return
    }
    console.log('^C')
    rl.close()
  })

  rl.on('SIGCONT', () => {
    rl.prompt()
  })
}

// ──────────────────────────────────────────
// 命令处理
// ──────────────────────────────────────────

function handleCommand(ctx: ReplContext, cmd: ReplCommand, rl: readline.Interface): void {
  switch (cmd.type) {
    case 'exit':
      rl.close()
      break
    case 'help':
      displayHelp(ctx)
      break
    case 'schema':
      displaySchema(ctx)
      break
    case 'clear':
      console.clear()
      break
    case 'cypher':
      executeCypher(ctx, cmd.query)
      break
  }
}

// ──────────────────────────────────────────
// Cypher 执行
// ──────────────────────────────────────────

function executeCypher(ctx: ReplContext, query: string): void {
  if (!query) return

  try {
    if (ctx.verbose) {
      console.log(`Executing: ${query}`)
    }
    const result = executeQuery(ctx.engine, query)
    printResult(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Query error: ${message}`)
  }
}

// ──────────────────────────────────────────
// 主入口
// ──────────────────────────────────────────

export async function runCypherShell(engine: GraphEngine, options?: { query?: string; verbose?: boolean }): Promise<void> {
  const ctx: ReplContext = {
    engine,
    verbose: options?.verbose ?? false,
  }

  if (options?.query) {
    // 单次执行模式
    executeCypher(ctx, options.query)
    return
  }

  // 交互模式
  await startRepl(ctx)
}

// ──────────────────────────────────────────
// 直接执行
// ──────────────────────────────────────────

if (require.main === module) {
  // 从 args 解析 --query 和 --verbose
  const args = process.argv.slice(2)
  const queryIdx = args.indexOf('--query')
  const query = queryIdx >= 0 && queryIdx + 1 < args.length ? args[queryIdx + 1] : undefined
  const verbose = args.includes('--verbose')

  // 默认使用 ./data 作为图路径
  const dataPath = args.includes('--path')
    ? args[args.indexOf('--path') + 1]
    : './test-data/repl-data'

  const engine = new GraphEngine({ path: dataPath })
  engine.open()

  runCypherShell(engine, { query, verbose })
    .catch(err => {
      console.error('Fatal error:', err)
      process.exit(1)
    })
    .finally(() => {
      if (query) {
        // 单次执行后清理退出
        engine.close()
      }
    })
}
