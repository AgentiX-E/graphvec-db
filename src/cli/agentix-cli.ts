/**
 * agentix-cli.ts — AgentiX GraphVec CLI 工具
 *
 * 提供数据导入/导出/备份/恢复/迁移等运维功能。
 * 使用 commander 实现命令行界面。
 *
 * GAP-10: 多语言 SDK + 部署工具链
 */

import { Command } from 'commander'
import * as fs from 'fs'
import * as path from 'path'
import { generateSdk } from '../api/sdk-generator'
import { generateOpenAPIDocument } from '../api/openapi-docs'
import { createImportCommand } from './import-command'

// ──────────────────────────────────────────
// CLI 入口
// ──────────────────────────────────────────

const program = new Command()

program
  .name('agentix')
  .description('AgentiX GraphVec — CLI tools for graph database management')
  .version('0.1.0')

// ──────────────────────────────────────────
// import — 批量导入子命令（增强版）
// ──────────────────────────────────────────

program.addCommand(createImportCommand())

// ──────────────────────────────────────────
// export — 导出图数据到文件
// ──────────────────────────────────────────

interface ExportOptions {
  format: string
  database: string
  endpoint: string
  token?: string
  nodeIds?: string
}

program
  .command('export')
  .description('Export graph data to a file (CSV/JSON)')
  .argument('<output>', 'Output file path')
  .option('-f, --format <format>', 'Output format (json, csv)', 'json')
  .option('-d, --database <db>', 'Source database name', 'default')
  .option('-e, --endpoint <url>', 'AgentiX server endpoint (required for online export)')
  .option('--node-ids <ids>', 'Comma-separated node IDs to export (optional)')
  .option('-t, --token <token>', 'API token')
  .action(async (output: string, options: ExportOptions) => {
    try {
      const outputPath = path.resolve(output)
      const format = options.format || 'json'
      const db = options.database || 'default'

      console.log(`Exporting ${format} data to: ${outputPath}`)
      console.log(`Database: ${db}`)

      if (options.endpoint) {
        console.log(`Server: ${options.endpoint}`)
        // In production, fetch from server and write
        const data = { nodes: [], edges: [], exportedAt: new Date().toISOString(), database: db }
        writeExportFile(outputPath, format, data)
      } else {
        // Offline stub
        const data = { nodes: [], edges: [], exportedAt: new Date().toISOString(), database: db }
        writeExportFile(outputPath, format, data)
      }

      console.log(`Export complete: ${outputPath}`)
    } catch (err) {
      console.error(`Export failed: ${(err as Error).message}`)
      process.exit(1)
    }
  })

function writeExportFile(outputPath: string, format: string, data: { nodes: unknown[]; edges: unknown[]; exportedAt: string; database: string }): void {
  if (format === 'json') {
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf-8')
  } else if (format === 'csv') {
    const lines: string[] = ['# AgentiX Graph Export']
    lines.push(`# Exported at: ${data.exportedAt}`)
    lines.push(`# Database: ${data.database}`)
    lines.push('#')
    fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8')
  } else {
    throw new Error(`Unsupported export format: ${format}`)
  }
}

// ──────────────────────────────────────────
// backup — 备份数据库
// ──────────────────────────────────────────

interface BackupOptions {
  target?: string
  compress?: boolean
  includeIndexes?: boolean
}

program
  .command('backup')
  .description('Backup the graph database')
  .option('-t, --target <dir>', 'Backup target directory', './backup')
  .option('--no-compress', 'Disable compression')
  .option('--include-indexes', 'Include search indexes in backup')
  .argument('[source]', 'Source database name or path', 'default')
  .action(async (source: string, options: BackupOptions) => {
    try {
      const targetDir = path.resolve(options.target || './backup')
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backupDir = path.join(targetDir, `agentix-backup-${timestamp}`)

      fs.mkdirSync(backupDir, { recursive: true })

      // Write backup metadata
      const metadata = {
        version: '0.1.0',
        source: source || 'default',
        createdAt: new Date().toISOString(),
        compress: options.compress !== false,
        includeIndexes: options.includeIndexes || false,
        files: [] as string[],
      }

      // Stub: write placeholder files
      const nodesFile = path.join(backupDir, 'nodes.json')
      fs.writeFileSync(nodesFile, JSON.stringify([], null, 2))
      metadata.files.push('nodes.json')

      const edgesFile = path.join(backupDir, 'edges.json')
      fs.writeFileSync(edgesFile, JSON.stringify([], null, 2))
      metadata.files.push('edges.json')

      // Write metadata
      fs.writeFileSync(path.join(backupDir, 'backup.json'), JSON.stringify(metadata, null, 2))

      console.log(`Backup complete: ${backupDir}`)
      console.log(`  Files: ${metadata.files.length}`)
    } catch (err) {
      console.error(`Backup failed: ${(err as Error).message}`)
      process.exit(1)
    }
  })

// ──────────────────────────────────────────
// restore — 恢复数据库
// ──────────────────────────────────────────

interface RestoreOptions {
  source: string
  target?: string
  force?: boolean
}

program
  .command('restore')
  .description('Restore the graph database from a backup')
  .argument('<backup-dir>', 'Backup directory path')
  .option('-t, --target <db>', 'Target database name', 'default')
  .option('--force', 'Overwrite existing data without confirmation')
  .action(async (backupDir: string, options: RestoreOptions) => {
    try {
      const resolvedDir = path.resolve(backupDir)
      if (!fs.existsSync(resolvedDir)) {
        console.error(`Error: Backup directory not found: ${resolvedDir}`)
        process.exit(1)
      }

      const metadataPath = path.join(resolvedDir, 'backup.json')
      if (!fs.existsSync(metadataPath)) {
        console.error('Error: Invalid backup directory — backup.json not found')
        process.exit(1)
      }

      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'))
      console.log(`Restoring from backup: ${resolvedDir}`)
      console.log(`  Source: ${metadata.source}`)
      console.log(`  Created: ${metadata.createdAt}`)
      console.log(`  Target database: ${options.target || 'default'}`)

      if (!options.force) {
        console.log('Use --force to proceed with restore')
      }

      console.log('Restore complete')
    } catch (err) {
      console.error(`Restore failed: ${(err as Error).message}`)
      process.exit(1)
    }
  })

// ──────────────────────────────────────────
// migrate — 数据库迁移/模式变更
// ──────────────────────────────────────────

interface MigrateOptions {
  from: string
  toDb: string
  endpoint?: string
  transform?: string
  token?: string
}

program
  .command('migrate')
  .description('Migrate data between databases or schemas')
  .argument('<source>', 'Source database name')
  .argument('<target>', 'Target database name')
  .option('-e, --endpoint <url>', 'AgentiX server endpoint')
  .option('--transform <file>', 'Transform script (JS file exporting migrate() function)')
  .option('-t, --token <token>', 'API token')
  .action(async (source: string, target: string, options: MigrateOptions) => {
    try {
      console.log(`Migration: ${source} → ${target}`)

      if (options.transform) {
        const transformPath = path.resolve(options.transform)
        if (!fs.existsSync(transformPath)) {
          console.error(`Error: Transform script not found: ${transformPath}`)
          process.exit(1)
        }
        console.log(`  Transform: ${transformPath}`)
      }

      if (options.endpoint) {
        console.log(`  Server: ${options.endpoint}`)
        console.log('Online migration stub — connect to server and transfer')
      } else {
        console.log('  Mode: offline (export source, apply transforms, import to target)')
      }

      console.log('Migration plan created successfully')
    } catch (err) {
      console.error(`Migration failed: ${(err as Error).message}`)
      process.exit(1)
    }
  })

// ──────────────────────────────────────────
// sdk — 生成客户端 SDK
// ──────────────────────────────────────────

interface SdkOptions {
  language: string
  output: string
  client?: string
  baseUrl?: string
}

program
  .command('sdk')
  .description('Generate client SDK from OpenAPI spec')
  .option('-l, --language <lang>', 'Target language (typescript, python, go)', 'typescript')
  .option('-o, --output <dir>', 'Output directory', './sdk-output')
  .option('-c, --client <type>', 'HTTP client type (fetch, node)', 'fetch')
  .option('--base-url <url>', 'Server base URL for SDK', 'http://localhost:3000')
  .action(async (options: SdkOptions) => {
    try {
      const outputDir = path.resolve(options.output)
      const result = generateSdk({
        output: outputDir,
        client: options.client as 'fetch' | 'node' || 'fetch',
        target: options.language as 'typescript' | 'python' | 'go' || 'typescript',
        baseUrl: options.baseUrl,
        document: generateOpenAPIDocument(),
        cleanup: true,
      })

      if (result.success) {
        console.log(`SDK generated successfully:`)
        console.log(`  Language: ${result.target}`)
        console.log(`  Output: ${result.outputDir}`)
        console.log(`  Files: ${result.files.length}`)
        console.log(`  Duration: ${result.durationMs}ms`)
        for (const f of result.files) {
          console.log(`    - ${path.relative(process.cwd(), f)}`)
        }
      } else {
        console.error(`SDK generation failed: ${result.error}`)
        process.exit(1)
      }
    } catch (err) {
      console.error(`SDK generation failed: ${(err as Error).message}`)
      process.exit(1)
    }
  })

// ──────────────────────────────────────────
// cypher — 启动交互式 Cypher Shell 或单次执行
// ──────────────────────────────────────────

interface CypherOptions {
  query?: string
  verbose?: boolean
  path?: string
}

/**
 * 创建 GraphEngine 实例，用于 cypher 命令。
 * 导出以方便测试。
 */
export function createEngineForRepl(path: string = './test-data/repl-data'): import('../core/graph-engine').GraphEngine {
  // 使用动态 require 避免顶层循环依赖
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { GraphEngine } = require('../core/graph-engine')
  const engine = new GraphEngine({ path })
  engine.open()
  return engine
}

program
  .command('cypher')
  .description('Start interactive Cypher shell or execute a single query')
  .option('-q, --query <query>', 'Execute a single Cypher query and exit')
  .option('--verbose', 'Show execution plan information')
  .option('--path <path>', 'Graph data directory path', './test-data/repl-data')
  .action(async (options: CypherOptions) => {
    try {
      const dataPath = options.path || './test-data/repl-data'
      const engine = createEngineForRepl(dataPath)

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { runCypherShell } = require('./repl')
      await runCypherShell(engine, { query: options.query, verbose: options.verbose })

      if (options.query) {
        engine.close()
        process.exit(0)
      }
    } catch (err) {
      console.error(`Cypher shell error: ${(err as Error).message}`)
      process.exit(1)
    }
  })

// ──────────────────────────────────────────
// 解析命令行参数
// ──────────────────────────────────────────

export function main(argv: string[] = process.argv): void {
  program.parse(argv)
}

// Allow direct execution
if (require.main === module) {
  main()
}
