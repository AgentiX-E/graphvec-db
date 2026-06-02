/**
 * schema-validator.ts — Schema 字段校验器
 *
 * 在 upsertNode/upsertEdge 之前校验：
 * - typeId 是否在 Schema 中定义
 * - 必填字段是否缺失
 * - 字段类型是否匹配
 * - 唯一性约束（需要 GraphEngine 配合查询）
 *
 * 增强 (GAP-29)：
 * - SchemaDefinition 接口：label/typeId, propertyTypes, required, unique, default
 * - SchemaValidator 类封装所有校验逻辑
 * - 默认值填充（applyDefaults）
 * - writeSchema / getSchema / disableSchema 管理
 * - 唯一约束支持（unique keys）
 */
import { NodeProperties } from '../types'
import { SchemaDef, NodeTypeDef, EdgeTypeDef, FieldDef, FieldType, ValidationResult } from './schema-types'

// ──────────────────────────────────────────
// SchemaDefinition (GAP-29 enhanced schema)
// ──────────────────────────────────────────

/**
 * 属性类型映射
 */
export interface PropertyTypeMap {
  [propertyName: string]: FieldType
}

/**
 * SchemaDefinition — 简化的 Schema 定义接口
 *
 * 与传统 SchemaDef 相比，提供了更简洁的 label→typeId 映射，
 * 以及更方便的默认值/唯一约束声明。
 */
export interface SchemaDefinition {
  /** label 到 typeId 的映射 */
  label: string | number
  /** typeId（数字） */
  typeId: number
  /** 属性类型映射 */
  propertyTypes: PropertyTypeMap
  /** 必填字段列表 */
  required?: string[]
  /** 唯一键字段列表 */
  unique?: string[]
  /** 默认值映射 */
  default?: Record<string, FieldType | string | number | boolean | null>
}

// ──────────────────────────────────────────
// SchemaValidator 类
// ──────────────────────────────────────────

/**
 * SchemaValidator — Schema 校验和默认值填充
 */
export class SchemaValidator {
  private _schemaDef: SchemaDef | null = null
  private _enabled: boolean = true

  /**
   * 设置 Schema 定义
   */
  setSchema(schema: SchemaDef): void {
    this._schemaDef = schema
    this._enabled = true
  }

  /**
   * 从 SchemaDefinition 数组设置 Schema
   */
  setSchemaFromDefinitions(definitions: SchemaDefinition[]): void {
    const nodeTypes: NodeTypeDef[] = []
    const edgeTypes: NodeTypeDef[] = []

    for (const def of definitions) {
      const fields: FieldDef[] = []
      const uniqueConstraints: string[][] = []

      for (const [propName, propType] of Object.entries(def.propertyTypes)) {
        fields.push({
          name: propName,
          type: propType,
          required: def.required?.includes(propName) ?? false,
          default: def.default?.[propName] as string | number | boolean | null | undefined,
        })
      }

      if (def.unique && def.unique.length > 0) {
        uniqueConstraints.push(def.unique)
      }

      nodeTypes.push({
        typeId: def.typeId,
        name: String(def.label),
        fields,
        uniqueConstraints,
      })
    }

    this._schemaDef = { nodeTypes, edgeTypes }
    this._enabled = true
  }

  /**
   * 获取当前 Schema
   */
  getSchema(): SchemaDef | null {
    return this._schemaDef
  }

  /**
   * 禁用 Schema 校验
   */
  disableSchema(): void {
    this._enabled = false
  }

  /**
   * 启用 Schema 校验
   */
  enableSchema(): void {
    this._enabled = true
  }

  /**
   * 是否启用了 Schema 校验
   */
  isEnabled(): boolean {
    return this._enabled && this._schemaDef !== null
  }

  /**
   * 校验节点属性是否符合 Schema
   *
   * @param typeId 节点类型 ID
   * @param props 节点属性
   * @returns 校验结果
   */
  validateNode(typeId: number, props: NodeProperties): ValidationResult {
    if (!this._enabled || !this._schemaDef) {
      return { valid: true, errors: [] }
    }

    const typeDef = this._schemaDef.nodeTypes.find(t => t.typeId === typeId)
    if (!typeDef) {
      return { valid: true, errors: [] }
    }

    return this._validateFields(typeDef.fields ?? [], props, typeDef.name)
  }

  /**
   * 校验边属性是否符合 Schema
   *
   * @param typeId 边类型 ID
   * @param props 边属性
   * @returns 校验结果
   */
  validateEdge(typeId: number, props: NodeProperties): ValidationResult {
    if (!this._enabled || !this._schemaDef) {
      return { valid: true, errors: [] }
    }

    const typeDef = this._schemaDef.edgeTypes.find(t => t.typeId === typeId)
    if (!typeDef) {
      return { valid: true, errors: [] }
    }

    return this._validateFields(typeDef.fields ?? [], props, typeDef.name)
  }

  /**
   * 填充默认值并校验，返回填充后的 props
   *
   * @param typeId 节点类型 ID
   * @param props 原始属性
   * @returns 填充默认值后的属性
   */
  applyDefaults(typeId: number, props: NodeProperties): NodeProperties {
    if (!this._schemaDef) return { ...props }

    const typeDef = this._schemaDef.nodeTypes.find(t => t.typeId === typeId)
    if (!typeDef || !typeDef.fields) return { ...props }

    const result: NodeProperties = { ...props }

    for (const field of typeDef.fields) {
      if (result[field.name] === undefined && field.default !== undefined) {
        result[field.name] = field.default as string | number | boolean
      }
    }

    return result
  }

  /**
   * 校验并填充默认值，返回最终属性
   */
  validateAndApplyDefaults(typeId: number, props: NodeProperties): { props: NodeProperties; result: ValidationResult } {
    const withDefaults = this.applyDefaults(typeId, props)
    const result = this.validateNode(typeId, withDefaults)
    return { props: withDefaults, result }
  }

  /**
   * 获取指定 typeId 的唯一约束字段列表
   */
  getUniqueConstraints(typeId: number): string[][] {
    if (!this._schemaDef) return []

    const typeDef = this._schemaDef.nodeTypes.find(t => t.typeId === typeId)
    if (!typeDef) return []

    return typeDef.uniqueConstraints ?? []
  }

  // ── 内部方法 ──

  private _validateFields(
    fields: FieldDef[],
    props: NodeProperties,
    typeName: string,
  ): ValidationResult {
    const errors: string[] = []

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
        const typeErr = this._checkType(field.name, val, field.type)
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

  private _checkType(fieldName: string, val: unknown, expected: FieldType): string | null {
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
}

// ──────────────────────────────────────────
// 遗留兼容的独立函数（保持向后兼容）
// ──────────────────────────────────────────

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
    return { valid: true, errors: [] }
  }
  return _legacyValidateFields(typeDef.fields ?? [], props, typeDef.name)
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
  return _legacyValidateFields(typeDef.fields ?? [], props, typeDef.name)
}

/**
 * 填充默认值（独立函数版本）
 */
export function applyDefaults(
  typeId: number,
  props: NodeProperties,
  schema: SchemaDef,
): NodeProperties {
  const typeDef = schema.nodeTypes.find(t => t.typeId === typeId)
  if (!typeDef || !typeDef.fields) return { ...props }

  const result: NodeProperties = { ...props }
  for (const field of typeDef.fields) {
    if (result[field.name] === undefined && field.default !== undefined) {
      result[field.name] = field.default as string | number | boolean
    }
  }
  return result
}

function _legacyValidateFields(
  fields: FieldDef[],
  props: NodeProperties,
  typeName: string,
): ValidationResult {
  const errors: string[] = []
  const fieldMap = new Map(fields.map(f => [f.name, f]))

  for (const field of fields) {
    const val = props[field.name]
    const isProvided = val !== undefined && val !== null

    if (field.required && !isProvided) {
      errors.push(`[${typeName}] 缺少必填字段: ${field.name}`)
      continue
    }

    if (isProvided) {
      const typeErr = _legacyCheckType(field.name, val, field.type)
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

function _legacyCheckType(fieldName: string, val: unknown, expected: FieldType): string | null {
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
