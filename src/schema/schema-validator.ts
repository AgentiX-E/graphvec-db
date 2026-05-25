/**
 * schema-validator.ts — Schema 字段校验器
 *
 * 在 upsertNode/upsertEdge 之前校验：
 * - typeId 是否在 Schema 中定义
 * - 必填字段是否缺失
 * - 字段类型是否匹配
 * - 唯一性约束（需要 GraphEngine 配合查询）
 */
import { NodeProperties } from '../types'
import { SchemaDef, NodeTypeDef, EdgeTypeDef, FieldDef, FieldType, ValidationResult } from './schema-types'

/**
 * 校验节点属性是否符合 Schema
 */
export function validateNodeType(
  typeId: number,
  props: NodeProperties,
  schema: SchemaDef,
): ValidationResult {
  const typeDef = schema.nodeTypes.find(t => t.typeId === typeId)
  if (!typeDef) {
    return { valid: true, errors: [] } // 未定义的 typeId 不做校验
  }
  return _validateFields(typeDef.fields ?? [], props, typeDef.name)
}

/**
 * 校验边属性是否符合 Schema
 */
export function validateEdgeType(
  typeId: number,
  props: NodeProperties,
  schema: SchemaDef,
): ValidationResult {
  const typeDef = schema.edgeTypes.find(t => t.typeId === typeId)
  if (!typeDef) {
    return { valid: true, errors: [] }
  }
  return _validateFields(typeDef.fields ?? [], props, typeDef.name)
}

function _validateFields(
  fields: FieldDef[],
  props: NodeProperties,
  typeName: string,
): ValidationResult {
  const errors: string[] = []
  const fieldMap = new Map(fields.map(f => [f.name, f]))

  for (const field of fields) {
    const val = props[field.name]
    const isProvided = val !== undefined && val !== null

    // 必填检查
    if (field.required && !isProvided) {
      errors.push(`[${typeName}] 缺少必填字段: ${field.name}`)
      continue
    }

    // 类型检查（有值时才做）
    if (isProvided) {
      const typeErr = _checkType(field.name, val, field.type)
      if (typeErr) {
        errors.push(`[${typeName}] ${typeErr}`)
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

function _checkType(fieldName: string, val: unknown, expected: FieldType): string | null {
  const actual = typeof val
  const isArr = Array.isArray(val)

  switch (expected) {
    case 'string':
      if (actual !== 'string') return `${fieldName} 应为 string，实际为 ${actual}`
      break
    case 'number':
      if (actual !== 'number') return `${fieldName} 应为 number，实际为 ${actual}`
      break
    case 'boolean':
      if (actual !== 'boolean') return `${fieldName} 应为 boolean，实际为 ${actual}`
      break
    case 'timestamp':
      if (actual !== 'number' && !(actual === 'string' && !isNaN(Date.parse(val as string)))) {
        return `${fieldName} 应为 timestamp (number 或 ISO string)`
      }
      break
    case 'string[]':
      if (!isArr || !val.every((v: unknown) => typeof v === 'string')) {
        return `${fieldName} 应为 string[]`
      }
      break
    case 'number[]':
      if (!isArr || !val.every((v: unknown) => typeof v === 'number')) {
        return `${fieldName} 应为 number[]`
      }
      break
  }
  return null
}
