// ============================================================
// gRPC Server — High-performance RPC interface for GraphVec
// ============================================================

import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import * as path from 'path'
import * as crypto from 'crypto'
import { GraphEngine } from '../core/graph-engine'
import { NodeRecord, EdgeRecord, NodeProperties } from '../types'

// ──────────────────────────────────────────
// Types for the loaded proto package
// ──────────────────────────────────────────

export interface GrpcServerConfig {
  port: number
  host: string
}

export interface GrpcServerInstance {
  start(): Promise<void>
  stop(): Promise<void>
  getPort(): number
}

// ──────────────────────────────────────────
// Helpers: Convert between gRPC string-map and internal types
// ──────────────────────────────────────────

function propsFromStringMap(props: Record<string, string> | undefined): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {}
  if (!props) return result
  for (const [k, v] of Object.entries(props)) {
    if (v === 'true') result[k] = true
    else if (v === 'false') result[k] = false
    else if (v === 'null' || v === '') result[k] = null
    else if (!isNaN(Number(v)) && v.trim() !== '') result[k] = Number(v)
    else result[k] = v
  }
  return result
}

function propsToStringMap(props: Record<string, string | number | boolean | null | string[] | number[]> | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!props) return result
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue
    if (typeof v === 'boolean') result[k] = String(v)
    else if (Array.isArray(v)) result[k] = JSON.stringify(v)
    else result[k] = String(v)
  }
  return result
}

function nodeToProto(node: NodeRecord): any {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    props: propsToStringMap(node.props),
    createdAt: node.createdAt ?? 0,
    degree: node.degree ?? 0,
  }
}

function edgeToProto(edge: EdgeRecord): any {
  return {
    src: edge.src,
    dst: edge.dst,
    type: edge.type,
    props: propsToStringMap(edge.props),
    timestamp: edge.timestamp ?? 0,
  }
}

// ──────────────────────────────────────────
// Create gRPC Server
// ──────────────────────────────────────────

const PROTO_PATH = path.resolve(__dirname, 'graph.proto')

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
})

const graphvecProto = grpc.loadPackageDefinition(packageDefinition) as any

/**
 * 从 gRPC metadata 中提取 X-Request-Id，如果不存在则自动生成
 */
function getRequestId(call: any): string {
  const metadata = call.metadata
  if (metadata && metadata.get) {
    const values = metadata.get('x-request-id')
    if (values && values.length > 0) {
      return String(values[0])
    }
  }
  return crypto.randomUUID()
}

export function createGrpcServer(
  engine: GraphEngine,
  config: GrpcServerConfig,
): GrpcServerInstance {
  const server = new grpc.Server()
  let startTime = Date.now()

  // ── RPC Implementations ──

  const implementations = {
    // ── Node operations ──

    GetNode: (call: any, callback: any) => {
      const requestId = getRequestId(call)
      try {
        const id = call.request.id
        const node = engine.getNode(id)
        if (!node) {
          callback({ code: grpc.status.NOT_FOUND, message: `Node ${id} not found` })
          return
        }
        callback(null, nodeToProto(node))
      } catch (err: any) {
        callback({ code: grpc.status.INTERNAL, message: err.message })
      }
    },

    AddNode: async (call: any, callback: any) => {
      const requestId = getRequestId(call)
      try {
        const { typeId, name, props } = call.request
        const id = await engine.upsertNode(typeId, name, {
          props: propsFromStringMap(props) as NodeProperties,
        })
        const node = engine.getNode(id)
        callback(null, nodeToProto(node!))
      } catch (err: any) {
        callback({ code: grpc.status.INTERNAL, message: err.message })
      }
    },

    DeleteNode: async (call: any, callback: any) => {
      const requestId = getRequestId(call)
      try {
        const { id } = call.request
        const cascade = !!call.request.cascade
        const success = await engine.deleteNode(id, false, cascade)
        callback(null, { success })
      } catch (err: any) {
        callback({ code: grpc.status.INTERNAL, message: err.message })
      }
    },

    UpdateNode: async (call: any, callback: any) => {
      const requestId = getRequestId(call)
      try {
        const { id, props } = call.request
        const existing = engine.getNode(id)
        if (!existing) {
          callback({ code: grpc.status.NOT_FOUND, message: `Node ${id} not found` })
          return
        }
        // Merge partial props into existing node and upsert
        const mergedProps: Record<string, unknown> = {
          ...(existing.props ?? {}),
          ...propsFromStringMap(props),
        }
        await engine.upsertNode(existing.type, existing.name, {
          props: mergedProps as NodeProperties,
        })
        const updated = engine.getNode(id)!
        callback(null, nodeToProto(updated))
      } catch (err: any) {
        callback({ code: grpc.status.INTERNAL, message: err.message })
      }
    },

    // ── Edge operations ──

    GetEdge: (call: any, callback: any) => {
      const requestId = getRequestId(call)
      try {
        const { src, dst, type } = call.request
        const edge = engine.getEdge(src, dst, type)
        if (!edge) {
          callback({ code: grpc.status.NOT_FOUND, message: `Edge ${src}->${dst}:${type} not found` })
          return
        }
        callback(null, edgeToProto(edge))
      } catch (err: any) {
        callback({ code: grpc.status.INTERNAL, message: err.message })
      }
    },

    AddEdge: async (call: any, callback: any) => {
      const requestId = getRequestId(call)
      try {
        const { src, dst, typeId, props, weight } = call.request
        await engine.upsertEdge(src, dst, typeId, {
          props: propsFromStringMap(props) as NodeProperties,
          weight: weight || undefined,
        })
        callback(null, { success: true })
      } catch (err: any) {
        callback({ code: grpc.status.INTERNAL, message: err.message })
      }
    },

    DeleteEdge: async (call: any, callback: any) => {
      const requestId = getRequestId(call)
      try {
        const { src, dst, typeId } = call.request
        await engine.deleteEdge(src, dst, typeId)
        // deleteEdge may return undefined when storage delete is successful.
        // We check edge existence after the delete to determine success.
        const stillExists = engine.getEdge(src, dst, typeId)
        callback(null, { success: !stillExists })
      } catch (err: any) {
        callback({ code: grpc.status.INTERNAL, message: err.message })
      }
    },

    UpdateEdge: async (call: any, callback: any) => {
      const requestId = getRequestId(call)
      try {
        const { src, dst, typeId, props } = call.request
        const existing = engine.getEdge(src, dst, typeId)
        if (!existing) {
          callback({ code: grpc.status.NOT_FOUND, message: `Edge ${src}->${dst}:${typeId} not found` })
          return
        }
        // Merge partial props into existing edge and upsert
        const mergedProps: Record<string, unknown> = {
          ...(existing.props ?? {}),
          ...propsFromStringMap(props),
        }
        await engine.upsertEdge(src, dst, typeId, {
          props: mergedProps as NodeProperties,
        })
        // 直接 build 返回对象，不依赖 getEdge 二次读取（避免 OverGraph Rust 层 edge 缓存 bug）
        callback(null, edgeToProto({
          src, dst, type: typeId,
          props: mergedProps as NodeProperties,
          timestamp: existing.timestamp,
        }))
      } catch (err: any) {
        callback({ code: grpc.status.INTERNAL, message: err.message })
      }
    },

    // ── Query operations ──

    Query: (call: any, callback: any) => {
      const requestId = getRequestId(call)
      try {
        const { query, limit, skip } = call.request
        const results = engine.query(query)
        let nodes = results

        if (skip > 0) {
          nodes = nodes.slice(skip)
        }
        if (limit > 0) {
          nodes = nodes.slice(0, limit)
        }

        callback(null, {
          results: nodes.map(nodeToProto),
          count: nodes.length,
        })
      } catch (err: any) {
        callback({ code: grpc.status.INTERNAL, message: err.message })
      }
    },

    Neighbors: (call: any, callback: any) => {
      const requestId = getRequestId(call)
      try {
        const { nodeId, maxDepth, edgeTypeFilter } = call.request
        const result = engine.neighbors(nodeId, {
          maxDepth: maxDepth || 1,
          edgeTypeFilter: (edgeTypeFilter?.length ?? 0) > 0 ? edgeTypeFilter : undefined,
        })

        callback(null, {
          nodeId,
          edges: result.edges.map(edgeToProto),
          nodes: result.nodes.map(nodeToProto),
          edgeCount: result.edges.length,
          nodeCount: result.nodes.length,
        })
      } catch (err: any) {
        callback({ code: grpc.status.INTERNAL, message: err.message })
      }
    },

    // ── Batch operations ──

    BatchNeighbors: (call: any, callback: any) => {
      const requestId = getRequestId(call)
      try {
        const { ids, maxDepth, edgeTypeFilter } = call.request
        const result = engine.batchNeighbors(ids, {
          maxDepth: maxDepth || 1,
          edgeTypeFilter: (edgeTypeFilter?.length ?? 0) > 0 ? edgeTypeFilter : undefined,
        })

        const results: Record<string, any> = {}
        for (const [nodeId, val] of result) {
          results[String(nodeId)] = {
            nodeId,
            edges: val.edges.map(edgeToProto),
            nodes: val.nodes.map(nodeToProto),
            edgeCount: val.edges.length,
            nodeCount: val.nodes.length,
          }
        }

        callback(null, { results, totalCount: result.size })
      } catch (err: any) {
        callback({ code: grpc.status.INTERNAL, message: err.message })
      }
    },

    // ── Health check ──

    Health: (_call: any, callback: any) => {
      const requestId = getRequestId(_call)
      try {
        const stats = engine.stats()
        callback(null, {
          status: 'ok',
          uptime_ms: Date.now() - startTime,
          node_count: stats.nodeCount,
          edge_count: stats.edgeCount,
        })
      } catch (err: any) {
        callback({ code: grpc.status.INTERNAL, message: err.message })
      }
    },
  }

  // Handle both possible proto package structures
  const serviceDef = graphvecProto.graphvec?.GraphService?.service
    || graphvecProto.GraphService?.service
  if (!serviceDef) {
    throw new Error('Could not find GraphService definition in proto. Available keys: ' + Object.keys(graphvecProto).join(', ') + ' / graphvec keys: ' + (graphvecProto.graphvec ? Object.keys(graphvecProto.graphvec).join(', ') : 'none'))
  }

  server.addService(serviceDef, implementations)

  return {
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.bindAsync(
          `${config.host}:${config.port}`,
          grpc.ServerCredentials.createInsecure(),
          (err: Error | null, boundPort: number) => {
            if (err) {
              reject(err)
              return
            }
            server.start()
            config.port = boundPort
            startTime = Date.now()
            resolve()
          },
        )
      })
    },

    stop(): Promise<void> {
      return new Promise((resolve) => {
        server.tryShutdown(() => resolve())
      })
    },

    getPort(): number {
      return config.port
    },
  }
}
