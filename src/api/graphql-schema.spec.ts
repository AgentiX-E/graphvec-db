/**
 * GraphQL Schema 自省 API 测试
 *
 * 测试清单：
 * 1. 无 SchemaDef 时生成基础 schema
 * 2. 有 SchemaDef 时生成按节点类型分的 GraphQL type
 * 3. 生成的 schema 包含边类型关联关系
 */
import { describe, it, expect } from 'vitest'
import { generateGraphQLSchema } from './graphql-adapter'
import { GraphEngine } from '../core/graph-engine'
import { SchemaDef } from '../schema/schema-types'

describe('generateGraphQLSchema', () => {
  it('无 SchemaDef 时生成基础 schema', () => {
    const engine = new GraphEngine({ path: './test-data/graphql-no-schema' })
    const schema = generateGraphQLSchema(engine)
    expect(schema).toContain('type Query')
    expect(schema).toContain('type Node {')
    expect(schema).toContain('type Edge {')
    expect(schema).toContain('scalar JSON')
  })

  it('有 SchemaDef 时生成按节点类型分的 GraphQL type', () => {
    const engine = new GraphEngine({ path: './test-data/graphql-with-schema' })
    const schemaDef: SchemaDef = {
      nodeTypes: [
        {
          typeId: 1,
          name: 'Person',
          fields: [
            { name: 'name', type: 'string' },
            { name: 'age', type: 'number' },
            { name: 'active', type: 'boolean' },
          ],
        },
        {
          typeId: 2,
          name: 'Company',
          fields: [
            { name: 'name', type: 'string' },
            { name: 'founded', type: 'timestamp' },
          ],
        },
      ],
      edgeTypes: [
        { typeId: 101, name: 'KNOWS', fields: [] },
        { typeId: 102, name: 'WORKS_AT', fields: [{ name: 'since', type: 'number' }] },
      ],
    }
    engine.setSchema(schemaDef)
    const schema = generateGraphQLSchema(engine)
    expect(schema).toContain('type Person {')
    expect(schema).toContain('type Company {')
    expect(schema).toContain('_id: ID!')
    expect(schema).toContain('name: String')
    expect(schema).toContain('age: Int')
    expect(schema).toContain('active: Boolean')
    expect(schema).toContain('founded: String')
    expect(schema).toContain('person(id: ID): Person')
    expect(schema).toContain('persons(limit: Int): [Person]')
    expect(schema).toContain('company(id: ID): Company')
    expect(schema).toContain('companys(limit: Int): [Company]')
  })

  it('生成的 schema 包含边类型关联关系', () => {
    const engine = new GraphEngine({ path: './test-data/graphql-with-edges' })
    const schemaDef: SchemaDef = {
      nodeTypes: [
        {
          typeId: 1,
          name: 'Person',
          fields: [{ name: 'name', type: 'string' }],
        },
      ],
      edgeTypes: [
        { typeId: 101, name: 'KNOWS', fields: [] },
        { typeId: 102, name: 'FOLLOWS', fields: [] },
      ],
    }
    engine.setSchema(schemaDef)
    const schema = generateGraphQLSchema(engine)
    expect(schema).toContain('KNOWS')
    expect(schema).toContain('FOLLOWS')
    expect(schema).toContain('@relationship')
    expect(schema).toContain('scalar JSON')
    expect(schema).toContain('type Query')
  })
})
