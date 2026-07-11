/**
 * schema-validator.spec.ts — SchemaValidator 测试
 *
 * 测试点：
 * - SchemaDefinition 接口使用
 * - validateNode / validateEdge
 * - 必填字段校验
 * - 类型校验
 * - Default value填充
 * - writeSchema / getSchema / disableSchema
 * - 唯一约束获取
 * - 集成到 GraphEngine 路径
 */
import { describe, test, expect } from 'vitest'
import { SchemaValidator, SchemaDefinition, validateNodeType, validateEdgeType, applyDefaults } from './schema-validator'
import { SchemaDef, FieldDef, ValidationResult } from './schema-types'

describe('SchemaValidator', () => {
  describe('GAP-29: SchemaValidator 基本功能', () => {
    test('should create empty validator and have no schema', () => {
      const validator = new SchemaValidator()
      expect(validator.getSchema()).toBeNull()
      expect(validator.isEnabled()).toBe(false)
    })

    test('should set and get schema', () => {
      const validator = new SchemaValidator()
      const schema: SchemaDef = {
        nodeTypes: [
          { typeId: 1, name: 'Person', fields: [{ name: 'name', type: 'string' }] },
        ],
        edgeTypes: [],
      }
      validator.setSchema(schema)
      expect(validator.getSchema()).toEqual(schema)
      expect(validator.isEnabled()).toBe(true)
    })

    test('should validate node correctly', () => {
      const validator = new SchemaValidator()
      validator.setSchema({
        nodeTypes: [
          {
            typeId: 1,
            name: 'Person',
            fields: [
              { name: 'name', type: 'string', required: true },
              { name: 'age', type: 'number' },
            ],
          },
        ],
        edgeTypes: [],
      })

      const result1 = validator.validateNode(1, { name: 'Alice', age: 30 })
      expect(result1.valid).toBe(true)
      expect(result1.errors).toHaveLength(0)

      const result2 = validator.validateNode(1, { name: 'Bob' })
      expect(result2.valid).toBe(true)

      const result3 = validator.validateNode(1, { age: 30 })
      expect(result3.valid).toBe(false)
      expect(result3.errors).toContain('[Person] 缺少必填字段: name')
    })

    test('should validate edge correctly', () => {
      const validator = new SchemaValidator()
      validator.setSchema({
        nodeTypes: [],
        edgeTypes: [
          {
            typeId: 101,
            name: 'KNOWS',
            fields: [
              { name: 'since', type: 'number', required: true },
              { name: 'weight', type: 'number', default: 1.0 },
            ],
          },
        ],
      })

      const result1 = validator.validateEdge(101, { since: 2020 })
      expect(result1.valid).toBe(true)

      const result2 = validator.validateEdge(101, {})
      expect(result2.valid).toBe(false)
      expect(result2.errors).toContain('[KNOWS] 缺少必填字段: since')
    })

    test('should skip unknown typeIds', () => {
      const validator = new SchemaValidator()
      validator.setSchema({
        nodeTypes: [{ typeId: 1, name: 'Person', fields: [{ name: 'name', type: 'string' }] }],
        edgeTypes: [],
      })

      const result = validator.validateNode(999, {})
      expect(result.valid).toBe(true)
    })

    test('should be valid when disabled', () => {
      const validator = new SchemaValidator()
      validator.setSchema({
        nodeTypes: [{ typeId: 1, name: 'Person', fields: [{ name: 'name', type: 'string', required: true }] }],
        edgeTypes: [],
      })
      validator.disableSchema()

      const result = validator.validateNode(1, {})
      expect(result.valid).toBe(true)

      validator.enableSchema()
      const result2 = validator.validateNode(1, {})
      expect(result2.valid).toBe(false)
    })
  })

  describe('GAP-29: 类型校验', () => {
    const schema: SchemaDef = {
      nodeTypes: [{
        typeId: 1,
        name: 'Test',
        fields: [
          { name: 'str', type: 'string' },
          { name: 'num', type: 'number' },
          { name: 'bool', type: 'boolean' },
          { name: 'ts', type: 'timestamp' },
          { name: 'strArr', type: 'string[]' },
          { name: 'numArr', type: 'number[]' },
        ],
      }],
      edgeTypes: [],
    }

    test('should accept correct types', () => {
      const validator = new SchemaValidator()
      validator.setSchema(schema)
      const result = validator.validateNode(1, {
        str: 'hello',
        num: 42,
        bool: true,
        ts: 1700000000000,
        strArr: ['a', 'b'],
        numArr: [1, 2, 3],
      })
      expect(result.valid).toBe(true)
    })

    test('should reject wrong types', () => {
      const validator = new SchemaValidator()
      validator.setSchema(schema)
      const result = validator.validateNode(1, {
        str: 123,
        num: 'abc',
        bool: 'yes',
        strArr: [1, 2],
        numArr: ['a', 'b'],
      })
      expect(result.valid).toBe(false)
      expect(result.errors.length).toBeGreaterThanOrEqual(4)
    })
  })

  describe('GAP-29: Default value填充', () => {
    test('applyDefaults should fill missing fields', () => {
      const validator = new SchemaValidator()
      validator.setSchema({
        nodeTypes: [{
          typeId: 1,
          name: 'Config',
          fields: [
            { name: 'name', type: 'string' },
            { name: 'enabled', type: 'boolean', default: true },
            { name: 'retries', type: 'number', default: 3 },
            { name: 'mode', type: 'string', default: 'auto' },
          ],
        }],
        edgeTypes: [],
      })

      const filled = validator.applyDefaults(1, { name: 'test' })
      expect(filled.name).toBe('test')
      expect(filled.enabled).toBe(true)
      expect(filled.retries).toBe(3)
      expect(filled.mode).toBe('auto')
    })

    test('validateAndApplyDefaults should fill and validate', () => {
      const validator = new SchemaValidator()
      validator.setSchema({
        nodeTypes: [{
          typeId: 1,
          name: 'Item',
          fields: [
            { name: 'id', type: 'string', required: true },
            { name: 'label', type: 'string', default: 'default' },
          ],
        }],
        edgeTypes: [],
      })

      const result = validator.validateAndApplyDefaults(1, { id: 'abc' })
      expect(result.props.label).toBe('default')
      expect(result.result.valid).toBe(true)
    })

    test('applyDefaults should not override provided values', () => {
      const validator = new SchemaValidator()
      validator.setSchema({
        nodeTypes: [{
          typeId: 1,
          name: 'Test',
          fields: [
            { name: 'name', type: 'string', default: 'default-name' },
          ],
        }],
        edgeTypes: [],
      })

      const filled = validator.applyDefaults(1, { name: 'custom' })
      expect(filled.name).toBe('custom')
    })

    test('should work with standalone applyDefaults function', () => {
      const schema: SchemaDef = {
        nodeTypes: [{
          typeId: 1,
          name: 'Test',
          fields: [{ name: 'name', type: 'string', default: 'default' }],
        }],
        edgeTypes: [],
      }

      const result = applyDefaults(1, {}, schema)
      expect(result.name).toBe('default')
    })
  })

  describe('GAP-29: SchemaDefinition 接口', () => {
    test('should create schema from SchemaDefinition array', () => {
      const validator = new SchemaValidator()
      const definitions: SchemaDefinition[] = [
        {
          label: 'Person',
          typeId: 1,
          propertyTypes: { name: 'string', age: 'number', email: 'string' },
          required: ['name', 'email'],
          default: { age: 'number' },
        },
      ]
      validator.setSchemaFromDefinitions(definitions)

      const schema = validator.getSchema()
      expect(schema).not.toBeNull()
      expect(schema!.nodeTypes).toHaveLength(1)
      expect(schema!.nodeTypes[0].name).toBe('Person')
      expect(schema!.nodeTypes[0].typeId).toBe(1)
    })

    test('should validate using SchemaDefinition-based schema', () => {
      const validator = new SchemaValidator()
      validator.setSchemaFromDefinitions([
        {
          label: 'Person',
          typeId: 1,
          propertyTypes: { name: 'string', age: 'number' },
          required: ['name'],
          unique: ['email'],
        },
      ])

      const result1 = validator.validateNode(1, { name: 'Alice', age: 30 })
      expect(result1.valid).toBe(true)

      const result2 = validator.validateNode(1, { age: 30 })
      expect(result2.valid).toBe(false)
    })

    test('should get unique constraints', () => {
      const validator = new SchemaValidator()
      validator.setSchema({
        nodeTypes: [{
          typeId: 1,
          name: 'User',
          fields: [
            { name: 'email', type: 'string' },
            { name: 'username', type: 'string' },
          ],
          uniqueConstraints: [['email'], ['username']],
        }],
        edgeTypes: [],
      })

      const constraints = validator.getUniqueConstraints(1)
      expect(constraints).toHaveLength(2)
      expect(constraints[0]).toEqual(['email'])
      expect(constraints[1]).toEqual(['username'])
    })

    test('should return empty array for unknown typeId unique constraints', () => {
      const validator = new SchemaValidator()
      validator.setSchema({
        nodeTypes: [{
          typeId: 1,
          name: 'Test',
          fields: [],
          uniqueConstraints: [['id']],
        }],
        edgeTypes: [],
      })

      expect(validator.getUniqueConstraints(999)).toEqual([])
    })
  })

  describe('GAP-29: 与 GraphEngine 集成路径兼容', () => {
    test('standalone validateNodeType function should work', () => {
      const schema: SchemaDef = {
        nodeTypes: [{
          typeId: 1,
          name: 'Person',
          fields: [{ name: 'name', type: 'string', required: true }],
        }],
        edgeTypes: [],
      }

      const result = validateNodeType(1, { name: 'Alice' }, schema)
      expect(result.valid).toBe(true)
    })

    test('standalone validateEdgeType function should work', () => {
      const schema: SchemaDef = {
        nodeTypes: [],
        edgeTypes: [{
          typeId: 101,
          name: 'KNOWS',
          fields: [{ name: 'since', type: 'number' }],
        }],
      }

      const result = validateEdgeType(101, { since: 2020 }, schema)
      expect(result.valid).toBe(true)
    })
  })
})
