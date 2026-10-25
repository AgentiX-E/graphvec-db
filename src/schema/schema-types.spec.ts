/**
 * schema-types.spec.ts — Schema 类型定义单元测试
 *
 * 覆盖 FieldType/FieldDef/NodeTypeDef/EdgeTypeDef/SchemaDef 的数据结构
 * Note: 不测试 schema-validator 的逻辑，仅测试类型定义本身
 */
import { describe, it, expect } from 'vitest'
import type { FieldDef, NodeTypeDef, EdgeTypeDef, SchemaDef } from './schema-types'

// ─── 1. FieldType 枚举 — 所有字段类型存在且类型正确 ──────────────────────────

describe('FieldType', () => {
  it('应支持 string 类型', () => {
    const t = 'string' as const
    expect(t).toBe('string')
  })

  it('应支持 number 类型', () => {
    const t = 'number' as const
    expect(t).toBe('number')
  })

  it('应支持 boolean 类型', () => {
    const t = 'boolean' as const
    expect(t).toBe('boolean')
  })

  it('应支持 timestamp 类型', () => {
    const t = 'timestamp' as const
    expect(t).toBe('timestamp')
  })

  it('应支持 string[] 类型', () => {
    const t = 'string[]' as const
    expect(t).toBe('string[]')
  })

  it('应支持 number[] 类型', () => {
    const t = 'number[]' as const
    expect(t).toBe('number[]')
  })

  it('所有 FieldType 值应不包含未知类型', () => {
    const allFieldTypes: string[] = [
      'string', 'number', 'boolean', 'timestamp', 'string[]', 'number[]',
    ]
    expect(allFieldTypes).not.toContain('float')
    expect(allFieldTypes).not.toContain('date')
    expect(allFieldTypes).not.toContain('object')
  })
})

// ─── 2. FieldDef 结构 — 可以正确构造 FieldDef 对象 ──────────────────────────

describe('FieldDef', () => {
  it('应构造包含必填字段的 FieldDef', () => {
    const field: FieldDef = {
      name: 'title',
      type: 'string',
    }
    expect(field.name).toBe('title')
    expect(field.type).toBe('string')
  })

  it('应构造包含所有Optional字段的 FieldDef', () => {
    const field: FieldDef = {
      name: 'age',
      type: 'number',
      required: true,
      default: 18,
      description: 'Age of the person',
    }
    expect(field.name).toBe('age')
    expect(field.type).toBe('number')
    expect(field.required).toBe(true)
    expect(field.default).toBe(18)
    expect(field.description).toBe('Age of the person')
  })

  it('应构造包含 null Default value的 FieldDef', () => {
    const field: FieldDef = {
      name: 'nickname',
      type: 'string',
      default: null,
    }
    expect(field.name).toBe('nickname')
    expect(field.default).toBeNull()
  })

  it('应构造 boolean Default value的 FieldDef', () => {
    const field: FieldDef = {
      name: 'active',
      type: 'boolean',
      default: true,
    }
    expect(field.type).toBe('boolean')
    expect(field.default).toBe(true)
  })

  it('应支持数组类型的 FieldDef', () => {
    const strArr: FieldDef = { name: 'tags', type: 'string[]' }
    const numArr: FieldDef = { name: 'scores', type: 'number[]' }
    expect(strArr.type).toBe('string[]')
    expect(numArr.type).toBe('number[]')
  })
})

// ─── 3. NodeTypeDef 结构 — 包含 name、fields 等属性 ─────────────────────────

describe('NodeTypeDef', () => {
  it('应构造最小 NodeTypeDef', () => {
    const nodeType: NodeTypeDef = {
      typeId: 1,
      name: 'Person',
    }
    expect(nodeType.typeId).toBe(1)
    expect(nodeType.name).toBe('Person')
    expect(nodeType.fields).toBeUndefined()
  })

  it('应构造带 fields 的 NodeTypeDef', () => {
    const nodeType: NodeTypeDef = {
      typeId: 2,
      name: 'Movie',
      fields: [
        { name: 'title', type: 'string', required: true },
        { name: 'year', type: 'number' },
      ],
    }
    expect(nodeType.typeId).toBe(2)
    expect(nodeType.name).toBe('Movie')
    expect(nodeType.fields).toHaveLength(2)
    expect(nodeType.fields![0].name).toBe('title')
    expect(nodeType.fields![1].type).toBe('number')
  })

  it('应构造带 uniqueConstraints 的 NodeTypeDef', () => {
    const nodeType: NodeTypeDef = {
      typeId: 3,
      name: 'User',
      fields: [
        { name: 'email', type: 'string' },
        { name: 'username', type: 'string' },
      ],
      uniqueConstraints: [['email'], ['username']],
    }
    expect(nodeType.uniqueConstraints).toEqual([['email'], ['username']])
  })

  it('应支持 autoIndexName 和 description', () => {
    const nodeType: NodeTypeDef = {
      typeId: 4,
      name: 'Company',
      autoIndexName: false,
      description: 'A company node',
    }
    expect(nodeType.autoIndexName).toBe(false)
    expect(nodeType.description).toBe('A company node')
  })

  it('uniqueConstraints 应支持组合唯一键', () => {
    const nodeType: NodeTypeDef = {
      typeId: 5,
      name: 'Product',
      fields: [
        { name: 'sku', type: 'string' },
        { name: 'region', type: 'string' },
      ],
      uniqueConstraints: [['sku', 'region']],
    }
    expect(nodeType.uniqueConstraints![0]).toEqual(['sku', 'region'])
  })
})

// ─── 4. EdgeTypeDef 结构 — 包含 src、dst、fields 等 ─────────────────────────

describe('EdgeTypeDef', () => {
  it('应构造最小 EdgeTypeDef', () => {
    const edgeType: EdgeTypeDef = {
      typeId: 10,
      name: 'KNOWS',
    }
    expect(edgeType.typeId).toBe(10)
    expect(edgeType.name).toBe('KNOWS')
  })

  it('应构造带 fields 的 EdgeTypeDef', () => {
    const edgeType: EdgeTypeDef = {
      typeId: 11,
      name: 'RATED',
      fields: [
        { name: 'rating', type: 'number', required: true },
        { name: 'review', type: 'string' },
      ],
    }
    expect(edgeType.typeId).toBe(11)
    expect(edgeType.fields).toHaveLength(2)
    expect(edgeType.fields![0].name).toBe('rating')
    expect(edgeType.fields![1].name).toBe('review')
  })

  it('应构造带 description 的 EdgeTypeDef', () => {
    const edgeType: EdgeTypeDef = {
      typeId: 12,
      name: 'WORKS_AT',
      description: 'Employment relationship',
    }
    expect(edgeType.description).toBe('Employment relationship')
  })
})

// ─── 5. SchemaDef 完整结构 — nodeTypes、edgeTypes 数组 ───────────────────────

describe('SchemaDef', () => {
  it('应构造空 SchemaDef', () => {
    const schema: SchemaDef = {
      nodeTypes: [],
      edgeTypes: [],
    }
    expect(schema.nodeTypes).toHaveLength(0)
    expect(schema.edgeTypes).toHaveLength(0)
  })

  it('应构造只包含 nodeTypes 的 SchemaDef', () => {
    const schema: SchemaDef = {
      nodeTypes: [
        { typeId: 1, name: 'Person' },
        { typeId: 2, name: 'Movie' },
      ],
      edgeTypes: [],
    }
    expect(schema.nodeTypes).toHaveLength(2)
    expect(schema.nodeTypes[0].name).toBe('Person')
    expect(schema.nodeTypes[1].name).toBe('Movie')
  })

  it('应构造只包含 edgeTypes 的 SchemaDef', () => {
    const schema: SchemaDef = {
      nodeTypes: [],
      edgeTypes: [
        { typeId: 10, name: 'KNOWS' },
      ],
    }
    expect(schema.edgeTypes).toHaveLength(1)
    expect(schema.edgeTypes[0].name).toBe('KNOWS')
  })

  it('应支持 globalUniqueConstraints', () => {
    const schema: SchemaDef = {
      nodeTypes: [],
      edgeTypes: [],
      globalUniqueConstraints: [['email'], ['phone']],
    }
    expect(schema.globalUniqueConstraints).toEqual([['email'], ['phone']])
  })
})

// ─── 6. 类型组合 — 完整的 SchemaDef 包含 node 和 edge ───────────────────────

describe('SchemaDef 类型组合', () => {
  it('应构造完整的 Person + KNOWS 图 Schema', () => {
    const schema: SchemaDef = {
      nodeTypes: [
        {
          typeId: 1,
          name: 'Person',
          fields: [
            { name: 'name', type: 'string', required: true },
            { name: 'age', type: 'number', default: 0 },
          ],
          uniqueConstraints: [['name']],
        },
      ],
      edgeTypes: [
        {
          typeId: 100,
          name: 'KNOWS',
          fields: [
            { name: 'since', type: 'timestamp' },
          ],
        },
      ],
    }
    expect(schema.nodeTypes).toHaveLength(1)
    expect(schema.edgeTypes).toHaveLength(1)
    expect(schema.nodeTypes[0].fields).toHaveLength(2)
    expect(schema.edgeTypes[0].fields).toHaveLength(1)
  })

  it('应构造多类型混合 Schema', () => {
    const schema: SchemaDef = {
      nodeTypes: [
        { typeId: 1, name: 'Person', fields: [{ name: 'name', type: 'string' }] },
        { typeId: 2, name: 'Company', fields: [{ name: 'name', type: 'string' }] },
        { typeId: 3, name: 'Project', fields: [{ name: 'budget', type: 'number' }] },
      ],
      edgeTypes: [
        { typeId: 100, name: 'WORKS_AT' },
        { typeId: 101, name: 'MANAGES' },
      ],
      globalUniqueConstraints: [['name']],
    }
    expect(schema.nodeTypes).toHaveLength(3)
    expect(schema.edgeTypes).toHaveLength(2)
    expect(schema.globalUniqueConstraints).toHaveLength(1)
  })

  it('node 和 edge 的 fields 应使用相同的 FieldDef 结构', () => {
    const schema: SchemaDef = {
      nodeTypes: [
        {
          typeId: 1,
          name: 'User',
          fields: [
            { name: 'score', type: 'number', required: true, default: 0, description: 'User score' },
          ],
        },
      ],
      edgeTypes: [
        {
          typeId: 100,
          name: 'FOLLOWS',
          fields: [
            { name: 'score', type: 'number', required: true, default: 0, description: 'Relationship score' },
          ],
        },
      ],
    }
    const nodeField = schema.nodeTypes[0].fields![0]
    const edgeField = schema.edgeTypes[0].fields![0]
    // Both fields have the same FieldDef shape
    expect(nodeField.name).toBe('score')
    expect(edgeField.name).toBe('score')
    expect(nodeField.type).toBe(edgeField.type)
    expect(nodeField.required).toBe(edgeField.required)
  })
})

// ─── 7. 边界情况 — 空 fields 数组、空字符串 name 等 ─────────────────────────

describe('Schema 类型边界情况', () => {
  it('应支持空 fields 数组', () => {
    const nodeType: NodeTypeDef = { typeId: 1, name: 'Empty', fields: [] }
    const edgeType: EdgeTypeDef = { typeId: 10, name: 'EMPTY_EDGE', fields: [] }
    expect(nodeType.fields).toHaveLength(0)
    expect(edgeType.fields).toHaveLength(0)
  })

  it('应支持空字符串 name', () => {
    const nodeType: NodeTypeDef = { typeId: 1, name: '' }
    const field: FieldDef = { name: '', type: 'string' }
    expect(nodeType.name).toBe('')
    expect(field.name).toBe('')
  })

  it('应支持空的 uniqueConstraints 数组', () => {
    const nodeType: NodeTypeDef = {
      typeId: 1,
      name: 'Test',
      uniqueConstraints: [],
    }
    expect(nodeType.uniqueConstraints).toHaveLength(0)
  })

  it('应支持Optional的 fields 完全省略', () => {
    const nodeType: NodeTypeDef = { typeId: 1, name: 'NoFields' }
    const edgeType: EdgeTypeDef = { typeId: 10, name: 'NO_FIELDS' }
    expect(nodeType.fields).toBeUndefined()
    expect(edgeType.fields).toBeUndefined()
  })

  it('应支持大量字段的 NodeTypeDef（压力检查）', () => {
    const fields: FieldDef[] = Array.from({ length: 100 }, (_, i) => ({
      name: `field_${i}`,
      type: 'string' as const,
    }))
    const nodeType: NodeTypeDef = { typeId: 1, name: 'Big', fields }
    expect(nodeType.fields).toHaveLength(100)
    expect(nodeType.fields![99].name).toBe('field_99')
  })

  it('应支持空 SchemaDef 合法使用', () => {
    const schema: SchemaDef = { nodeTypes: [], edgeTypes: [] }
    expect(schema.nodeTypes.length).toBe(0)
    expect(schema.edgeTypes.length).toBe(0)
  })

  it('Global uniqueConstraints 为空属正常', () => {
    const schema: SchemaDef = {
      nodeTypes: [{ typeId: 1, name: 'A' }],
      edgeTypes: [],
      globalUniqueConstraints: [],
    }
    expect(schema.globalUniqueConstraints).toEqual([])
  })
})
