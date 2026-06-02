/**
 * 审计日志加密测试
 */
import { describe, it, expect } from 'vitest'
import { AuditLog } from './audit-log'

describe('审计日志加密', () => {
  it('加密后密文与明文不同', () => {
    const key = Buffer.alloc(32, 'test-key-32-bytes-abcdefghijk123')
    const result = AuditLog.encryptEntry('{"operation":"test"}', key)
    expect(result.encrypted).toBeDefined()
    expect(result.iv.length).toBe(12)
    expect(result.tag.length).toBe(16)
    expect(result.encrypted.toString('hex')).not.toContain('test')
  })

  it('加密后解密可恢复原文', () => {
    const key = Buffer.alloc(32, 'test-key-32-bytes-abcdefghijk123')
    const plaintext = '{"operation":"test","user":"admin","result":"success"}'
    const { encrypted, iv, tag } = AuditLog.encryptEntry(plaintext, key)
    const decrypted = AuditLog.decryptEntry(encrypted, iv, tag, key)
    expect(decrypted).toBe(plaintext)
  })

  it('错误密钥解密抛异常', () => {
    const key = Buffer.alloc(32, 'correct-key-32-bytes-abcdefghijk1')
    const wrongKey = Buffer.alloc(32, 'wrong-key-32-bytes-abcdefghijk12')
    const plaintext = '{"operation":"secret"}'
    const { encrypted, iv, tag } = AuditLog.encryptEntry(plaintext, key)
    expect(() => {
      AuditLog.decryptEntry(encrypted, iv, tag, wrongKey)
    }).toThrow()
  })
})
