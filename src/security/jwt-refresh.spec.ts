/**
 * C-07: JWT Refresh Token — 测试
 *
 * 验证 refresh token 签发、验证、过期拒绝、secret 文件加载
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { JwtManager } from './auth'
import { Role, AuthError } from '../types'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('C-07: JWT Refresh Token', () => {
  const secret = 'test-secret-key-min-16-bytes!!'
  let jwt: JwtManager

  beforeEach(() => {
    jwt = new JwtManager(secret)
  })

  // TC1: Refresh Token 签发
  it('signRefreshToken creates a valid refresh token', () => {
    const token = jwt.signRefreshToken('user1', Role.ADMIN)
    expect(token).toBeTruthy()
    expect(token.split('.').length).toBe(3)

    // Should verify as a valid token
    const payload = jwt.verifyToken(token)
    expect(payload.userId).toBe('user1')
    expect(payload.role).toBe(Role.ADMIN)
  })

  // TC2: Refresh Token 验证
  it('refreshAccessToken issues new access token', () => {
    const refreshToken = jwt.signRefreshToken('user1', Role.WRITER)
    const result = jwt.refreshAccessToken(refreshToken)
    expect(result.accessToken).toBeTruthy()
    expect(result.accessToken.split('.').length).toBe(3)
    expect(result.expiresIn).toBe(3600)

    // New access token should be verifiable
    const accessPayload = jwt.verifyToken(result.accessToken)
    expect(accessPayload.userId).toBe('user1')
    expect(accessPayload.role).toBe(Role.WRITER)
  })

  // TC3: Access Token 不能当作 Refresh Token
  it('access token cannot be used as refresh token', () => {
    const accessToken = jwt.signToken('user1', Role.READER)
    expect(() => jwt.refreshAccessToken(accessToken)).toThrow(AuthError)
    expect(() => jwt.refreshAccessToken(accessToken)).toThrow('Not a refresh token')
  })

  // TC4: 过期 Refresh Token 被拒绝
  it('expired refresh token is rejected', async () => {
    // Create a refresh token that expires in 1 second
    const refreshToken = jwt.signRefreshToken('user1', Role.ADMIN, 1)
    // Wait for it to expire
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect(() => jwt.refreshAccessToken(refreshToken)).toThrow(AuthError)
    expect(() => jwt.refreshAccessToken(refreshToken)).toThrow('has expired')
  })

  // TC5: Secret 从文件加载
  it('loadSecretFromFile reads secret from file', () => {
    const tmpFile = path.join(os.tmpdir(), `jwt-secret-${Date.now()}.txt`)
    const fileSecret = 'file-based-secret-key-123456!!'
    try {
      fs.writeFileSync(tmpFile, fileSecret)
      const loadedSecret = JwtManager.loadSecretFromFile(tmpFile)
      expect(loadedSecret).toBeTruthy()
      expect(loadedSecret.toString()).toBe(fileSecret)

      // Use loaded secret to create JwtManager
      const jwtFromFile = new JwtManager(loadedSecret)
      const token = jwtFromFile.signToken('user1', Role.READER)
      const payload = jwtFromFile.verifyToken(token)
      expect(payload.userId).toBe('user1')
    } finally {
      try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
    }
  })

  // TC6: Old refresh token should still work for its lifetime
  it('refresh token works within its lifetime', () => {
    const refreshToken = jwt.signRefreshToken('user1', Role.OPERATOR, 3600)
    const result = jwt.refreshAccessToken(refreshToken)
    expect(result.accessToken).toBeTruthy()
  })

  // TC7: 空 secret 文件加载失败
  it('loadSecretFromFile with empty file throws', () => {
    const tmpFile = path.join(os.tmpdir(), `jwt-secret-empty-${Date.now()}.txt`)
    try {
      fs.writeFileSync(tmpFile, '')
      expect(() => JwtManager.loadSecretFromFile(tmpFile)).toThrow()
    } finally {
      try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
    }
  })
})
