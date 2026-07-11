/**
 * 审计日志加密测试
 *
 * 覆盖：
 * - 加密后密文与明文不同
 * - 加密后解密可恢复原文
 * - Error密钥解密抛异常
 * - 不同密钥产生不同密文
 * - 不同 IV 产生不同密文（相同密钥）
 * - 空字符串加密/解密
 * - 大文本加密/解密
 * - 解密 corrupt 数据抛异常
 * - 加密后篡改 tag 解密抛异常
 * - 加密后篡改 iv 解密抛异常
 */
import { describe, it, expect } from 'vitest'
import { AuditLog } from './audit-log'

describe('审计日志加密', () => {
  const makeKey = (s: string): Buffer => {
    const buf = Buffer.alloc(32, s)
    return buf
  }

  it('加密后密文与明文不同', () => {
    const key = makeKey('test-key-32-bytes-abcdefghijk123')
    const result = AuditLog.encryptEntry('{"operation":"test"}', key)
    expect(result.encrypted).toBeDefined()
    expect(result.iv.length).toBe(12)
    expect(result.tag.length).toBe(16)
    expect(result.encrypted.toString('hex')).not.toContain('test')
  })

  it('加密后解密可恢复原文', () => {
    const key = makeKey('test-key-32-bytes-abcdefghijk123')
    const plaintext = '{"operation":"test","user":"admin","result":"success"}'
    const { encrypted, iv, tag } = AuditLog.encryptEntry(plaintext, key)
    const decrypted = AuditLog.decryptEntry(encrypted, iv, tag, key)
    expect(decrypted).toBe(plaintext)
  })

  it('Error密钥解密抛异常', () => {
    const key = makeKey('correct-key-32-bytes-abcdefghijk1')
    const wrongKey = makeKey('wrong-key-32-bytes-abcdefghijk12')
    const plaintext = '{"operation":"secret"}'
    const { encrypted, iv, tag } = AuditLog.encryptEntry(plaintext, key)
    expect(() => {
      AuditLog.decryptEntry(encrypted, iv, tag, wrongKey)
    }).toThrow()
  })

  it('不同密钥产生不同密文', () => {
    const keyA = makeKey('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    const keyB = makeKey('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    const plaintext = '{"hello":"world"}'

    const r1 = AuditLog.encryptEntry(plaintext, keyA)
    const r2 = AuditLog.encryptEntry(plaintext, keyB)

    // Different keys produce different ciphertext
    expect(r1.encrypted.toString('hex')).not.toBe(r2.encrypted.toString('hex'))
  })

  it('不同 IV 产生不同密文（相同密钥）', () => {
    const key = makeKey('same-key-for-both-encrypt-operations')
    const plaintext = '{"msg":"same text"}'

    const r1 = AuditLog.encryptEntry(plaintext, key)
    const r2 = AuditLog.encryptEntry(plaintext, key)

    // IV should be random each time
    expect(r1.iv.toString('hex')).not.toBe(r2.iv.toString('hex'))
    // Same plaintext but different IV → different ciphertext
    expect(r1.encrypted.toString('hex')).not.toBe(r2.encrypted.toString('hex'))
  })

  it('空字符串加密/解密可恢复', () => {
    const key = makeKey('empty-string-test-key-12345678901')
    const { encrypted, iv, tag } = AuditLog.encryptEntry('', key)
    const decrypted = AuditLog.decryptEntry(encrypted, iv, tag, key)
    expect(decrypted).toBe('')
  })

  it('大文本加密/解密可恢复', () => {
    const key = makeKey('large-text-encryption-test-case-1234')
    const largeText = JSON.stringify({
      operation: 'bulk_insert',
      user: 'system',
      result: 'success',
      data: 'x'.repeat(10000),
    })
    const { encrypted, iv, tag } = AuditLog.encryptEntry(largeText, key)
    const decrypted = AuditLog.decryptEntry(encrypted, iv, tag, key)
    expect(decrypted).toBe(largeText)
  })

  it('加密后篡改 tag 解密抛异常', () => {
    const key = makeKey('tamper-tag-test-32-bytes-encryption')
    const plaintext = '{"op":"tamper_test"}'
    const { encrypted, iv, tag } = AuditLog.encryptEntry(plaintext, key)

    // Flip a bit in the tag
    const tamperedTag = Buffer.from(tag)
    tamperedTag[0] ^= 0xff

    expect(() => {
      AuditLog.decryptEntry(encrypted, iv, tamperedTag, key)
    }).toThrow()
  })

  it('加密后篡改 iv 解密抛异常', () => {
    const key = makeKey('tamper-iv-test-32-bytes-encryption-1')
    const plaintext = '{"op":"iv_tamper_test"}'
    const { encrypted, iv, tag } = AuditLog.encryptEntry(plaintext, key)

    // Flip a bit in the iv
    const tamperedIv = Buffer.from(iv)
    tamperedIv[0] ^= 0x55

    expect(() => {
      AuditLog.decryptEntry(encrypted, tamperedIv, tag, key)
    }).toThrow()
  })

  it('加密后篡改密文解密抛异常', () => {
    const key = makeKey('tamper-ciphertext-test-32-bytes-key')
    const plaintext = '{"op":"ct_tamper_test"}'
    const { encrypted, iv, tag } = AuditLog.encryptEntry(plaintext, key)

    // Flip a bit in the ciphertext
    const tamperedCt = Buffer.from(encrypted)
    tamperedCt[Math.floor(tamperedCt.length / 2)] ^= 0xaa

    expect(() => {
      AuditLog.decryptEntry(tamperedCt, iv, tag, key)
    }).toThrow()
  })
})
