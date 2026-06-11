/**
 * tck-global-setup.ts — vitest globalSetup
 * 在所有 TCK 测试前启动持久化 GraphEngine daemon，
 * 测试完成后关闭。
 *
 * daemon 启动端口写入 /tmp/tck-daemon-port-{pid}，
 * _tckExec 通过 curl 同步发送请求。
 */

import { execSync, spawn } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'

const PID = process.pid
const PORT_FILE = `/tmp/tck-daemon-port-${PID}`
let daemonProc: ReturnType<typeof spawn> | null = null

export function setup() {
  // 清理旧端口文件
  try { fs.unlinkSync(PORT_FILE) } catch {}
  // 杀掉可能残留的旧 daemon
  try { execSync(`pkill -f "tck-daemon.js"`, { stdio: 'ignore' }) } catch {}

  const daemonPath = path.resolve(__dirname, 'tck-daemon.js')
  daemonProc = spawn('node', [daemonPath, '0', PORT_FILE], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })

  // 异步收集日志，避免阻塞
  if (daemonProc.stdout) daemonProc.stdout.on('data', (d: Buffer) => process.stderr.write('[daemon-out] ' + d.toString()))
  if (daemonProc.stderr) daemonProc.stderr.on('data', (d: Buffer) => process.stderr.write('[daemon-err] ' + d.toString()))

  // 同步等待端口文件出现（最多 15s）
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (daemonProc.exitCode !== null && daemonProc.exitCode !== 0) {
      throw new Error(`TCK daemon crashed with exit code ${daemonProc.exitCode}`)
    }
    try {
      const port = parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10)
      if (port > 0) {
        console.log(`[tck-setup] Daemon ready on port ${port}`)
        return
      }
    } catch {}
    execSync('sleep 0.05', { stdio: 'ignore' })
  }

  throw new Error('TCK daemon failed to start within 15s')
}

export function teardown() {
  if (daemonProc && !daemonProc.killed) {
    try { daemonProc.kill('SIGTERM') } catch {}
  }
  try { fs.unlinkSync(PORT_FILE) } catch {}
  // 确保杀掉
  try { execSync('pkill -f "tck-daemon.js"', { stdio: 'ignore' }) } catch {}
}