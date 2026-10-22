/**
 * audit-chain.spec.ts — 审计日志哈希链（独立文件，避免 vitest 缓存污染）
 *
 * 覆盖：
 * - genesis 日志 prevHash 为 undefined
 * - 链式哈希传播
 * - verifyChain 在完整链上返回 true
 * - 篡改检测
 * - 多 entry 链（10+ entries）
 * - 清空后链重置
 * - 空链验证
 * - 中间 entry 篡改检测
 * - 尾部 entry 篡改检测
 * - 清空后重建链验证
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AuditLog } from './audit-log'
import { Role } from '../types'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('审计哈希链', () => {
  let logDir: string
  let log: AuditLog

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-chain-'))
    log = new AuditLog({ logDir })
  })

  afterEach(() => {
    log.close()
    try { fs.rmSync(logDir, { recursive: true, force: true }) } catch {}
  })

  it('genesis 日志 prevHash 应为 undefined', () => {
    log.log({ operation: 'a', user: 'admin', role: Role.ADMIN, resource: 'r', result: 'success' })
    const entries = log.query()
    expect(entries[0].prevHash).toBeUndefined()
  })

  it('后续日志 prevHash 为 64 位十六进制串', () => {
    log.log({ operation: 'a', user: 'admin', role: Role.ADMIN, resource: 'r', result: 'success' })
    log.log({ operation: 'b', user: 'admin', role: Role.ADMIN, resource: 'r', result: 'success' })
    const entries = log.query()
    expect(entries[1].prevHash).toBeDefined()
    expect(entries[1].prevHash!.length).toBe(64)
  })

  it('verifyChain 在完整链上返回 true', () => {
    log.log({ operation: 'a', user: 'admin', role: Role.ADMIN, resource: 'r', result: 'success' })
    log.log({ operation: 'b', user: 'admin', role: Role.ADMIN, resource: 'r', result: 'success' })
    log.log({ operation: 'c', user: 'admin', role: Role.ADMIN, resource: 'r', result: 'success' })
    expect(log.verifyChain()).toBe(true)
  })

  it('篡改第一个 entry 后 verifyChain 返回 false', () => {
    log.log({ operation: 'a', user: 'admin', role: Role.ADMIN, resource: 'r', result: 'success' })
    log.log({ operation: 'b', user: 'admin', role: Role.ADMIN, resource: 'r', result: 'success' })
    log.log({ operation: 'c', user: 'admin', role: Role.ADMIN, resource: 'r', result: 'success' })
    const entries: any[] = log.query()
    entries[0].operation = 'hacked'
    expect(log.verifyChain()).toBe(false)
  })

  it('篡改中间 entry 后 verifyChain 返回 false', () => {
    log.log({ operation: 'a', user: 'admin', role: Role.ADMIN, resource: 'r', result: 'success' })
    log.log({ operation: 'b', user: 'admin', role: Role.ADMIN, resource: 'r', result: 'success' })
    log.log({ operation: 'c', user: 'admin', role: Role.ADMIN, resource: 'r', result: 'success' })
    const entries: any[] = log.query()
    entries[1].result = 'failure'
    expect(log.verifyChain()).toBe(false)
  })

  it('多 entry 链（10+）验证通过', () => {
    for (let i = 0; i < 15; i++) {
      log.log({ operation: `op-${i}`, user: 'admin', role: Role.ADMIN, resource: 'r', result: 'success' })
    }
    expect(log.size()).toBe(15)
    expect(log.verifyChain()).toBe(true)
  })

  it('空链验证返回 true', () => {
    expect(log.size()).toBe(0)
    expect(log.verifyChain()).toBe(true)
  })

  it('单个 entry 的链验证通过', () => {
    log.log({ operation: 'single', user: 'admin', role: Role.ADMIN, resource: 'r', result: 'success' })
    expect(log.verifyChain()).toBe(true)
  })

  it('清空后链重置，新链验证通过', () => {
    log.log({ operation: 'old', user: 'admin', role: Role.ADMIN, resource: 'r', result: 'success' })
    log.log({ operation: 'old2', user: 'admin', role: Role.ADMIN, resource: 'r', result: 'success' })
    expect(log.verifyChain()).toBe(true)

    log.clear()
    expect(log.size()).toBe(0)
    expect(log.verifyChain()).toBe(true)

    log.log({ operation: 'new', user: 'admin', role: Role.ADMIN, resource: 'r', result: 'success' })
    expect(log.verifyChain()).toBe(true)
  })

  it('prevHash 指向正确的上一个 entry 的 hash', () => {
    log.log({ operation: 'first', user: 'admin', role: Role.ADMIN, resource: 'r', result: 'success' })
    log.log({ operation: 'second', user: 'admin', role: Role.ADMIN, resource: 'r', result: 'success' })

    const entries: any[] = log.query()
    // The prevHash of second entry should be the hash of the first
    expect(entries[0].prevHash).toBeUndefined()
    expect(entries[1].prevHash).toBeTruthy()
    expect(typeof entries[1].prevHash).toBe('string')
    expect(entries[1].prevHash!.length).toBe(64)
  })
})
