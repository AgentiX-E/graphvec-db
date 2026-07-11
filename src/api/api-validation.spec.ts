/**
 * api-validation.spec.ts — 参数验证函数测试
 */
import {
  validate,
  validateFirst,
  createNodeSchema,
  batchNeighborsSchema,
  querySchema,
  validateIdsArray,
  ValidationSchema,
} from './api-validation'

describe('api-validation', () => {
  describe('validate() — 通用验证', () => {
    test('should pass for valid data matching schema', () => {
      const data = { name: 'hello', age: 25 }
      const schema: ValidationSchema = {
        name: { required: true, type: 'string', min: 1, max: 100 },
        age: { required: true, type: 'number', min: 0, max: 200 },
      }
      expect(validate(data, schema)).toEqual([])
    })

    test('should reject missing required field', () => {
      const data = { name: 'hello' }
      const schema: ValidationSchema = {
        name: { required: true, type: 'string' },
        age: { required: true, type: 'number' },
      }
      const errors = validate(data, schema)
      expect(errors.length).toBe(1)
      expect(errors[0].field).toBe('age')
      expect(errors[0].message).toContain('required')
    })

    test('should reject wrong type', () => {
      const data = { name: 123 }
      const schema: ValidationSchema = {
        name: { required: true, type: 'string' },
      }
      const errors = validate(data, schema)
      expect(errors.length).toBe(1)
      expect(errors[0].field).toBe('name')
      expect(errors[0].message).toContain('must be a string')
    })

    test('should reject values outside min/max range', () => {
      const data = { score: 150 }
      const schema: ValidationSchema = {
        score: { type: 'number', min: 0, max: 100 },
      }
      const errors = validate(data, schema)
      expect(errors.length).toBe(1)
      expect(errors[0].field).toBe('score')
      expect(errors[0].message).toContain('<= 100')
    })

    test('should reject values below min', () => {
      const data = { count: -5 }
      const schema: ValidationSchema = {
        count: { type: 'number', min: 0 },
      }
      const errors = validate(data, schema)
      expect(errors.length).toBe(1)
      expect(errors[0].message).toContain('>= 0')
    })

    test('should accept optional missing field', () => {
      const data = { name: 'test' }
      const schema: ValidationSchema = {
        name: { required: true, type: 'string' },
        optionalField: { type: 'number' },
      }
      expect(validate(data, schema)).toEqual([])
    })
  })

  describe('validateFirst() — 第一个Error', () => {
    test('should return null for valid data', () => {
      expect(validateFirst({ name: 'ok' }, { name: { type: 'string' } })).toBeNull()
    })

    test('should return the first error', () => {
      const err = validateFirst(
        { a: 1 },
        { a: { type: 'string' }, b: { required: true } },
      )
      expect(err).not.toBeNull()
      expect(err!.field).toBe('a')
    })
  })

  describe('createNodeSchema() — 创建节点验证', () => {
    test('should accept valid create node payload', () => {
      const data = { typeId: 5, name: 'test-node' }
      expect(validate(data, createNodeSchema())).toEqual([])
    })

    test('should reject missing name', () => {
      const data = { typeId: 5 }
      const errors = validate(data, createNodeSchema())
      expect(errors.some(e => e.field === 'name')).toBe(true)
    })

    test('should reject typeId out of range', () => {
      const data = { typeId: 9999, name: 'test' }
      const errors = validate(data, createNodeSchema())
      expect(errors.some(e => e.field === 'typeId')).toBe(true)
    })

    test('should reject empty name', () => {
      const data = { typeId: 1, name: '' }
      const errors = validate(data, createNodeSchema())
      expect(errors.some(e => e.field === 'name')).toBe(true)
    })

    test('should reject name exceeding max length', () => {
      const data = { typeId: 1, name: 'a'.repeat(300) }
      const errors = validate(data, createNodeSchema())
      expect(errors.some(e => e.field === 'name')).toBe(true)
    })
  })

  describe('batchNeighborsSchema() + validateIdsArray', () => {
    test('should accept valid batch-neighbors payload', () => {
      const data = { ids: [1, 2, 3] }
      expect(validate(data, batchNeighborsSchema())).toEqual([])
      expect(validateIdsArray(data)).toBeNull()
    })

    test('should reject missing ids field', () => {
      const data = {}
      const errors = validate(data, batchNeighborsSchema())
      expect(errors.some(e => e.field === 'ids')).toBe(true)
    })

    test('validateIdsArray: should reject non-array ids', () => {
      const err = validateIdsArray({ ids: 'not-array' })
      expect(err).not.toBeNull()
      expect(err!.message).toContain('must be an array')
    })

    test('validateIdsArray: should reject empty array', () => {
      const err = validateIdsArray({ ids: [] })
      expect(err).not.toBeNull()
      expect(err!.message).toContain('non-empty')
    })

    test('validateIdsArray: should reject non-numeric elements', () => {
      const err = validateIdsArray({ ids: [1, 'abc', 3] })
      expect(err).not.toBeNull()
      expect(err!.message).toContain('must be a number')
    })
  })

  describe('querySchema() — 查询验证', () => {
    test('should accept valid query payload', () => {
      const data = { cypher: 'MATCH (n) RETURN n' }
      expect(validate(data, querySchema())).toEqual([])
    })

    test('should reject empty cypher', () => {
      const data = { cypher: '' }
      const errors = validate(data, querySchema())
      expect(errors.some(e => e.field === 'cypher')).toBe(true)
    })

    test('should reject cypher exceeding max length', () => {
      const data = { cypher: 'x'.repeat(5000) }
      const errors = validate(data, querySchema())
      expect(errors.some(e => e.field === 'cypher')).toBe(true)
    })

    test('should accept query with optional limit', () => {
      const data = { cypher: 'MATCH (n) RETURN n', limit: 100 }
      expect(validate(data, querySchema())).toEqual([])
    })
  })
})
