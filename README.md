# AgentiX GraphVec

> **Globally distributed, multi-active graph database for the AI Agent era**

AgentiX GraphVec is a next-generation graph database built from the ground up for AI Agent workloads. It combines **Cypher-compatible graph querying**, **built-in graph algorithms (PageRank, Louvain, BFS/DFS, Shortest Path)**, **GNN (Graph Neural Network) vector embeddings**, **Raft-based distributed consensus**, and **multi-leader active-active replication** — all in a single, self-contained system.

With 5,000+ tests covering correctness, fault tolerance, and performance, GraphVec is engineered for production-grade reliability.

---

## Features

| Area | Capabilities |
|------|-------------|
| **🔗 Graph Model** | Labeled Property Graph (LPG), typed nodes & edges, temporal validity, TTL, MVCC |
| **🧠 Graph Algorithms** | PageRank, Louvain community detection, BFS/DFS, Shortest Path, Triangle Count, Clustering Coefficient, Betweenness Centrality |
| **📐 Vector & GNN** | Dense & sparse vector embeddings, inner-product/cosine search, GNN inference, node2vec-style embedding generation |
| **🗄️ Cypher Compatibility** | SQL-style graph queries via `GraphEngine` API — pattern matching, filtering, aggregation |
| **🌍 Distributed** | Multi-leader active-active replication across datacenters, sharding with scatter-gather routing, edge-affinity optimization |
| **⚖️ Raft Consensus** | Production-grade Raft implementation with log replication, leader election, snapshot install, quorum-based writes |
| **🔒 Security** | RBAC (Role-Based Access Control), TLS encryption, audit logging, query-level authentication |
| **🔄 Event Bus** | High-throughput cross-node event streaming with worker pool parallelism and outbox pattern |
| **🔧 Operations** | Built-in metrics, health checks, backup/restore, WAL-based durability, query slow-log |
| **📦 Materialized Views** | Pre-computed graph projections for sub-millisecond query responses |
| **🚀 Resharding** | Zero-downtime rebalancing with auto-splitter — no cluster restart required |

---

## Quick Start

### Installation

```bash
npm install agentix-graphvec
```

> **Prerequisites:** Node.js >= 16.0.0 (tested on 18.x, 20.x, 22.x)

### Run Your First Graph Query

```typescript
import { GraphEngine } from 'agentix-graphvec'

async function main() {
  // 1. Create engine and open
  const engine = new GraphEngine({ path: '/tmp/my-graph' })
  await engine.open()

  // 2. Upsert nodes (returns nodeId)
  const aliceId = await engine.upsertNode(1, 'alice', { props: { name: 'Alice', age: 30 } })
  const bobId   = await engine.upsertNode(1, 'bob',   { props: { name: 'Bob',   age: 25 } })

  // 3. Create edge
  await engine.upsertEdge(aliceId, bobId, 1, { props: { weight: 1.0 } })

  // 4. Query neighbors
  const neighborIds = engine.neighbors(aliceId)
  for (const nid of neighborIds ?? []) {
    const node = engine.getNode(nid)
    console.log('Neighbor:', node)
  }

  // 5. Scan all nodes
  const allNodes = engine.scanAllNodes()
  console.log('Total nodes:', allNodes.length)

  // 6. Clean up
  engine.close()
}
main()
```

### Distributed Cluster (Quick Demo)

```bash
# Start a 3-node cluster locally
npx agentix-graphvec dev --nodes=3

# In another terminal, query any node
curl http://localhost:4001/graph/neighbors?id=1
```

---

## API Overview

### Core Graph Operations

| API | Description |
|-----|-------------|
| `upsertNode(id, options)` | Insert or update a node with properties, vectors, TTL |
| `upsertEdge(from, to, options)` | Insert or update a typed, weighted edge |
| `getNeighbors(nodeId, depth)` | BFS/DFS traversal with depth control |
| `getNode(id)` | Retrieve node by ID with full metadata |
| `deleteNode(id)` | Remove node and all incident edges |
| `deleteEdge(from, to)` | Remove a specific edge |
| `query(customQuery)` | Run a CYPHER-like predicate query |

### Graph Algorithms

```typescript
engine.pagerank(options)          // PageRank centrality
engine.louvain(options)           // Community detection
engine.bfs(startNode, callback)   // Breadth-First Search
engine.dfs(startNode, callback)   // Depth-First Search
engine.shortestPath(from, to)     // Dijkstra / BFS shortest path
engine.triangleCount()            // Triangle count per node
engine.clusteringCoefficient()    // Local clustering coefficient
engine.betweennessCentrality()    // Betweenness centrality
```

### Consensus & Distribution

| API | Description |
|-----|-------------|
| `createConsensus(provider, config)` | Create Raft or standalone consensus |
| `StandaloneConsensus` | Single-node (no external deps) |
| `RaftLogicConsensus` | Multi-node Raft with leader election |
| `ShardManager` | Shard-aware graph operations |
| `HlcClock` | Hybrid Logical Clock for ordering |

### Security

```typescript
import { Authenticator, RBAC, TLSConfig, AuditLogger } from 'agentix-graphvec'

const auth = new Authenticator({ provider: 'jwt' })
const rbac = new RBAC({ roles: ['admin', 'reader', 'writer'] })
```

---

## Architecture

```
┌────────────────────────────────────────────────────────┐
│                     Application / SDK                   │
├────────────────────────────────────────────────────────┤
│                      GraphEngine                        │
├──────────┬──────────┬──────────┬──────────┬─────────────┤
│  Graph   │  Vector  │ Material │  Event   │  Query      │
│  Store   │  Engine  │  View    │  Bus/WP  │  Engine     │
├──────────┴──────────┴──────────┴──────────┴─────────────┤
│                    Shard Router                          │
├──────────────────────┬──────────────────────────────────┤
│     Scatter-Gather   │     Edge Affinity Router         │
├──────────────────────┴──────────────────────────────────┤
│                    Shard Manager                        │
├──────────────────────┬──────────────────────────────────┤
│   Range Instance 0   │   Range Instance 1   │ ... │ N   │
├──────────────────────┼──────────────────────────────────┤
│  Raft │ Raft │ Standalone                                │
│  Node0│ Node1│(single-node fallback)                     │
├──────────────────────┴──────────────────────────────────┤
│          Multi-Leader Replication (DC Sync)              │
├──────────────────────┬──────────────────────────────────┤
│     WAL/Segment      │     Outbox / PeerDB              │
├──────────────────────┴──────────────────────────────────┤
│      Security (Auth, RBAC, TLS, Audit Log)               │
├──────────────────────┬──────────────────────────────────┤
│  Ops (Metrics, Health, Backup, SlowLog)                  │
└──────────────────────┴──────────────────────────────────┘
```

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| **Language** | TypeScript (ES2022), Node.js 18+/20+/22+ |
| **Testing** | Vitest 4.1.7, 5,000+ tests, coverage via `@vitest/coverage-v8` |
| **Consensus** | Custom Raft (log replication, leader election, snapshot install) |
| **Serialization** | Protocol Buffers-style binary encoding |
| **WAL** | Segment-based write-ahead log with streaming |
| **Container** | Docker (multi-stage build, see `Dockerfile`) |

---

## Comparison: GraphVec vs Neo4j

| Dimension | AgentiX GraphVec | Neo4j |
|-----------|-----------------|-------|
| **Deployment Model** | Multi-leader active-active (all nodes write) | Single-leader (one writer, replicas read-only) |
| **Multi-DC Replication** | Native, conflict-free CRDT-based | Requires additional tooling (Neo4j Fabric) |
| **Raft Consensus** | Built-in, no external coordinator | Built-in (since 4.0), but single-leader |
| **GNN / Vector** | Dense + sparse vectors, GNN inference, node2vec | Requires GDS plugin + external vector DB |
| **Graph Algorithms** | Built-in: PageRank, Louvain, Shortest Path, etc. | Via GDS plugin (separate install) |
| **Cypher Support** | Compatible via `GraphEngine` query API | Native Cypher |
| **License** | Apache 2.0 (open source, free) | Community Edition (GPL) / Enterprise (commercial) |
| **Footprint** | Lightweight, single npm package | JVM-based, memory-intensive |
| **Embedding** | Import as library — embed in Node.js apps | Runs as standalone server |
| **Tests** | 5,000+ unit/integration/fault/benchmark tests | Proprietary test suite |

**Positioning:** GraphVec is designed for **AI Agent ecosystems** where graph topology, vector embeddings, and distributed consensus must coexist in a lightweight embeddable library. If you need a standalone graph server with full Cypher coverage and an ecosystem of plugins, Neo4j is the right choice. If you need an **embeddable, multi-active, vector-aware graph engine** for Agent-native architectures, GraphVec is purpose-built for that.

---

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for:

- Development environment setup
- How to run tests
- Coding standards
- PR workflow

Key points:
- Write tests for any new feature or bug fix
- Run `npm run lint` before committing
- All tests must pass: `npm run test:unit` (fast) or `npm run test:all` (full)

---

## License

AgentiX GraphVec is licensed under the **Apache License, Version 2.0**. See [LICENSE](LICENSE) for details.

```
Copyright 2025 AgentiX

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
