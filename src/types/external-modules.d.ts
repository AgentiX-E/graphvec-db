// Type declarations for third-party packages that ship without type
// definitions (runtime-only JS / WASM modules).

declare module 'consistent-hashing' {
  export interface ConsistentHashOptions {
    replicas?: number
  }

  export default class ConsistentHash {
    constructor(nodes: string[], options?: ConsistentHashOptions)
    getNode(key: string): string
  }
}

declare module 'raft-logic' {
  // raft-logic is a WASM consensus module loaded dynamically (as a fallback
  // path). Its surface is consumed through `any` in RaftLogicConsensus, which
  // degrades gracefully when the module is unavailable.
  const raftLogic: any
  export default raftLogic
}

declare module 'graph-crdt' {
  // graph-crdt ships without type definitions. DeltaSync exercises the
  // merge/delta CRDT surface; the merged graph exposes a `nodes` map of
  // node name -> field/value records.
  export interface CrdtGraph {
    nodes?: Record<string, Record<string, unknown>>
  }

  export default class Graph {
    merge(change: unknown): CrdtGraph
    delta(): unknown
  }
}
