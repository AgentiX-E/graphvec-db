// Type declarations for optional/pluggable dependencies

// raft-logic — optional, tikv/raft-rs WASM consensus
declare module 'raft-logic' {
  export class InMemoryStorage {
    constructor()
    open(): Promise<void>
    close(): Promise<void>
  }

  export class InMemoryTransport {
    constructor()
    send(to: string | number, msg: Uint8Array): Promise<void>
    recv(onMessage: (from: string | number, msg: Uint8Array) => void): void
    close(): void
    flush(): Promise<void>
  }

  export class SqliteStorage {
    constructor(opts: { file: string })
    open(): Promise<void>
    close(): Promise<void>
  }

  export interface RaftOptions {
    id: number
    peers: number[]
    electionTick: number
    heartbeatTick: number
    storage: InMemoryStorage | SqliteStorage
    transport: InMemoryTransport
    apply: (entry: { index: number; term: number; data: Uint8Array }) => Promise<void>
    tickIntervalMs?: number
    preVote?: boolean
    checkQuorum?: boolean
  }

  export class RaftNode {
    constructor(opts: RaftOptions)
    start(): Promise<void>
    stop(): Promise<void>
    clientRequest(data: string, opts?: { waitFor?: 'apply' | 'commit'; timeout?: number }): Promise<{ ok: boolean; data?: string }>
    readIndex(opts?: { timeout?: number }): Promise<void>
    waitForLeaderStable(opts?: { timeout?: number }): Promise<void>
    barrier(opts?: { timeout?: number }): Promise<void>
    status(): { role: string; leaderId: string | null; term: number; committed: number; applied: number }
    triggerSnapshot(opts?: { compact?: boolean }): Promise<void>
  }

  export const ready: Promise<void>
}

// @consento/hlc — CockroachDB compatible hybrid logical clock
declare module '@consento/hlc' {
  interface HLCOptions {
    wallTime?: bigint
    logical?: number
  }

  export interface HLCTimestamp {
    wallTime: bigint
    logical: number
    encode(): Uint8Array
    compare(other: HLCTimestamp): number
    toJSON(): { wallTime: number; logical: number }
  }

  export const Timestamp: {
    new (opts?: HLCOptions): HLCTimestamp
    now?(): HLCTimestamp
  }

  export const codec: {
    encode(ts: HLCTimestamp): Uint8Array
    decode(bytes: Uint8Array): HLCTimestamp
  }
}

// graph-crdt — figure CRDT (CvRDT) for cross-DC synchronization
declare module 'graph-crdt' {
  class Graph {
    constructor()
    merge(data: any): any
    delta(state?: any): any
  }
  export default Graph
}

// zeromq — ZMQ PUB/SUB for cross-DC transport
declare module 'zeromq' {
  export class Publisher {
    constructor()
    bind(address: string): Promise<void>
    send(data: (string | Buffer)[]): Promise<void>
    close(): void
  }

  export class Subscriber {
    constructor()
    connect(address: string): Promise<void>
    subscribe(topic: string): void
    close(): void
    [Symbol.asyncIterator](): AsyncIterator<[Buffer, Buffer]>
  }
}

// consistent-hashing — consistent hash ring for routing
declare module 'consistent-hashing' {
  class ConsistentHash {
    constructor(nodes: string[], opts?: { replicas?: number })
    getNode(key: string): string
    getNodes(): string[]
  }
  export default ConsistentHash
}
