/**
 * audit-chain.spec.ts — 审计日志哈希链（新文件，避免 vitest 缓存污染）
 */
import { describe, it, expect } from 'vitest'
import { AuditLog } from './audit-log'

describe('审计哈希链（独立文件）', () => {
  it('genesis 日志 prevHash 应为 undefined', () => {
    const log = new AuditLog({ logDir: '/tmp/audit-chain-1' })
    log.log({ operation: 'a', user: 'admin', role: 'admin', resource: 'r', result: 'success' })
    const entries = log.query()
    expect(entries[0].prevHash).toBeUndefined()
    log.close()
  })

  it('后续日志 prevHash 为 64 位十六进制串', () => {
    const log = new AuditLog({ logDir: '/tmp/audit-chain-2' })
    log.log({ operation: 'a', user: 'admin', role: 'admin', resource: 'r', result: 'success' })
    log.log({ operation: 'b', user: 'admin', role: 'admin', resource: 'r', result: 'success' })
    const entries = log.query()
    expect(entries[1].prevHash).toBeDefined()
    expect(entries[1].prevHash!.length).toBe(64)
    log.close()
  })

  it('verifyChain 在完整链上返回 true', () => {
    const log = new AuditLog({ logDir: '/tmp/audit-chain-3' })
    log.log({ operation: 'a', user: 'admin', role: 'admin', resource: 'r', result: 'success' })
    log.log({ operation: 'b', user: 'admin', role: 'admin', resource: 'r', result: 'success' })
    log.log({ operation: 'c', user: 'admin', role: 'admin', resource: 'r', result: 'success' })
    expect(log.verifyChain()).toBe(true)
    log.close()
  })

  it('篡改后 verifyChain 返回 false', () => {
    const log = new AuditLog({ logDir: '/tmp/audit-chain-4' })
    log.log({ operation: 'a', user: 'admin', role: 'admin', resource: 'r', result: 'success' })
    log.log({ operation: 'b', user: 'admin', role: 'admin', resource: 'r', result: 'success' })
    log.log({ operation: 'c', user: 'admin', role: 'admin', resource: 'r', result: 'success' })
    const entries: any[] = log.query()
    entries[1].operation = 'hacked'
    expect(log.verifyChain()).toBe(false)
    log.close()
  })
})
