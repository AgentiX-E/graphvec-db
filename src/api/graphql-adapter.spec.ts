/**
 * graphql-adapter.spec.ts — GraphQL Adapter 测试（含 Mutation + Subscription）
 */
import {
  GraphQLAdapter,
  ResolverMap,
  MutationResolvers,
  SubscriptionResolvers,
  DEFAULT_SUBSCRIPTION_RESOLVERS,
  SubscriptionEventType,
} from './graphql-adapter'
import type { NodeRecord, EdgeRecord, NodeProperties } from '../types'

describe('GraphQLAdapter', () => {
  const mockResolvers: ResolverMap = {
    nodes: async ({ label, limit }) => {
      const allNodes: NodeRecord[] = [
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
      const allEdges: EdgeRecord[] = [
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
      return { id: 4, type: type ?? 0, name, props: (props ?? {}) as NodeProperties }
    },
    createEdge: async ({ src, dst, type, props }) => {
      return { src, dst, type, props: (props ?? {}) as NodeProperties }
    },
    updateNode: async ({ id, name, props }) => {
      return { id, type: 1, name: name ?? 'Updated', props: (props ?? {}) as NodeProperties }
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

    test('should include subscription type when subscription resolvers configured', () => {
      const adapter = new GraphQLAdapter(mockResolvers, mockMutationResolvers, DEFAULT_SUBSCRIPTION_RESOLVERS)
      const sdl = adapter.getSchemaSDL()
      expect(sdl).toContain('type Query')
      expect(sdl).toContain('type Mutation')
      expect(sdl).toContain('type Subscription')
      expect(sdl).toContain('nodeCreated')
      expect(sdl).toContain('nodeUpdated')
      expect(sdl).toContain('nodeDeleted')
      expect(sdl).toContain('edgeCreated')
      expect(sdl).toContain('edgeUpdated')
      expect(sdl).toContain('edgeDeleted')
      expect(sdl).toContain('type SubscriptionEvent')
      expect(sdl).toContain('type: String!')
      expect(sdl).toContain('timestamp: Float!')
      expect(sdl).toContain('nodeId: String!')
      expect(sdl).toContain('data: JSON!')
    })
  })

  // ── Subscription (GAP-25) ────────────────────────────────

  describe('execute() - Subscription', () => {
    test('should detect subscription operation from field name', async () => {
      const adapter = new GraphQLAdapter(mockResolvers, mockMutationResolvers, DEFAULT_SUBSCRIPTION_RESOLVERS)
      const result = await adapter.execute('{ nodeCreated { type timestamp } }')

      expect(result).toHaveProperty('nodeCreated')
      const subResult = result.nodeCreated as any
      expect(subResult._subscriptionEvent).toBe('node:created')
      expect(subResult._options).toEqual({ events: 'node:created' })
    })

    test('should return subscription info for nodeDeleted', async () => {
      const adapter = new GraphQLAdapter(mockResolvers, mockMutationResolvers, DEFAULT_SUBSCRIPTION_RESOLVERS)
      const result = await adapter.execute('{ nodeDeleted { type nodeId } }')

      expect(result).toHaveProperty('nodeDeleted')
      const subResult = result.nodeDeleted as any
      expect(subResult._subscriptionEvent).toBe('node:deleted')
      expect(subResult._options).toEqual({ events: 'node:deleted' })
    })

    test('should return subscription info for edgeCreated', async () => {
      const adapter = new GraphQLAdapter(mockResolvers, mockMutationResolvers, DEFAULT_SUBSCRIPTION_RESOLVERS)
      const result = await adapter.execute('{ edgeCreated { data { src dst } } }')

      expect(result).toHaveProperty('edgeCreated')
      const subResult = result.edgeCreated as any
      expect(subResult._subscriptionEvent).toBe('edge:created')
      expect(subResult._options).toEqual({ events: 'edge:created' })
    })

    test('should return subscription info for all 6 event types', async () => {
      const adapter = new GraphQLAdapter(mockResolvers, mockMutationResolvers, DEFAULT_SUBSCRIPTION_RESOLVERS)
      const query = `{ nodeCreated { type } nodeUpdated { type } nodeDeleted { type } edgeCreated { type } edgeUpdated { type } edgeDeleted { type } }`
      const result = await adapter.execute(query)

      expect(result).toHaveProperty('nodeCreated')
      expect(result).toHaveProperty('nodeUpdated')
      expect(result).toHaveProperty('nodeDeleted')
      expect(result).toHaveProperty('edgeCreated')
      expect(result).toHaveProperty('edgeUpdated')
      expect(result).toHaveProperty('edgeDeleted')
    })

    test('should reject unknown subscription fields', async () => {
      const adapter = new GraphQLAdapter(mockResolvers, mockMutationResolvers, DEFAULT_SUBSCRIPTION_RESOLVERS)
      await expect(adapter.execute('{ unknownEvent { type } }')).rejects.toThrow(/Unknown field/)
    })

    test('should detect subscription type via _detectOperationType', () => {
      const adapter = new GraphQLAdapter(mockResolvers, mockMutationResolvers, DEFAULT_SUBSCRIPTION_RESOLVERS)
      const detected = (adapter as any)._detectOperationType('{ nodeCreated { type } }')
      expect(detected).toBe('subscription')
    })

    test('should detect mutation type via _detectOperationType', () => {
      const adapter = new GraphQLAdapter(mockResolvers, mockMutationResolvers, DEFAULT_SUBSCRIPTION_RESOLVERS)
      const detected = (adapter as any)._detectOperationType('{ createNode(name: "X") { id } }')
      expect(detected).toBe('mutation')
    })

    test('should return query type for standard queries', () => {
      const adapter = new GraphQLAdapter(mockResolvers, mockMutationResolvers, DEFAULT_SUBSCRIPTION_RESOLVERS)
      const detected = (adapter as any)._detectOperationType('{ nodes { id } }')
      expect(detected).toBe('query')
    })
  })

  describe('SubscriptionResolvers', () => {
    test('DEFAULT_SUBSCRIPTION_RESOLVERS maps all 6 fields correctly', () => {
      const resolvers = DEFAULT_SUBSCRIPTION_RESOLVERS
      expect(resolvers.getSSEEvent('nodeCreated')).toBe('node:created')
      expect(resolvers.getSSEEvent('nodeUpdated')).toBe('node:updated')
      expect(resolvers.getSSEEvent('nodeDeleted')).toBe('node:deleted')
      expect(resolvers.getSSEEvent('edgeCreated')).toBe('edge:created')
      expect(resolvers.getSSEEvent('edgeUpdated')).toBe('edge:updated')
      expect(resolvers.getSSEEvent('edgeDeleted')).toBe('edge:deleted')
    })

    test('DEFAULT_SUBSCRIPTION_RESOLVERS returns null for unknown field', () => {
      expect(DEFAULT_SUBSCRIPTION_RESOLVERS.getSSEEvent('unknownField')).toBeNull()
    })

    test('listFields returns all 6 subscription fields', () => {
      const fields = DEFAULT_SUBSCRIPTION_RESOLVERS.listFields()
      expect(fields).toHaveLength(6)
      expect(fields).toContain('nodeCreated')
      expect(fields).toContain('edgeDeleted')
    })

    test('getSubscribeOptions returns correct event filter', () => {
      const opts = DEFAULT_SUBSCRIPTION_RESOLVERS.getSubscribeOptions('nodeCreated')
      expect(opts.events).toBe('node:created')
    })
  })
})
