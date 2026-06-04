// ============================================================
// grpc-server.spec.ts — gRPC Server & Client 配置/签名/接口测试
//
// 注意：不测试实际 gRPC 连接。所有 @grpc/grpc-js 调用被 mock。
// 实际集成测试见 grpc.spec.ts。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── 必须在任何导入前 mock ──

vi.mock('@grpc/grpc-js', () => {
  const mockServer = {
    addService: vi.fn(),
    bindAsync: vi.fn(),
    start: vi.fn(),
    tryShutdown: vi.fn((cb: () => void) => cb()),
  }
  const mockServerCtor = vi.fn(function () {
    return mockServer
  })

  // GraphService constructor for client
  // Methods accept (request, callback) pattern — callback immediately
  const mockClient = {
    GetNode: vi.fn((_req: any, cb: Function) => cb(null, { id: 1 })),
    AddNode: vi.fn((_req: any, cb: Function) => cb(null, { id: 1 })),
    UpdateNode: vi.fn((_req: any, cb: Function) => cb(null, { id: 1 })),
    DeleteNode: vi.fn((_req: any, cb: Function) => cb(null, { success: true })),
    GetEdge: vi.fn((_req: any, cb: Function) => cb(null, { src: 1, dst: 2 })),
    AddEdge: vi.fn((_req: any, cb: Function) => cb(null, { success: true })),
    UpdateEdge: vi.fn((_req: any, cb: Function) => cb(null, { src: 1, dst: 2 })),
    DeleteEdge: vi.fn((_req: any, cb: Function) => cb(null, { success: true })),
    Query: vi.fn((_req: any, cb: Function) => cb(null, { results: [], count: 0 })),
    Neighbors: vi.fn((_req: any, cb: Function) => cb(null, { nodeId: 1, edges: [], nodes: [] })),
    BatchNeighbors: vi.fn((_req: any, cb: Function) => cb(null, { results: {}, totalCount: 0 })),
    Health: vi.fn((_req: any, cb: Function) => cb(null, { status: 'ok' })),
    close: vi.fn(),
  }
  const mockGraphServiceCtor = vi.fn(function () {
    return mockClient
  })

  return {
    Server: mockServerCtor,
    ServerCredentials: {
      createInsecure: vi.fn(() => 'insecure-cred'),
    },
    credentials: {
      createInsecure: vi.fn(() => 'insecure-cred'),
    },
    status: {
      NOT_FOUND: 5,
      INTERNAL: 13,
    },
    loadPackageDefinition: vi.fn(() => {
      const GraphService: any = function () {
        return mockClient
      }
      GraphService.service = 'GraphServiceDefinition'
      return {
        graphvec: {
          GraphService,
        },
      }
    }),
    _mockServer: mockServer,
    _mockClient: mockClient,
  }
})

vi.mock('@grpc/proto-loader', () => ({
  loadSync: vi.fn(() => 'mocked-package-definition'),
}))

// ── 导入待测试模块 ──

import { createGrpcServer } from './grpc-server'
import type { GrpcServerConfig, GrpcServerInstance } from './grpc-server'
import { createGrpcClient, GraphVecClient } from './grpc-client'
import * as grpc from '@grpc/grpc-js'

// ──────────────────────────────────────────
// Mock the GraphEngine
// ──────────────────────────────────────────

const mockEngine = {
  getNode: vi.fn(),
  upsertNode: vi.fn(),
  deleteNode: vi.fn(),
  getEdge: vi.fn(),
  upsertEdge: vi.fn(),
  deleteEdge: vi.fn(),
  query: vi.fn(),
  neighbors: vi.fn(),
  batchNeighbors: vi.fn(),
  stats: vi.fn(() => ({ nodeCount: 0, edgeCount: 0 })),
  open: vi.fn(),
  close: vi.fn(),
} as any

// ──────────────────────────────────────────
// 1. GrpcServerConfig 验证
// ──────────────────────────────────────────

describe('GrpcServerConfig', () => {
  it('应支持标准的端口和主机配置', () => {
    const config: GrpcServerConfig = {
      port: 50051,
      host: '127.0.0.1',
    }
    expect(config.port).toBe(50051)
    expect(config.host).toBe('127.0.0.1')
  })

  it('port 应为 number 类型', () => {
    const config: GrpcServerConfig = { port: 0, host: '0.0.0.0' }
    expect(typeof config.port).toBe('number')
  })

  it('host 应为 string 类型', () => {
    const config: GrpcServerConfig = { port: 50051, host: '0.0.0.0' }
    expect(typeof config.host).toBe('string')
  })

  it('应支持 port = 0（动态端口分配）', () => {
    const config: GrpcServerConfig = { port: 0, host: '127.0.0.1' }
    expect(config.port).toBe(0)
  })

  it('应支持 IPv6 地址', () => {
    const config: GrpcServerConfig = { port: 50051, host: '::1' }
    expect(config.host).toBe('::1')
  })

  it('应支持通配符地址 0.0.0.0', () => {
    const config: GrpcServerConfig = { port: 50051, host: '0.0.0.0' }
    expect(config.host).toBe('0.0.0.0')
  })
})

// ──────────────────────────────────────────
// 2. createGrpcServer 签名
// ──────────────────────────────────────────

describe('createGrpcServer signature', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('应作为具名函数被导出', () => {
    expect(createGrpcServer).toBeDefined()
    expect(typeof createGrpcServer).toBe('function')
  })

  it('应接受 engine 和 config 两个参数', () => {
    expect(createGrpcServer.length).toBe(2)
  })

  it('应返回 GrpcServerInstance 对象（含 start / stop / getPort）', () => {
    const server = createGrpcServer(mockEngine, { port: 50051, host: '127.0.0.1' })

    expect(server).toHaveProperty('start')
    expect(server).toHaveProperty('stop')
    expect(server).toHaveProperty('getPort')
    expect(typeof server.start).toBe('function')
    expect(typeof server.stop).toBe('function')
    expect(typeof server.getPort).toBe('function')
  })

  it('start() 返回 Promise', () => {
    const server = createGrpcServer(mockEngine, { port: 50051, host: '127.0.0.1' })
    // 不 await，只检查返回类型是 Promise
    const result = server.start()
    expect(result).toBeInstanceOf(Promise)
  })

  it('stop() 返回 Promise', () => {
    const server = createGrpcServer(mockEngine, { port: 50051, host: '127.0.0.1' })
    const result = server.stop()
    expect(result).toBeInstanceOf(Promise)
  })

  it('getPort() 应返回 number', () => {
    const server = createGrpcServer(mockEngine, { port: 50051, host: '127.0.0.1' })
    expect(typeof server.getPort()).toBe('number')
    expect(server.getPort()).toBe(50051)
  })

  it('应调用 grpc.Server 构造函数', () => {
    const grpcServer = (grpc as any).Server
    createGrpcServer(mockEngine, { port: 50051, host: '127.0.0.1' })
    expect(grpcServer).toHaveBeenCalledTimes(1)
  })
})

// ──────────────────────────────────────────
// 3. createGrpcClient 签名
// ──────────────────────────────────────────

describe('createGrpcClient signature', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('应作为具名函数被导出', () => {
    expect(createGrpcClient).toBeDefined()
    expect(typeof createGrpcClient).toBe('function')
  })

  it('应接受一个 address 参数', () => {
    expect(createGrpcClient.length).toBe(1)
  })

  it('应返回 GraphVecClient 对象（含 Node/Edge/Query/Batch 方法）', () => {
    const client = createGrpcClient('127.0.0.1:50051')

    expect(client).toBeDefined()
    expect(typeof client).toBe('object')

    // Node methods
    expect(typeof client.getNode).toBe('function')
    expect(typeof client.addNode).toBe('function')
    expect(typeof client.updateNode).toBe('function')
    expect(typeof client.deleteNode).toBe('function')

    // Edge methods
    expect(typeof client.getEdge).toBe('function')
    expect(typeof client.addEdge).toBe('function')
    expect(typeof client.updateEdge).toBe('function')
    expect(typeof client.deleteEdge).toBe('function')

    // Query methods
    expect(typeof client.query).toBe('function')
    expect(typeof client.neighbors).toBe('function')

    // Batch methods
    expect(typeof client.batchNeighbors).toBe('function')

    // Other
    expect(typeof client.health).toBe('function')
    expect(typeof client.close).toBe('function')
  })

  it('应支持不同格式的地址', () => {
    const addresses = [
      '127.0.0.1:50051',
      'localhost:50051',
      '0.0.0.0:50051',
      '[::1]:50051',
      '192.168.1.1:50051',
    ]
    for (const addr of addresses) {
      const client = createGrpcClient(addr)
      expect(client).toBeDefined()
      expect(typeof client.getNode).toBe('function')
      expect(typeof client.close).toBe('function')
    }
  })

  it('GraphVecClient 的 deleteNode 应返回 { success: boolean } 类型的 Promise', async () => {
    const client = createGrpcClient('127.0.0.1:50051')
    const result = client.deleteNode(1)
    expect(result).toBeInstanceOf(Promise)
    const res = await result
    expect(res).toHaveProperty('success')
    expect(res.success).toBe(true)
  })
})

// ──────────────────────────────────────────
// 4. GraphVecClient 接口 — 方法签名验证
// ──────────────────────────────────────────

describe('GraphVecClient 方法签名', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('getNode 应接受一个 number 参数', () => {
    const client = createGrpcClient('127.0.0.1:50051')
    // 验证通用签名：函数接受参数
    expect(client.getNode.length).toBe(1)
  })

  it('addNode 应接受类型、名称和可选的 props', () => {
    const client = createGrpcClient('127.0.0.1:50051')
    const paramCount = client.addNode.length
    // 在实现中，addNode 接受 3 个参数 (typeId, name, props?)
    expect(paramCount).toBeGreaterThanOrEqual(2)
    expect(paramCount).toBeLessThanOrEqual(4)
  })

  it('deleteNode 应接受 id 和可选的 cascade', () => {
    const client = createGrpcClient('127.0.0.1:50051')
    expect(client.deleteNode.length).toBeGreaterThanOrEqual(1)
    expect(client.deleteNode.length).toBeLessThanOrEqual(2)
  })

  it('query 应接受查询串和可选的 limit/skip', () => {
    const client = createGrpcClient('127.0.0.1:50051')
    expect(client.query.length).toBeGreaterThanOrEqual(1)
    expect(client.query.length).toBeLessThanOrEqual(3)
  })

  it('neighbors 应接受 nodeId 和可选的 maxDepth/edgeTypeFilter', () => {
    const client = createGrpcClient('127.0.0.1:50051')
    expect(client.neighbors.length).toBeGreaterThanOrEqual(1)
    expect(client.neighbors.length).toBeLessThanOrEqual(3)
  })

  it('batchNeighbors 应接受 ids 数组和可选的 maxDepth/edgeTypeFilter', () => {
    const client = createGrpcClient('127.0.0.1:50051')
    expect(client.batchNeighbors.length).toBeGreaterThanOrEqual(1)
    expect(client.batchNeighbors.length).toBeLessThanOrEqual(3)
  })

  it('addEdge 应接受 src, dst, typeId 和可选的 props/weight', () => {
    const client = createGrpcClient('127.0.0.1:50051')
    expect(client.addEdge.length).toBeGreaterThanOrEqual(3)
    expect(client.addEdge.length).toBeLessThanOrEqual(6)
  })

  it('close 返回 void', () => {
    const client = createGrpcClient('127.0.0.1:50051')
    const result = client.close()
    expect(result).toBeUndefined()
  })

  it('health 返回 Promise', () => {
    const client = createGrpcClient('127.0.0.1:50051')
    const result = client.health()
    expect(result).toBeInstanceOf(Promise)
  })
})

// ──────────────────────────────────────────
// 5. 配置边界
// ──────────────────────────────────────────

describe('配置边界测试', () => {
  it('port 为 0 时应成功创建 server（动态端口）', () => {
    // port=0 表示由 OS 分配端口
    const server = createGrpcServer(mockEngine, { port: 0, host: '127.0.0.1' })
    expect(server.getPort()).toBe(0)
    // 当 server.start() 被调用后，port 会被改写为实际分配的值
  })

  it('端口号超出范围不应阻止 server 对象创建', () => {
    // 超范围端口会在 bindAsync 阶段报错，但不影响 server 对象创建
    const server = createGrpcServer(mockEngine, { port: 99999, host: '127.0.0.1' })
    expect(server).toBeDefined()
    expect(server.getPort()).toBe(99999)
  })

  it('应支持含端口和 host 的地址字符串用于 client', () => {
    const client = createGrpcClient('127.0.0.1:50051')
    expect(client).toBeDefined()
  })

  it('应支持仅端口格式的地址字符串用于 client', () => {
    // 无主机名或裸端口形式
    const client = createGrpcClient('50051')
    expect(client).toBeDefined()
  })

  it('空 host 应不会阻止 server 创建', () => {
    const server = createGrpcServer(mockEngine, { port: 50051, host: '' })
    expect(server).toBeDefined()
    expect(typeof server.start).toBe('function')
    expect(typeof server.stop).toBe('function')
  })

  it('多个 server 实例应能共存（不同端口配置）', () => {
    const server1 = createGrpcServer(mockEngine, { port: 50051, host: '127.0.0.1' })
    const server2 = createGrpcServer(mockEngine, { port: 50052, host: '127.0.0.1' })

    expect(server1.getPort()).toBe(50051)
    expect(server2.getPort()).toBe(50052)
    expect(server1).not.toBe(server2)
  })
})

// ──────────────────────────────────────────
// 6. 配置参数传递验证（createGrpcServer 在 mock 下）
// ──────────────────────────────────────────

describe('createGrpcServer 参数传递', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('应传递 host:port 到 bindAsync', async () => {
    const server = createGrpcServer(mockEngine, { port: 50051, host: '127.0.0.1' })
    const mockBindAsync = (grpc as any).Server().bindAsync

    // 模拟 bindAsync 立即回调
    mockBindAsync.mockImplementation(
      (_addr: string, _cred: any, cb: (err: null, port: number) => void) => {
        cb(null, 50051)
      },
    )

    await server.start()

    expect(mockBindAsync).toHaveBeenCalledWith(
      '127.0.0.1:50051',
      expect.anything(),
      expect.any(Function),
    )
  })

  it('应使用 createInsecure 凭据', async () => {
    const server = createGrpcServer(mockEngine, { port: 50051, host: '127.0.0.1' })
    const mockBindAsync = (grpc as any).Server().bindAsync

    mockBindAsync.mockImplementation(
      (_addr: string, _cred: any, cb: (err: null, port: number) => void) => {
        cb(null, 50051)
      },
    )

    await server.start()

    expect(mockBindAsync).toHaveBeenCalledWith(
      expect.any(String),
      'insecure-cred',
      expect.any(Function),
    )
  })

  it('bindAsync 失败时应 reject', async () => {
    const server = createGrpcServer(mockEngine, { port: 50051, host: '127.0.0.1' })
    const mockBindAsync = (grpc as any).Server().bindAsync

    const testErr = new Error('port already in use')
    mockBindAsync.mockImplementation(
      (_addr: string, _cred: any, cb: (err: Error) => void) => {
        cb(testErr, 0)
      },
    )

    await expect(server.start()).rejects.toThrow('port already in use')
  })

  it('应能添加 GraphService 服务定义', () => {
    const server = createGrpcServer(mockEngine, { port: 50051, host: '127.0.0.1' })
    const mockAddService = (grpc as any).Server().addService

    expect(mockAddService).toHaveBeenCalledWith(
      'GraphServiceDefinition',
      expect.any(Object),
    )
  })
})

// ──────────────────────────────────────────
// 7. 接口导出完整性
// ──────────────────────────────────────────

describe('接口导出完整性', () => {
  it('GrpcServerConfig 接口应有 port 和 host 字段', () => {
    // 类型层面验证：编译时检查
    const config: GrpcServerConfig = { port: 50051, host: '0.0.0.0' }
    expect('port' in config).toBe(true)
    expect('host' in config).toBe(true)
  })

  it('GrpcServerInstance 接口应有 start/stop/getPort', () => {
    const server = createGrpcServer(mockEngine, { port: 50051, host: '0.0.0.0' })
    const instance: GrpcServerInstance = server
    expect(instance).toHaveProperty('start')
    expect(instance).toHaveProperty('stop')
    expect(instance).toHaveProperty('getPort')
  })

  it('GraphVecClient 接口应包含所有 12 个方法', () => {
    const client = createGrpcClient('127.0.0.1:50051')
    const methods: (keyof GraphVecClient)[] = [
      'getNode', 'addNode', 'updateNode', 'deleteNode',
      'getEdge', 'addEdge', 'updateEdge', 'deleteEdge',
      'query', 'neighbors', 'batchNeighbors',
      'health', 'close',
    ]
    for (const method of methods) {
      expect(client).toHaveProperty(method)
      expect(typeof client[method]).toBe('function')
    }
  })
})
