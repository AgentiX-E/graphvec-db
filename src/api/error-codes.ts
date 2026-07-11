// ============================================================
// ErrorCode — 标准Error码枚举
// REST API 响应统一包含 errorCode 字段，方便客户端处理
// ============================================================

export enum ErrorCode {
  /** 节点未找到 */
  NODE_NOT_FOUND = 'NODE_NOT_FOUND',
  /** 边未找到 */
  EDGE_NOT_FOUND = 'EDGE_NOT_FOUND',
  /** 查询语法Error */
  INVALID_QUERY = 'INVALID_QUERY',
  /** 输入参数校验失败 */
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  /** 重复条目 */
  DUPLICATE_ENTRY = 'DUPLICATE_ENTRY',
  /** 事务Error */
  TRANSACTION_ERROR = 'TRANSACTION_ERROR',
  /** 权限不足 */
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  /** 请求频率限制 */
  RATE_LIMITED = 'RATE_LIMITED',
  /** 内部服务Error */
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

/**
 * 根据 HTTP 状态码推断最匹配的 ErrorCode。
 * 保持函数名一致（rest.ts 导入 inferErrorCode）。
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

/**
 * 将Error实例映射为 ErrorCode（按消息关键词匹配），
 * 如果无法识别则回退到 statusCode 推断。
 */
export function errorToCode(err: unknown, statusCode?: number): ErrorCode {
  // ...(保留或删除)
}
