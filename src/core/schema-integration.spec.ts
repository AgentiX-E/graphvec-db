import { GraphEngine } from '../core/graph-engine'
import { cleanTestData, testEngineConfig } from '../../test/fixtures/test-graph'
import { SchemaDef } from '../schema/schema-types'
import * as schemaValidator from '../schema/schema-validator'

describe('GraphEngine + Schema 集成测试', () => {
  let engine: GraphEngine

  beforeAll(() => {
    cleanTestData()
    engine = new GraphEngine(testEngineConfig)
    engine.open()
  })

  afterAll(() => {
    engine.close()
    cleanTestData()
  })

  // ──────────────────────────────────────────
  // 正常路径
  // ──────────────────────────────────────────

  describe('正常路径', () => {
    const userSchema: SchemaDef = {
      nodeTypes: [
        {
          typeId: 100,
          name: 'User',
          fields: [
            { name: 'name', type: 'string', required: true },
            { name: 'age', type: 'number', required: true },
            { name: 'email', type: 'string', required: false },
          ],
        },
      ],
      edgeTypes: [
        {
          typeId: 200,
          name: 'FOLLOWS',
          fields: [
            { name: 'since', type: 'number', required: false },
          ],
        },
      ],
    }

    beforeAll(() => {
      engine.setSchema(userSchema)
    })

    afterAll(() => {
      engine.setSchema({ nodeTypes: [], edgeTypes: [] })
    })

    test('符合 Schema 的数据能正常 upsertNode', async () => {
      const id = await engine.upsertNode(100, 'alice', { props: { name: 'Alice', age: 30 } })
      expect(id).toBeGreaterThan(0)

      const node = engine.getNode(id)
      expect(node).not.toBeNull()
      expect(node!.props.name).toBe('Alice')
      expect(node!.props.age).toBe(30)
    })

    test('Optional字段可缺省', async () => {
      const id = await engine.upsertNode(100, 'bob', { props: { name: 'Bob', age: 25 } })
      expect(id).toBeGreaterThan(0)
      // email is optional, not provided → no error
      const node = engine.getNode(id)
      expect(node).not.toBeNull()
      expect(node!.props.email).toBeUndefined()
    })

    test('upsertEdge 校验通过', async () => {
      const a = await engine.upsertNode(100, 'edge-src', { props: { name: 'Src', age: 20 } })
      const b = await engine.upsertNode(100, 'edge-dst', { props: { name: 'Dst', age: 22 } })
      await expect(engine.upsertEdge(a, b, 200, { props: { since: 2024 } })).resolves.toBeUndefined()

      const edge = engine.getEdge(a, b, 200)
      expect(edge).not.toBeNull()
      expect(edge!.src).toBe(a)
      expect(edge!.dst).toBe(b)
      expect(edge!.type).toBe(200)
    })
  })

  // ──────────────────────────────────────────
  // 异常路径
  // ──────────────────────────────────────────

  describe('异常路径', () => {
    const strictSchema: SchemaDef = {
      nodeTypes: [
        {
          typeId: 50,
          name: 'StrictNode',
          fields: [
            { name: 'requiredStr', type: 'string', required: true },
            { name: 'requiredNum', type: 'number', required: true },
          ],
        },
      ],
      edgeTypes: [
        {
          typeId: 60,
          name: 'StrictEdge',
          fields: [
            { name: 'weight', type: 'number', required: true },
          ],
        },
      ],
    }

    beforeAll(() => {
      engine.setSchema(strictSchema)
    })

    afterAll(() => {
      engine.setSchema({ nodeTypes: [], edgeTypes: [] })
    })

    test('缺少必填字段 → 抛出带 "Schema 校验失败" 的 Error', async () => {
      // missing requiredNum
      await expect(
        engine.upsertNode(50, 'incomplete', { props: { requiredStr: 'hello' } }),
      ).rejects.toThrow('Schema 校验失败')
    })

    test('字段类型不匹配（string 传了 number）→ 抛出 Error', async () => {
      // requiredStr expects string, passing number
      await expect(
        engine.upsertNode(50, 'bad-type', { props: { requiredStr: 123, requiredNum: 42 } }),
      ).rejects.toThrow('Schema 校验失败')
    })

    test('字段类型不匹配（number 传了 string）→ 抛出 Error', async () => {
      // requiredNum expects number, passing string
      await expect(
        engine.upsertNode(50, 'bad-type2', { props: { requiredStr: 'hello', requiredNum: 'not-a-number' } }),
      ).rejects.toThrow('Schema 校验失败')
    })

    test('未在 Schema 中定义的 typeId → 不做校验（正常通过）', async () => {
      // typeId=999 not defined in schema → should pass validation
      const id = await engine.upsertNode(999, 'undefined-type', { props: { anything: 'goes' } })
      expect(id).toBeGreaterThan(0)
    })
  })

  // ──────────────────────────────────────────
  // 边界条件
  // ──────────────────────────────────────────

  describe('边界条件', () => {
    test('空 Schema（nodeTypes: []）→ 任意数据正常通过', async () => {
      engine.setSchema({ nodeTypes: [], edgeTypes: [] })
      const id = await engine.upsertNode(1, 'empty-schema-node', { props: { someField: 'value' } })
      expect(id).toBeGreaterThan(0)
    })

    test('传入 null Schema（不配置 schema）→ 不报错，正常写入', async () => {
      // Reset schema to undefined — engine._schema is undefined, skip validation
      // @ts-expect-error accessing private _schema to set to undefined
      engine._schema = undefined
      // Should not throw
      await expect(
        engine.upsertNode(1, 'no-schema-node', { props: { anything: 'goes' } }),
      ).resolves.toBeGreaterThan(0)
    })

    test('校验成功后数据能正确写入存储并可读取', async () => {
      const schema: SchemaDef = {
        nodeTypes: [
          {
            typeId: 70,
            name: 'PersistNode',
            fields: [
              { name: 'title', type: 'string', required: true },
              { name: 'count', type: 'number', required: false },
            ],
          },
        ],
        edgeTypes: [],
      }
      engine.setSchema(schema)

      const id = await engine.upsertNode(70, 'persist-test', {
        props: { title: 'Hello World', count: 42 },
      })

      const node = engine.getNode(id)
      expect(node).not.toBeNull()
      expect(node!.name).toBe('persist-test')
      expect(node!.type).toBe(70)
      expect(node!.props.title).toBe('Hello World')
      expect(node!.props.count).toBe(42)

      // Read again — confirm persistence
      const nodeAgain = engine.getNode(id)
      expect(nodeAgain).not.toBeNull()
      expect(nodeAgain!.props.title).toBe('Hello World')
    })
  })

  // ──────────────────────────────────────────
  // vi.spyOn 验证校验函数被正确调用
  // ──────────────────────────────────────────

  describe('vi.spyOn 验证校验函数调用', () => {
    const spySchema: SchemaDef = {
      nodeTypes: [
        { typeId: 80, name: 'SpyNode', fields: [{ name: 'val', type: 'number', required: true }] },
      ],
      edgeTypes: [
        { typeId: 90, name: 'SpyEdge', fields: [{ name: 'tag', type: 'string', required: false }] },
      ],
    }

    beforeAll(() => {
      engine.setSchema(spySchema)
    })

    afterAll(() => {
      engine.setSchema({ nodeTypes: [], edgeTypes: [] })
    })

    test('upsertNode 应调用 validateNodeType', async () => {
      const spy = vi.spyOn(schemaValidator, 'validateNodeType')

      await engine.upsertNode(80, 'spy-node', { props: { val: 1 } })

      expect(spy).toHaveBeenCalled()
      expect(spy).toHaveBeenCalledWith(80, { val: 1 }, spySchema)

      spy.mockRestore()
    })

    test('upsertEdge 应调用 validateEdgeType', async () => {
      const spy = vi.spyOn(schemaValidator, 'validateEdgeType')

      const a = await engine.upsertNode(80, 'spy-edge-a', { props: { val: 1 } })
      const b = await engine.upsertNode(80, 'spy-edge-b', { props: { val: 2 } })
      await engine.upsertEdge(a, b, 90, { props: { tag: 'test' } })

      expect(spy).toHaveBeenCalled()
      expect(spy).toHaveBeenCalledWith(90, { tag: 'test' }, spySchema)

      spy.mockRestore()
    })

    test('未配置 Schema 时不调用校验函数', async () => {
      // @ts-expect-error accessing private _schema to set to undefined
      engine._schema = undefined

      const nodeSpy = vi.spyOn(schemaValidator, 'validateNodeType')
      const edgeSpy = vi.spyOn(schemaValidator, 'validateEdgeType')

      // No schema → validation functions should NOT be called
      await expect(
        engine.upsertNode(1, 'no-schema-spy', { props: { x: 1 } }),
      ).resolves.toBeGreaterThan(0)

      expect(nodeSpy).not.toHaveBeenCalled()
      expect(edgeSpy).not.toHaveBeenCalled()

      nodeSpy.mockRestore()
      edgeSpy.mockRestore()
    })
  })
})
