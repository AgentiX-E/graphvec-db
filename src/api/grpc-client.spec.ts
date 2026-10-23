import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

// We mock both gRPC modules to avoid loading proto files in tests
// Using class extends to ensure `new` keyword works

const mockMethods: Record<string, Mock> = {}

class MockGrpcClient {
  close = vi.fn()
  // All gRPC methods are captured dynamically
}

const mockInstance = new MockGrpcClient()

// Set up all method mocks
const methodNames = [
  'GetNode', 'AddNode', 'UpdateNode', 'DeleteNode',
  'GetEdge', 'AddEdge', 'UpdateEdge', 'DeleteEdge',
  'Query', 'Neighbors', 'BatchNeighbors', 'Health',
]
for (const name of methodNames) {
  mockMethods[name] = vi.fn((_req: any, cb: Function) => cb(null, {}))
  ;(mockInstance as any)[name] = mockMethods[name]
}

// GraphService constructor mock
const MockGraphService = vi.fn(function(this: any, _address: string, _creds: any) {
  return mockInstance
})

vi.mock('@grpc/grpc-js', () => ({
  loadPackageDefinition: vi.fn(() => ({
    graphvec: {
      GraphService: MockGraphService,
    },
  })),
  credentials: {
    createInsecure: vi.fn(() => ({})),
  },
}))

vi.mock('@grpc/proto-loader', () => ({
  loadSync: vi.fn(() => ({ graphvec: { GraphService: {} } })),
}))

describe('grpc-client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('exports createGrpcClient function', async () => {
    const mod = await import('./grpc-client')
    expect(mod.createGrpcClient).toBeDefined()
    expect(typeof mod.createGrpcClient).toBe('function')
  })

  it('creates client with all expected methods', async () => {
    const mod = await import('./grpc-client')
    const client = mod.createGrpcClient('localhost:50051')
    const methods: Array<string> = [
      'getNode', 'addNode', 'updateNode', 'deleteNode',
      'getEdge', 'addEdge', 'updateEdge', 'deleteEdge',
      'query', 'neighbors', 'batchNeighbors', 'health', 'close',
    ]
    for (const method of methods) {
      expect(typeof (client as any)[method]).toBe('function')
    }
  })

  it('getNode returns a promise', async () => {
    const mod = await import('./grpc-client')
    const client = mod.createGrpcClient('localhost:50051')
    const promise = client.getNode(42)
    expect(promise).toBeInstanceOf(Promise)
  })

  it('getNode calls GetNode with id', async () => {
    mockMethods.GetNode.mockImplementationOnce((_req: any, cb: Function) => cb(null, { id: 42, name: 'test' }))
    const mod = await import('./grpc-client')
    const client = mod.createGrpcClient('localhost:50051')
    const result = await client.getNode(42)
    expect(mockMethods.GetNode).toHaveBeenCalledWith({ id: 42 }, expect.any(Function))
    expect(result).toEqual({ id: 42, name: 'test' })
  })

  it('addNode passes typeId, name, and props', async () => {
    mockMethods.AddNode.mockImplementationOnce((_req: any, cb: Function) => cb(null, { id: 1 }))
    const mod = await import('./grpc-client')
    const client = mod.createGrpcClient('localhost:50051')
    await client.addNode(1, 'test', { key: 'val' })
    expect(mockMethods.AddNode).toHaveBeenCalledWith(
      { typeId: 1, name: 'test', props: { key: 'val' } },
      expect.any(Function),
    )
  })

  it('addNode defaults props to empty object', async () => {
    mockMethods.AddNode.mockImplementationOnce((_req: any, cb: Function) => cb(null, { id: 2 }))
    const mod = await import('./grpc-client')
    const client = mod.createGrpcClient('localhost:50051')
    await client.addNode(2, 'test')
    expect(mockMethods.AddNode).toHaveBeenCalledWith(
      { typeId: 2, name: 'test', props: {} },
      expect.any(Function),
    )
  })

  it('updateNode passes id and props', async () => {
    mockMethods.UpdateNode.mockImplementationOnce((_req: any, cb: Function) => cb(null, {}))
    const mod = await import('./grpc-client')
    const client = mod.createGrpcClient('localhost:50051')
    await client.updateNode(1, { name: 'new' })
    expect(mockMethods.UpdateNode).toHaveBeenCalledWith(
      { id: 1, props: { name: 'new' } },
      expect.any(Function),
    )
  })

  it('deleteNode passes cascade param', async () => {
    mockMethods.DeleteNode.mockImplementationOnce((_req: any, cb: Function) => cb(null, { success: true }))
    const mod = await import('./grpc-client')
    const client = mod.createGrpcClient('localhost:50051')
    const result = await client.deleteNode(1, true)
    expect(mockMethods.DeleteNode).toHaveBeenCalledWith(
      { id: 1, cascade: true },
      expect.any(Function),
    )
    expect(result).toEqual({ success: true })
  })

  it('deleteNode defaults cascade to false', async () => {
    mockMethods.DeleteNode.mockImplementationOnce((_req: any, cb: Function) => cb(null, { success: true }))
    const mod = await import('./grpc-client')
    const client = mod.createGrpcClient('localhost:50051')
    await client.deleteNode(1)
    expect(mockMethods.DeleteNode).toHaveBeenCalledWith(
      { id: 1, cascade: false },
      expect.any(Function),
    )
  })

  it('addEdge passes all params', async () => {
    mockMethods.AddEdge.mockImplementationOnce((_req: any, cb: Function) => cb(null, { success: true }))
    const mod = await import('./grpc-client')
    const client = mod.createGrpcClient('localhost:50051')
    const result = await client.addEdge(1, 2, 10, { w: '1' }, 0.5)
    expect(mockMethods.AddEdge).toHaveBeenCalledWith(
      { src: 1, dst: 2, typeId: 10, props: { w: '1' }, weight: 0.5 },
      expect.any(Function),
    )
    expect(result).toEqual({ success: true })
  })

  it('addEdge defaults props and weight', async () => {
    mockMethods.AddEdge.mockImplementationOnce((_req: any, cb: Function) => cb(null, { success: true }))
    const mod = await import('./grpc-client')
    const client = mod.createGrpcClient('localhost:50051')
    await client.addEdge(1, 2, 10)
    expect(mockMethods.AddEdge).toHaveBeenCalledWith(
      { src: 1, dst: 2, typeId: 10, props: {}, weight: 0 },
      expect.any(Function),
    )
  })

  it('query passes query string, limit, and skip', async () => {
    mockMethods.Query.mockImplementationOnce((_req: any, cb: Function) => cb(null, { results: [], count: 0 }))
    const mod = await import('./grpc-client')
    const client = mod.createGrpcClient('localhost:50051')
    await client.query('MATCH (n) RETURN n', 10, 0)
    expect(mockMethods.Query).toHaveBeenCalledWith(
      { query: 'MATCH (n) RETURN n', limit: 10, skip: 0 },
      expect.any(Function),
    )
  })

  it('query defaults limit and skip', async () => {
    mockMethods.Query.mockImplementationOnce((_req: any, cb: Function) => cb(null, { results: [], count: 0 }))
    const mod = await import('./grpc-client')
    const client = mod.createGrpcClient('localhost:50051')
    await client.query('MATCH (n) RETURN n')
    expect(mockMethods.Query).toHaveBeenCalledWith(
      { query: 'MATCH (n) RETURN n', limit: 0, skip: 0 },
      expect.any(Function),
    )
  })

  it('neighbors passes maxDepth and edgeTypeFilter', async () => {
    mockMethods.Neighbors.mockImplementationOnce((_req: any, cb: Function) => cb(null, {}))
    const mod = await import('./grpc-client')
    const client = mod.createGrpcClient('localhost:50051')
    await client.neighbors(1, 2, [10, 11])
    expect(mockMethods.Neighbors).toHaveBeenCalledWith(
      { nodeId: 1, maxDepth: 2, edgeTypeFilter: [10, 11] },
      expect.any(Function),
    )
  })

  it('neighbors defaults maxDepth and edgeTypeFilter', async () => {
    mockMethods.Neighbors.mockImplementationOnce((_req: any, cb: Function) => cb(null, {}))
    const mod = await import('./grpc-client')
    const client = mod.createGrpcClient('localhost:50051')
    await client.neighbors(1)
    expect(mockMethods.Neighbors).toHaveBeenCalledWith(
      { nodeId: 1, maxDepth: 1, edgeTypeFilter: [] },
      expect.any(Function),
    )
  })

  it('health returns a promise', async () => {
    mockMethods.Health.mockImplementationOnce((_req: any, cb: Function) => cb(null, { status: 'ok' }))
    const mod = await import('./grpc-client')
    const client = mod.createGrpcClient('localhost:50051')
    const promise = client.health()
    expect(promise).toBeInstanceOf(Promise)
  })

  it('close calls underlying gRPC client close', async () => {
    const mod = await import('./grpc-client')
    const client = mod.createGrpcClient('localhost:50051')
    client.close()
    expect(mockInstance.close).toHaveBeenCalled()
  })

  it('rejects when gRPC GetNode returns error', async () => {
    mockMethods.GetNode.mockImplementationOnce((_req: any, cb: Function) => {
      const err = new Error('not found') as any
      err.code = 5
      cb(err, null)
    })
    const mod = await import('./grpc-client')
    const client = mod.createGrpcClient('localhost:50051')
    await expect(client.getNode(999)).rejects.toThrow('not found')
  })

  it('batchNeighbors passes ids, maxDepth, and edgeTypeFilter', async () => {
    mockMethods.BatchNeighbors.mockImplementationOnce((_req: any, cb: Function) => cb(null, {}))
    const mod = await import('./grpc-client')
    const client = mod.createGrpcClient('localhost:50051')
    await client.batchNeighbors([1, 2, 3], 2, [10])
    expect(mockMethods.BatchNeighbors).toHaveBeenCalledWith(
      { ids: [1, 2, 3], maxDepth: 2, edgeTypeFilter: [10] },
      expect.any(Function),
    )
  })
})
