/**
 * error-codes.ts — 标准错误码枚举
 *
 * 用于 REST API 和其他接口的一致错误响应。
 */

export enum ErrorCode {
  NODE_NOT_FOUND = 'NODE_NOT_FOUND',
  EDGE_NOT_FOUND = 'EDGE_NOT_FOUND',
  INVALID_QUERY = 'INVALID_QUERY',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  DUPLICATE_ENTRY = 'DUPLICATE_ENTRY',
  TRANSACTION_ERROR = 'TRANSACTION_ERROR',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  RATE_LIMITED = 'RATE_LIMITED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

/**
 * 根据 HTTP 状态码推断最匹配的 ErrorCode
 */
export function inferErrorCode(statusCode: number): ErrorCode {
  switch (statusCode) {
    case 400:
      return ErrorCode.VALIDATION_ERROR
    case 401:
    case 403:
      return ErrorCode.PERMISSION_DENIED
    case 404:
      return ErrorCode.NODE_NOT_FOUND
    case 409:
      return ErrorCode.DUPLICATE_ENTRY
    case 429:
      return ErrorCode.RATE_LIMITED
    case 500:
    default:
      return ErrorCode.INTERNAL_ERROR
  }
}
