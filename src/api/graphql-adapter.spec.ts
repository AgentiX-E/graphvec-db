/**
 * graphql-adapter.spec.ts — GraphQL Adapter 测试
 */
import { GraphQLAdapter, ResolverMap } from './graphql-adapter'

describe('GraphQLAdapter', () => {
  const mockResolvers: ResolverMap = {
    nodes: async ({ label, limit }) => {
      const allNodes = [
        { id: 1, type: 1, name: 'Alice', props: { age: 30 } },
        { id: 2, type: 1, name: 'Bob', props: { age: 25 } },
        { id: 3, type: 2, name: 'Graph', props: { nodes: 1000 } },
      ]
      let filtered = allNodes
      if (label) {
        filtered = filtered.filter(n => String(n.type) === label || n.name.includes(label))
      }
      if (limit !== undefined) {
        filtered = filtered.slice(0, limit)
      }
      return filtered
    },
    edges: async ({ type }) => {
      const allEdges = [
        { src: 1, dst: 2, type: 10, props: {} },
        { src: 2, dst: 3, type: 11, props: { weight: 1.5 } },
        { src: 1, dst: 3, type: 10, props: {} },
      ]
      if (type) {
        return allEdges.filter(e => String(e.type) === type || e.type === Number(type))
      }
      return allEdges
    },
    query: async ({ cypher }) => {
      if (cypher.includes('MATCH')) {
        return [{ id: 1, name: 'Result' }]
      }
      return { message: 'query executed' }
    },
  }

  describe('execute()', () => {
    test('should execute nodes query with no args', async () => {
      const adapter = new GraphQLAdapter(mockResolvers)
      const result = await adapter.execute('{ nodes { id name } }')
      expect(result).toHaveProperty('nodes')
      expect(Array.isArray(result.nodes)).toBe(true)
      expect((result.nodes as any[]).length).toBe(3)
      expect((result.nodes as any[])[0].id).toBe(1)
      expect((result.nodes as any[])[0].name).toBe('Alice')
    })

    test('should execute nodes query with label and limit', async () => {
      const adapter = new GraphQLAdapter(mockResolvers)
      const result = await adapter.execute('{ nodes(label: "Alice", limit: 1) { id name } }')
      expect(result).toHaveProperty('nodes')
      expect((result.nodes as any[]).length).toBe(1)
      expect((result.nodes as any[])[0].name).toBe('Alice')
    })

    test('should execute edges query', async () => {
      const adapter = new GraphQLAdapter(mockResolvers)
      const result = await adapter.execute('{ edges { src dst type } }')
      expect(result).toHaveProperty('edges')
      expect((result.edges as any[]).length).toBe(3)
      expect((result.edges as any[])[0].src).toBe(1)
      expect((result.edges as any[])[0].dst).toBe(2)
    })

    test('should execute edges query with type filter', async () => {
      const adapter = new GraphQLAdapter(mockResolvers)
      const result = await adapter.execute('{ edges(type: "10") { src dst } }')
      expect(result).toHaveProperty('edges')
      expect((result.edges as any[]).length).toBe(2)
    })

    test('should execute query field', async () => {
      const adapter = new GraphQLAdapter(mockResolvers)
      const result = await adapter.execute('{ query(cypher: "MATCH (n) RETURN n") }')
      expect(result).toHaveProperty('query')
      expect(Array.isArray(result.query)).toBe(true)
    })

    test('should project fields when sub-fields specified', async () => {
      const adapter = new GraphQLAdapter(mockResolvers)
      const result = await adapter.execute('{ nodes(limit: 2) { name } }')
      const nodes = result.nodes as any[]
      expect(nodes.length).toBe(2)
      for (const n of nodes) {
        expect(n).toHaveProperty('name')
        expect(n).not.toHaveProperty('id')
      }
    })

    test('should reject invalid query (no braces)', async () => {
      const adapter = new GraphQLAdapter(mockResolvers)
      await expect(adapter.execute('nodes {}')).rejects.toThrow(/braces/)
    })
  })

  describe('getSchemaSDL()', () => {
    test('should return valid schema string', () => {
      const adapter = new GraphQLAdapter(mockResolvers)
      const sdl = adapter.getSchemaSDL()
      expect(sdl).toContain('type Query')
      expect(sdl).toContain('nodes(label: String, limit: Int)')
      expect(sdl).toContain('edges(type: String)')
      expect(sdl).toContain('query(cypher: String)')
      expect(sdl).toContain('type Node')
      expect(sdl).toContain('type Edge')
    })
  })
})
