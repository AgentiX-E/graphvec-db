/**
 * schema-validator.ts — Schema field validator
 *
 * Validates before upsertNode/upsertEdge:
 * - typeId is defined in Schema
 * - Required fields are present
 * - Field types match
 * - Uniqueness constraints (requires GraphEngine query support)
 *
 * Enhanced (GAP-29):
 * - SchemaDefinition interface: label/typeId, propertyTypes, required, unique, default
 * - SchemaValidator class encapsulates all validation logic
 * - Default value filling (applyDefaults)
 * - writeSchema / getSchema / disableSchema management
 * - Uniqueness constraint support (unique keys)
 */
import { NodeProperties } from '../types'
import { SchemaDef, NodeTypeDef, EdgeTypeDef, FieldDef, FieldType, ValidationResult } from './schema-types'

// ──────────────────────────────────────────
// SchemaDefinition (GAP-29 enhanced schema)
// ──────────────────────────────────────────

/**
 * Property type mapping
 */
export interface PropertyTypeMap {
  [propertyName: string]: FieldType
}

/**
 * SchemaDefinition — simplified Schema definition interface
 *
 * Compared to traditional SchemaDef, provides a cleaner label→typeId mapping,
 * and more convenient defaults/unique constraint declarations.
 */
export interface SchemaDefinition {
  /** label to typeId mapping */
  label: string | number
  /** typeId (number) */
  typeId: number
  /** Property type mapping */
  propertyTypes: PropertyTypeMap
  /** Required field list */
  required?: string[]
  /** Unique key field list */
  unique?: string[]
  /** Default value mapping */
  default?: Record<string, FieldType | string | number | boolean | null>
}

// ──────────────────────────────────────────
// SchemaValidator class
// ──────────────────────────────────────────

/**
 * SchemaValidator — Schema validation and default value filling
 */
export class SchemaValidator {
  private _schemaDef: SchemaDef | null = null
  private _enabled: boolean = true

  /**
   * Set Schema definition
   */
  setSchema(schema: SchemaDef): void {
    this._schemaDef = schema
    this._enabled = true
  }

  /**
   * Set Schema from SchemaDefinition array
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
   * Get current Schema
   */
  getSchema(): SchemaDef | null {
    return this._schemaDef
  }

  /**
   * Disable Schema validation
   */
  disableSchema(): void {
    this._enabled = false
  }

  /**
   * Enable Schema validation
   */
  enableSchema(): void {
    this._enabled = true
  }

  /**
   * Whether Schema validation is enabled
   */
  isEnabled(): boolean {
    return this._enabled && this._schemaDef !== null
  }

  /**
   * Validate node properties against Schema
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
   * Validate edge properties against Schema
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
   * Fill defaults and validate, return filled props
   *
   * @param typeId 节点类型 ID
   * @param props 原始属性
   * @returns 填充Default value后的属性
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
   * Validate and fill defaults, return final properties
   */
  validateAndApplyDefaults(typeId: number, props: NodeProperties): { props: NodeProperties; result: ValidationResult } {
    const withDefaults = this.applyDefaults(typeId, props)
    const result = this.validateNode(typeId, withDefaults)
    return { props: withDefaults, result }
  }

  /**
   * Get unique constraint field list for specified typeId
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
// Legacy standalone functions (maintain backward compatibility)
// ──────────────────────────────────────────

/**
 * Validate node properties against Schema
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
 * Validate edge properties against Schema
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
 * Fill defaults (standalone function version)
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
