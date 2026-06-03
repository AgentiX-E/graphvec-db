/**
 * import-command.ts — AgentiX GraphVec 批量导入 CLI
 *
 * 子命令:
 *   agentix import nodes <csv-file> --label Person [--delimiter ,] [--batch-size 500]
 *   agentix import edges  <csv-file> --type KNOWS --from src --to dst [--delimiter ,]
 *   agentix import load-csv <file> [--limit 10]
 */

import { Command } from 'commander'
import * as fs from 'fs'
import * as path from 'path'
import { parse } from 'csv-parse/sync'
import type { GraphEngine } from '../core/graph-engine'

// ──────────────────────────────────────────
// 辅助：将标签名映射到数字 typeId
// ──────────────────────────────────────────

/**
 * 将用户可读的标签/类型名称映射到数字 typeId。
 * 使用 FNV-1a 哈希确保同一名称总是得到相同的 typeId。
 * 内置类型（NodeType / EdgeType）直接映射。
 */
export function labelToTypeId(label: string, builtinMap?: Record<string, number>): number {
  if (builtinMap && builtinMap[label.toUpperCase()]) {
    return builtinMap[label.toUpperCase()]
  }
  // FNV-1a 32-bit hash
  let hash = 0x811c9dc5
  const str = label.toUpperCase()
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

// ──────────────────────────────────────────
// 进度条
// ──────────────────────────────────────────

let _lastProgressLen = 0

function renderProgress(current: number, total: number, label: string): void {
  const pct = total > 0 ? ((current / total) * 100).toFixed(1) : '0.0'
  const barLen = 30
  const filled = total > 0 ? Math.round((current / total) * barLen) : 0
  const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled)
  const msg = `\r${label} ${bar} ${current}/${total} (${pct}%)`
  process.stdout.write(msg)
  _lastProgressLen = msg.length
}

function clearProgress(): void {
  if (_lastProgressLen > 0) {
    process.stdout.write('\r' + ' '.repeat(_lastProgressLen) + '\r')
    _lastProgressLen = 0
  }
}

// ──────────────────────────────────────────
// 导入工具
// ──────────────────────────────────────────

/**
 * 从 CSV 文件解析出列名
 */
export function parseColumnNames(csvPath: string, delimiter: string): string[] {
  const content = fs.readFileSync(csvPath, 'utf-8')
  const firstLine = content.split('\n')[0]
  if (!firstLine || firstLine.trim().length === 0) {
    return []
  }
  return firstLine.split(delimiter).map(c => c.trim())
}

/**
 * 从 CSV 文件读取所有行（跳过表头）
 */
export function readCsvRows(csvPath: string, delimiter: string, hasHeader: boolean): string[][] {
  const content = fs.readFileSync(csvPath, 'utf-8')
  const rawLines = parse(content, {
    delimiter,
    relax_column_count: true,
    skip_empty_lines: true,
    skip_records_with_empty_values: false,
  }) as string[][]

  if (!rawLines || rawLines.length === 0) return []
  if (hasHeader) return rawLines.slice(1)
  return rawLines
}

// ──────────────────────────────────────────
// 创建 import 子命令
// ──────────────────────────────────────────

export function createImportCommand(engine?: GraphEngine): Command {
  const importCmd = new Command('import')
    .description('批量导入图数据')

  // ── import nodes ──────────────────────────

  importCmd
    .command('nodes')
    .description('从 CSV 文件批量导入节点')
    .argument('<csv-file>', 'CSV 文件路径')
    .requiredOption('--label <label>', '节点标签（如 Person）')
    .option('--delimiter <char>', 'CSV 分隔符', ',')
    .option('--batch-size <n>', '每批提交节点数', '500')
    .option('--source-only', '只查看列名，不执行导入')
    .action(async (csvFile: string, options: {
      label: string
      delimiter: string
      batchSize: string
      sourceOnly?: boolean
    }) => {
      const filePath = path.resolve(csvFile)
      if (!fs.existsSync(filePath)) {
        console.error(`错误: 文件不存在: ${filePath}`)
        process.exit(1)
      }

      const delimiter = options.delimiter
      const batchSize = parseInt(options.batchSize, 10)
      const typeId = labelToTypeId(options.label)

      // 解析列名
      const columns = parseColumnNames(filePath, delimiter)
      console.log(`文件: ${filePath}`)
      console.log(`标签: ${options.label} → typeId=${typeId}`)
      console.log(`列名: ${columns.join(', ')}`)

      if (options.sourceOnly) {
        console.log('source-only 模式: 仅查看列名，已完成。')
        return
      }

      // 读取数据行
      const rows = readCsvRows(filePath, delimiter, true)
      if (rows.length === 0) {
        console.log('CSV 文件中没有数据行。')
        return
      }

      // 首列作为节点 name，其余列作为属性
      const startTime = Date.now()
      let imported = 0

      while (imported < rows.length) {
        const chunk = rows.slice(imported, imported + batchSize)
        const inputs = chunk.map((row, idx) => {
          const name = row[0]?.trim() || `node-${imported + idx + 1}`
          const props: Record<string, any> = {}
          for (let c = 1; c < row.length && c < columns.length; c++) {
            const val = row[c]?.trim()
            if (val && val.length > 0) {
              props[columns[c]] = val
            }
          }
          return {
            typeId,
            name,
            opts: Object.keys(props).length > 0 ? { props } : undefined,
          }
        })

        if (engine) {
          engine.batchUpsertNodes(inputs)
        } else {
          // 无引擎时只模拟
        }

        imported += chunk.length
        renderProgress(imported, rows.length, '导入节点')
      }

      clearProgress()
      const elapsed = Date.now() - startTime
      const speed = elapsed > 0 ? Math.round(imported / (elapsed / 1000)) : imported
      console.log(`✅ 节点导入完成: ${imported} 个节点, 耗时 ${elapsed}ms, 平均 ${speed} 节点/秒`)
    })

  // ── import edges ──────────────────────────

  importCmd
    .command('edges')
    .description('从 CSV 文件批量导入边')
    .argument('<csv-file>', 'CSV 文件路径')
    .requiredOption('--type <typeName>', '边类型名称（如 KNOWS）')
    .requiredOption('--from <col>', '源节点 ID 的列名')
    .requiredOption('--to <col>', '目标节点 ID 的列名')
    .option('--delimiter <char>', 'CSV 分隔符', ',')
    .option('--batch-size <n>', '每批提交边数', '1000')
    .action(async (csvFile: string, options: {
      type: string
      from: string
      to: string
      delimiter: string
      batchSize: string
    }) => {
      const filePath = path.resolve(csvFile)
      if (!fs.existsSync(filePath)) {
        console.error(`错误: 文件不存在: ${filePath}`)
        process.exit(1)
      }

      const delimiter = options.delimiter
      const batchSize = parseInt(options.batchSize, 10)
      const typeId = labelToTypeId(options.type)

      // 解析列名
      const columns = parseColumnNames(filePath, delimiter)
      const fromIdx = columns.indexOf(options.from)
      const toIdx = columns.indexOf(options.to)
      if (fromIdx === -1) {
        console.error(`错误: 列 "${options.from}" 在 CSV 中不存在。可用列: ${columns.join(', ')}`)
        process.exit(1)
      }
      if (toIdx === -1) {
        console.error(`错误: 列 "${options.to}" 在 CSV 中不存在。可用列: ${columns.join(', ')}`)
        process.exit(1)
      }

      console.log(`文件: ${filePath}`)
      console.log(`类型: ${options.type} → typeId=${typeId}`)
      console.log(`源列: ${options.from} (索引 ${fromIdx})`)
      console.log(`目标列: ${options.to} (索引 ${toIdx})`)

      // 读取数据行
      const rows = readCsvRows(filePath, delimiter, true)
      if (rows.length === 0) {
        console.log('CSV 文件中没有数据行。')
        return
      }

      const startTime = Date.now()
      let imported = 0

      while (imported < rows.length) {
        const chunk = rows.slice(imported, imported + batchSize)
        const inputs = chunk.map(row => ({
          src: parseInt(row[fromIdx]?.trim(), 10),
          dst: parseInt(row[toIdx]?.trim(), 10),
          typeId,
        })).filter(e => !isNaN(e.src) && !isNaN(e.dst))

        if (engine && inputs.length > 0) {
          engine.batchUpsertEdges(inputs)
        }

        imported += chunk.length
        renderProgress(imported, rows.length, '导入边')
      }

      clearProgress()
      const elapsed = Date.now() - startTime
      const speed = elapsed > 0 ? Math.round(imported / (elapsed / 1000)) : imported
      console.log(`✅ 边导入完成: ${imported} 条边, 耗时 ${elapsed}ms, 平均 ${speed} 条/秒`)
    })

  // ── import load-csv ──────────────────────

  importCmd
    .command('load-csv')
    .description('预览/加载 CSV 文件（支持 WITH HEADERS）')
    .argument('<file>', 'CSV 文件路径')
    .option('--limit <n>', '显示行数上限', '10')
    .option('--delimiter <char>', 'CSV 分隔符', ',')
    .action(async (file: string, options: {
      limit: string
      delimiter: string
    }) => {
      const filePath = path.resolve(file)
      if (!fs.existsSync(filePath)) {
        console.error(`错误: 文件不存在: ${filePath}`)
        process.exit(1)
      }

      const limit = parseInt(options.limit, 10)
      const delimiter = options.delimiter
      const content = fs.readFileSync(filePath, 'utf-8')

      // 检测是否有表头
      const rawLines = parse(content, {
        delimiter,
        relax_column_count: true,
        skip_empty_lines: true,
      }) as string[][]

      if (rawLines.length === 0) {
        console.log('CSV 文件为空。')
        return
      }

      // 尝试检测表头：第一行如果包含非数字列名，或与第二行类型不同
      const hasHeaders = rawLines.length > 1 &&
        rawLines[0].some(c => isNaN(Number(c)) && c.trim().length > 0)

      const headers = hasHeaders ? rawLines[0] : null
      const rows = hasHeaders ? rawLines.slice(1) : rawLines
      const displayRows = rows.slice(0, limit)

      console.log(`\n文件: ${filePath}`)
      console.log(`总行数: ${rows.length} (${hasHeaders ? '含表头' : '无表头'})`)
      console.log(`列数: ${(headers || rows[0] || []).length}`)
      console.log('')

      if (headers) {
        console.log(`HEADERS: ${headers.join(', ')}`)
        console.log('─'.repeat(60))
      }

      for (let i = 0; i < displayRows.length; i++) {
        const row = displayRows[i]
        if (headers) {
          const parts = row.map((v: string, j: number) => {
            const col = headers[j] || `col${j}`
            return `${col}: ${v}`
          })
          console.log(`  [${i + 1}] ${parts.join(', ')}`)
        } else {
          console.log(`  [${i + 1}] ${row.join(delimiter)}`)
        }
      }

      if (rows.length > limit) {
        console.log(`  ... 还有 ${rows.length - limit} 行未显示`)
      }
    })

  return importCmd
}
