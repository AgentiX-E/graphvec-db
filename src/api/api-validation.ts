/**
 * api-validation.ts — 轻量参数验证函数
 *
 * 用于 REST API 路由的参数验证，替代 RouteHandler 中分散的手工验证。
 * 支持链式组合验证规则，返回统一的验证错误信息。
 *
 * 验证规则：
 *   required    — 字段是否必填
 *   type        — 期望类型 ('string'|'number'|'boolean')
 *   pattern     — 正则匹配（仅 string 类型）
 *   min, max    — 数值或字符串长度范围
 */

export type ValidationType = 'string' | 'number' | 'boolean'

export interface ValidationRule {
  required?: boolean
  type?: ValidationType
  pattern?: RegExp
  min?: number
  max?: number
}

export interface ValidationSchema {
  [field: string]: ValidationRule
}

export interface ValidationError {
  field: string
  message: string
}

/**
 * 验证一组输入数据是否符合 schema 规则。
 * 返回 ValidationError[]，空数组 = 验证通过。
 */
export function validate(
  data: Record<string, unknown>,
  schema: ValidationSchema,
): ValidationError[] {
  const errors: ValidationError[] = []

  for (const [field, rule] of Object.entries(schema)) {
    const value = data[field]

    // 必填检查
    if (rule.required && (value === undefined || value === null || value === '')) {
      errors.push({ field, message: `${field} is required` })
      continue
    }

    // 可选字段且为 undefined → 跳过后续检查
    if (value === undefined || value === null) {
      continue
    }

    // 类型检查
    if (rule.type) {
      const typeErr = checkType(field, value, rule.type)
      if (typeErr) {
        errors.push(typeErr)
        continue
      }
    }

    // 模式检查（仅 string）
    if (rule.pattern && typeof value === 'string') {
      if (!rule.pattern.test(value)) {
        errors.push({ field, message: `${field} does not match required pattern` })
        continue
      }
    }

    // 范围检查（数值或字符串长度）
    const coerced = rule.type === 'number' ? Number(value) : (typeof value === 'string' ? value.length : value)
    if (typeof coerced === 'number' && !isNaN(coerced)) {
      if (rule.min !== undefined && coerced < rule.min) {
        errors.push({ field, message: `${field} must be >= ${rule.min}` })
        continue
      }
      if (rule.max !== undefined && coerced > rule.max) {
        errors.push({ field, message: `${field} must be <= ${rule.max}` })
      }
    }
  }

  return errors
}

/**
 * 验证并返回第一个错误，或 null
 */
export function validateFirst(
  data: Record<string, unknown>,
  schema: ValidationSchema,
): ValidationError | null {
  const errors = validate(data, schema)
  return errors.length > 0 ? errors[0] : null
}

/**
 * 类型检查辅助函数
 */
function checkType(
  field: string,
  value: unknown,
  expectedType: ValidationType,
): ValidationError | null {
  switch (expectedType) {
    case 'string':
      if (typeof value !== 'string') {
        return { field, message: `${field} must be a string, got ${typeof value}` }
      }
      break
    case 'number': {
      const num = Number(value)
      if (typeof value === 'number' && !isNaN(num)) return null
      if (typeof value === 'string' && !isNaN(num) && value.trim() !== '') return null
      return { field, message: `${field} must be a number, got ${typeof value}` }
    }
    case 'boolean': {
      const str = String(value).toLowerCase()
      if (str !== 'true' && str !== 'false' && str !== '1' && str !== '0') {
        return { field, message: `${field} must be a boolean, got ${typeof value}` }
      }
      break
    }
  }
  return null
}

/**
 * 创建 create-node 的验证 schema
 */
export function createNodeSchema(): ValidationSchema {
  return {
    typeId: { required: true, type: 'number', min: 1, max: 1000 },
    name: { required: true, type: 'string', min: 1, max: 256 },
  }
}

/**
 * 创建 batch-neighbors 的验证 schema
 *
 * ids 字段不自带 type 检查（因为它是数组），
 * 由 validateIdsArray 单独处理。
 */
export function batchNeighborsSchema(): ValidationSchema {
  return {
    ids: { required: true },
  }
}

/**
 * 自定义验证：ids 必须是非空数字数组
 */
export function validateIdsArray(data: Record<string, unknown>): ValidationError | null {
  const ids = data.ids
  if (!Array.isArray(ids)) {
    return { field: 'ids', message: 'ids must be an array' }
  }
  if (ids.length === 0) {
    return { field: 'ids', message: 'ids array must be non-empty' }
  }
  for (let i = 0; i < ids.length; i++) {
    if (typeof ids[i] !== 'number' || isNaN(ids[i])) {
      return { field: 'ids', message: `ids[${i}] must be a number, got ${typeof ids[i]}` }
    }
  }
  return null
}

/**
 * 创建 query 的验证 schema
 */
export function querySchema(): ValidationSchema {
  return {
    cypher: { required: true, type: 'string', min: 1, max: 4096 },
    limit: { required: false, type: 'number', min: 1, max: 10000 },
  }
}
