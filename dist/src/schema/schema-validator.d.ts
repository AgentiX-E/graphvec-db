/**
 * schema-validator.ts — Schema 字段校验器
 *
 * 在 upsertNode/upsertEdge 之前校验：
 * - typeId 是否在 Schema 中定义
 * - 必填字段是否缺失
 * - 字段类型是否匹配
 * - 唯一性约束（需要 GraphEngine 配合查询）
 */
import { NodeProperties } from '../types';
import { SchemaDef, ValidationResult } from './schema-types';
/**
 * 校验节点属性是否符合 Schema
 */
export declare function validateNodeType(typeId: number, props: NodeProperties, schema: SchemaDef): ValidationResult;
/**
 * 校验边属性是否符合 Schema
 */
export declare function validateEdgeType(typeId: number, props: NodeProperties, schema: SchemaDef): ValidationResult;
//# sourceMappingURL=schema-validator.d.ts.map