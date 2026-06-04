import { describe, it, expect } from 'vitest'
import { ErrorCode, inferErrorCode } from './error-codes'

describe('ErrorCode enum', () => {
  it('has NODE_NOT_FOUND', () => {
    expect(ErrorCode.NODE_NOT_FOUND).toBe('NODE_NOT_FOUND')
  })

  it('has EDGE_NOT_FOUND', () => {
    expect(ErrorCode.EDGE_NOT_FOUND).toBe('EDGE_NOT_FOUND')
  })

  it('has INVALID_QUERY', () => {
    expect(ErrorCode.INVALID_QUERY).toBe('INVALID_QUERY')
  })

  it('has VALIDATION_ERROR', () => {
    expect(ErrorCode.VALIDATION_ERROR).toBe('VALIDATION_ERROR')
  })

  it('has DUPLICATE_ENTRY', () => {
    expect(ErrorCode.DUPLICATE_ENTRY).toBe('DUPLICATE_ENTRY')
  })

  it('has TRANSACTION_ERROR', () => {
    expect(ErrorCode.TRANSACTION_ERROR).toBe('TRANSACTION_ERROR')
  })

  it('has PERMISSION_DENIED', () => {
    expect(ErrorCode.PERMISSION_DENIED).toBe('PERMISSION_DENIED')
  })

  it('has RATE_LIMITED', () => {
    expect(ErrorCode.RATE_LIMITED).toBe('RATE_LIMITED')
  })

  it('has INTERNAL_ERROR', () => {
    expect(ErrorCode.INTERNAL_ERROR).toBe('INTERNAL_ERROR')
  })
})

describe('inferErrorCode', () => {
  it('maps 400 to VALIDATION_ERROR', () => {
    expect(inferErrorCode(400)).toBe(ErrorCode.VALIDATION_ERROR)
  })

  it('maps 401 to PERMISSION_DENIED', () => {
    expect(inferErrorCode(401)).toBe(ErrorCode.PERMISSION_DENIED)
  })

  it('maps 403 to PERMISSION_DENIED', () => {
    expect(inferErrorCode(403)).toBe(ErrorCode.PERMISSION_DENIED)
  })

  it('maps 404 to NODE_NOT_FOUND', () => {
    expect(inferErrorCode(404)).toBe(ErrorCode.NODE_NOT_FOUND)
  })

  it('maps 409 to DUPLICATE_ENTRY', () => {
    expect(inferErrorCode(409)).toBe(ErrorCode.DUPLICATE_ENTRY)
  })

  it('maps 429 to RATE_LIMITED', () => {
    expect(inferErrorCode(429)).toBe(ErrorCode.RATE_LIMITED)
  })

  it('maps 500 to INTERNAL_ERROR', () => {
    expect(inferErrorCode(500)).toBe(ErrorCode.INTERNAL_ERROR)
  })

  it('maps unknown status codes to INTERNAL_ERROR', () => {
    expect(inferErrorCode(999)).toBe(ErrorCode.INTERNAL_ERROR)
    expect(inferErrorCode(0)).toBe(ErrorCode.INTERNAL_ERROR)
  })
})
