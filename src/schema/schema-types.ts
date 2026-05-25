/**
 * schema-types.ts — Schema 类型定义
 *
 * SchemaDef 定义节点类型和边类型的结构和约束：
 * - 节点类型：typeId, name, properties（每个字段的类型/默认值/可选性/唯一性）
 * - 边类型：typeId, name, properties（字段定义）
 * - 支持唯一性约束和自动索引
 *
 * 在 GraphEngine 中加载后，upsertNode/upsertEdge 前校验。
 */
import { NodeProperties } from '../types'

/** 属性字段的数据类型 */
export type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'timestamp'
  | 'string[]'
  | 'number[]'

/** 单个属性字段的定义 */
export interface FieldDef {
  /** 字段名 */
  name: string
  /** 数据类型 */
  type: FieldType
  /** 是否必填（默认 false） */
  required?: boolean
  /** 默认值（未传时使用） */
  default?: string | number | boolean | null
  /** 字段描述（仅文档用途） */
  description?: string
}

/** 节点类型的 Schema 定义 */
export interface NodeTypeDef {
  /** 节点类型 ID（与 NodeType 枚举一致） */
  typeId: number
  /** 类型名称 */
  name: string
  /** 属性字段定义（可选，不定义则不校验） */
  fields?: FieldDef[]
  /** 唯一约束：指定字段名数组，多个字段组合成唯一键 */
  uniqueConstraints?: string[][]
  /** 是否自动索引 name 字段（默认 true） */
  autoIndexName?: boolean
  /** 描述 */
  description?: string
}

/** 边类型的 Schema 定义 */
export interface EdgeTypeDef {
  /** 边类型 ID */
  typeId: number
  /** 类型名称 */
  name: string
  /** 属性字段定义 */
  fields?: FieldDef[]
  /** 描述 */
  description?: string
}

/** 完整 Schema 定义 */
export interface SchemaDef {
  /** 节点类型定义 */
  nodeTypes: NodeTypeDef[]
  /** 边类型定义 */
  edgeTypes: EdgeTypeDef[]
  /** 全局唯一性：指定字段组合（跨类型，全局唯一） */
  globalUniqueConstraints?: string[][]
}

/**
 * Schema 校验结果
 */
export interface ValidationResult {
  valid: boolean
  errors: string[]
}
