// ============================================================
// GraphVec gRPC Client — simple client wrapper for tests
// ============================================================

import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import * as path from 'path'

const PROTO_PATH = path.resolve(__dirname, 'graph.proto')

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
})

const graphvecProto = grpc.loadPackageDefinition(packageDefinition) as any

export interface GraphVecClient {
  getNode(id: number): Promise<any>
  addNode(typeId: number, name: string, props?: Record<string, string>): Promise<any>
  deleteNode(id: number, cascade?: boolean): Promise<{ success: boolean }>
  getEdge(src: number, dst: number, type: number): Promise<any>
  addEdge(src: number, dst: number, typeId: number, props?: Record<string, string>, weight?: number): Promise<{ success: boolean }>
  deleteEdge(src: number, dst: number, typeId: number): Promise<{ success: boolean }>
  query(query: string, limit?: number, skip?: number): Promise<{ results: any[]; count: number }>
  neighbors(nodeId: number, maxDepth?: number, edgeTypeFilter?: number[]): Promise<any>
  batchNeighbors(ids: number[], maxDepth?: number, edgeTypeFilter?: number[]): Promise<any>
  health(): Promise<any>
  close(): void
}

/**
 * Create a gRPC client for the GraphVec GraphService.
 * Used primarily in tests.
 */
export function createGrpcClient(address: string): GraphVecClient {
  const client = new graphvecProto.graphvec.GraphService(
    address,
    grpc.credentials.createInsecure(),
  )

  function promisify<T>(method: string): (request: any) => Promise<T> {
    return (request: any) =>
      new Promise<T>((resolve, reject) => {
        client[method](request, (err: grpc.ServiceError | null, response: T) => {
          if (err) {
            reject(err)
          } else {
            resolve(response)
          }
        })
      })
  }

  const promisified: Record<string, any> = {
    GetNode: promisify<any>('GetNode'),
    AddNode: promisify<any>('AddNode'),
    DeleteNode: promisify<{ success: boolean }>('DeleteNode'),
    GetEdge: promisify<any>('GetEdge'),
    AddEdge: promisify<{ success: boolean }>('AddEdge'),
    DeleteEdge: promisify<{ success: boolean }>('DeleteEdge'),
    Query: promisify<{ results: any[]; count: number }>('Query'),
    Neighbors: promisify<any>('Neighbors'),
    BatchNeighbors: promisify<any>('BatchNeighbors'),
    Health: promisify<any>('Health'),
  }

  return {
    getNode: (id: number) => promisified.GetNode({ id }),
    addNode: (typeId: number, name: string, props?: Record<string, string>) =>
      promisified.AddNode({ typeId, name, props: props ?? {} }),
    deleteNode: (id: number, cascade?: boolean) =>
      promisified.DeleteNode({ id, cascade: cascade ?? false }),
    getEdge: (src: number, dst: number, type: number) =>
      promisified.GetEdge({ src, dst, type }),
    addEdge: (src: number, dst: number, typeId: number, props?: Record<string, string>, weight?: number) =>
      promisified.AddEdge({ src, dst, typeId, props: props ?? {}, weight: weight ?? 0 }),
    deleteEdge: (src: number, dst: number, typeId: number) =>
      promisified.DeleteEdge({ src, dst, typeId }),
    query: (queryStr: string, limit?: number, skip?: number) =>
      promisified.Query({ query: queryStr, limit: limit ?? 0, skip: skip ?? 0 }),
    neighbors: (nodeId: number, maxDepth?: number, edgeTypeFilter?: number[]) =>
      promisified.Neighbors({ nodeId, maxDepth: maxDepth ?? 1, edgeTypeFilter: edgeTypeFilter ?? [] }),
    batchNeighbors: (ids: number[], maxDepth?: number, edgeTypeFilter?: number[]) =>
      promisified.BatchNeighbors({ ids, maxDepth: maxDepth ?? 1, edgeTypeFilter: edgeTypeFilter ?? [] }),
    health: () => promisified.Health({}),
    close: () => client.close(),
  }
}
