/**
 * graphql-adapter.spec.ts — GraphQL Adapter 测试（含 Mutation）
 */
import { GraphQLAdapter, ResolverMap, MutationResolvers } from './graphql-adapter'

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

  const mockMutationResolvers: MutationResolvers = {
    createNode: async ({ name, type, props }) => {
      return { id: 4, type: type ?? 0, name, props: props ?? {} }
    },
    createEdge: async ({ src, dst, type, props }) => {
      return { src, dst, type, props: props ?? {} }
    },
    updateNode: async ({ id, name, props }) => {
      return { id, type: 1, name: name ?? 'Updated', props: props ?? {} }
    },
    deleteNode: async ({ id }) => {
      return true
    },
    deleteEdge: async ({ src, dst, type }) => {
      return true
    },
  }

  describe('execute() - Query', () => {
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

  describe('execute() - Mutation', () => {
    test('should create a node', async () => {
      const adapter = new GraphQLAdapter(mockResolvers, mockMutationResolvers)
      const result = await adapter.execute('{ createNode(name: "Charlie", type: 1) { id name } }')
      expect(result).toHaveProperty('createNode')
      const node = result.createNode as any
      expect(node.id).toBe(4)
      expect(node.name).toBe('Charlie')
    })

    test('should create an edge', async () => {
      const adapter = new GraphQLAdapter(mockResolvers, mockMutationResolvers)
      const result = await adapter.execute('{ createEdge(src: 1, dst: 3, type: 12) { src dst type } }')
      expect(result).toHaveProperty('createEdge')
      const edge = result.createEdge as any
      expect(edge.src).toBe(1)
      expect(edge.dst).toBe(3)
      expect(edge.type).toBe(12)
    })

    test('should update a node', async () => {
      const adapter = new GraphQLAdapter(mockResolvers, mockMutationResolvers)
      const result = await adapter.execute('{ updateNode(id: 1, name: "Updated Alice") { id name } }')
      expect(result).toHaveProperty('updateNode')
      const node = result.updateNode as any
      expect(node.id).toBe(1)
      expect(node.name).toBe('Updated Alice')
    })

    test('should delete a node', async () => {
      const adapter = new GraphQLAdapter(mockResolvers, mockMutationResolvers)
      const result = await adapter.execute('{ deleteNode(id: 1) }')
      expect(result).toHaveProperty('deleteNode')
      expect(result.deleteNode).toBe(true)
    })

    test('should delete an edge', async () => {
      const adapter = new GraphQLAdapter(mockResolvers, mockMutationResolvers)
      const result = await adapter.execute('{ deleteEdge(src: 1, dst: 2, type: 10) }')
      expect(result).toHaveProperty('deleteEdge')
      expect(result.deleteEdge).toBe(true)
    })

    test('should reject mutation when no mutation resolvers configured', async () => {
      const adapter = new GraphQLAdapter(mockResolvers)
      await expect(adapter.execute('{ createNode(name: "X") { id } }')).rejects.toThrow(/Unknown field/)
    })
  })

  describe('getSchemaSDL()', () => {
    test('should return query schema without mutation resolvers', () => {
      const adapter = new GraphQLAdapter(mockResolvers)
      const sdl = adapter.getSchemaSDL()
      expect(sdl).toContain('type Query')
      expect(sdl).toContain('nodes(label: String, limit: Int)')
      expect(sdl).toContain('edges(type: String)')
      expect(sdl).toContain('query(cypher: String)')
      expect(sdl).toContain('type Node')
      expect(sdl).toContain('type Edge')
      expect(sdl).not.toContain('type Mutation')
    })

    test('should include mutation type when mutation resolvers configured', () => {
      const adapter = new GraphQLAdapter(mockResolvers, mockMutationResolvers)
      const sdl = adapter.getSchemaSDL()
      expect(sdl).toContain('type Query')
      expect(sdl).toContain('type Mutation')
      expect(sdl).toContain('createNode')
      expect(sdl).toContain('createEdge')
      expect(sdl).toContain('updateNode')
      expect(sdl).toContain('deleteNode')
      expect(sdl).toContain('deleteEdge')
    })
  })
})
