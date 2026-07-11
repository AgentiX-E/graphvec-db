// ============================================================
// rest-error.spec.ts — REST API Error码标准化测试
//
// 验证所有Error响应统一包含 { error, code, errorCode } 格式。
// ============================================================

import { describe, test, expect, vi } from 'vitest'
import { jsonResponse } from './rest'
import { ErrorCode } from './error-codes'
import { EventEmitter } from 'events'

// ── 创建可捕获响应的伪造 ServerResponse ──────────────────

interface CapturedResponse {
  statusCode: number
  headers: Record<string, string>
  bodyStr: string
}

function makeFakeRes(): [any, CapturedResponse] {
  const cap: CapturedResponse = { statusCode: 0, headers: {}, bodyStr: '' }

  // Use a plain EventEmitter with writeHead/end to avoid Node internals issues
  const fake: any = new EventEmitter()
  fake.writeHead = function (statusCode: number, headers: any) {
    cap.statusCode = statusCode
    if (headers) cap.headers = { ...headers }
  }
  fake.end = function (data: string) {
    cap.bodyStr = data
  }
  fake.setHeader = vi.fn()

  return [fake, cap]
}

// ── 测试 ──────────────────────────────────────────────────

describe('REST API — 标准Error响应格式', () => {
  test('400 Error响应包含 error, code, errorCode 字段', () => {
    const [res, cap] = makeFakeRes()
    jsonResponse(res, 400, { error: 'Invalid input' })

    const body = JSON.parse(cap.bodyStr)
    expect(body).toEqual({
      error: 'Invalid input',
      code: 400,
      errorCode: ErrorCode.VALIDATION_ERROR,
    })
  })

  test('404 响应包含正确字段', () => {
    const [res, cap] = makeFakeRes()
    jsonResponse(res, 404, { error: 'not found' })

    const body = JSON.parse(cap.bodyStr)
    expect(body).toEqual({
      error: 'not found',
      code: 404,
      errorCode: ErrorCode.NODE_NOT_FOUND,
    })
  })

  test('500 响应包含正确字段', () => {
    const [res, cap] = makeFakeRes()
    jsonResponse(res, 500, { error: 'Internal error' })

    const body = JSON.parse(cap.bodyStr)
    expect(body).toEqual({
      error: 'Internal error',
      code: 500,
      errorCode: ErrorCode.INTERNAL_ERROR,
    })
  })

  test('没有 error 字段时使用默认消息', () => {
    const [res, cap] = makeFakeRes()
    jsonResponse(res, 400, {})

    const body = JSON.parse(cap.bodyStr)
    expect(body).toMatchObject({
      error: 'Bad Request',
      code: 400,
      errorCode: ErrorCode.VALIDATION_ERROR,
    })
  })

  test('details 字段会被保留', () => {
    const [res, cap] = makeFakeRes()
    jsonResponse(res, 400, {
      error: 'Invalid input',
      details: { field: 'name', reason: 'required' },
    })

    const body = JSON.parse(cap.bodyStr)
    expect(body).toEqual({
      error: 'Invalid input',
      code: 400,
      errorCode: ErrorCode.VALIDATION_ERROR,
      details: { field: 'name', reason: 'required' },
    })
  })

  test('200 响应不会添加 code/errorCode', () => {
    const [res, cap] = makeFakeRes()
    jsonResponse(res, 200, { message: 'ok', id: 1 })

    const body = JSON.parse(cap.bodyStr)
    expect(body).toEqual({ message: 'ok', id: 1 })
    expect((body as any).code).toBeUndefined()
    expect((body as any).errorCode).toBeUndefined()
  })

  test('Content-Type 为 application/json', () => {
    const [res, cap] = makeFakeRes()
    jsonResponse(res, 400, { error: 'test' })

    const ct = (cap.headers['Content-Type'] || cap.headers['content-type'] || '').toLowerCase()
    expect(ct).toContain('application/json')
  })

  test('502 响应包含正确字段', () => {
    const [res, cap] = makeFakeRes()
    jsonResponse(res, 502, { error: 'Bad gateway' })

    const body = JSON.parse(cap.bodyStr)
    expect(body).toMatchObject({
      error: 'Bad gateway',
      code: 502,
    })
    expect(body.errorCode).toBeDefined()
  })

  test('409 冲突响应包含正确字段', () => {
    const [res, cap] = makeFakeRes()
    jsonResponse(res, 409, { error: 'Conflict' })

    const body = JSON.parse(cap.bodyStr)
    expect(body).toEqual({
      error: 'Conflict',
      code: 409,
      errorCode: ErrorCode.DUPLICATE_ENTRY,
    })
  })

  test('401 未经授权响应', () => {
    const [res, cap] = makeFakeRes()
    jsonResponse(res, 401, { error: 'Unauthorized' })

    const body = JSON.parse(cap.bodyStr)
    expect(body).toMatchObject({
      error: 'Unauthorized',
      code: 401,
    })
    expect(body.errorCode).toBe(ErrorCode.PERMISSION_DENIED)
  })
})
