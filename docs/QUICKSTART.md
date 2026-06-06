# AgentiX GraphVec Quick Start

## Installation

```bash
npm install agentix-graphvec
```

Prerequisites: Node.js >= 16 (tested on 18.x, 20.x, 22.x)

## Basic Usage

### Create a Graph and Add Nodes

```typescript
import { GraphEngine } from 'agentix-graphvec'

const engine = new GraphEngine({ path: '/tmp/my-graph' })
await engine.open()

// Add nodes: upsertNode(typeId, name, opts?)
const aliceId = await engine.upsertNode(1, 'alice', { props: { name: 'Alice', age: 30 } })
const bobId   = await engine.upsertNode(1, 'bob',   { props: { name: 'Bob',   age: 25 } })
const carolId = await engine.upsertNode(1, 'carol', { props: { name: 'Carol', age: 35 } })
```

### Create Edges

```typescript
// upsertEdge(src, dst, typeId, opts?)
await engine.upsertEdge(aliceId, bobId,   1, { props: { weight: 1.0 } })
await engine.upsertEdge(aliceId, carolId, 1, { props: { weight: 0.8 } })
```

### Query Neighbors

```typescript
// neighbors(nodeId, opts?, ctx?)
const nbs = engine.neighbors(aliceId)
for (const nid of nbs ?? []) {
  const node = engine.getNode(nid)
  console.log(`Neighbor: ${node?.name ?? node?.props?.name}`)
}
```

### Filter by Edge Type

```typescript
// Only get neighbors connected by edge type 1
const colleagues = engine.neighbors(aliceId, { edgeTypeFilter: [1] })
```

### Scan All Nodes

```typescript
const all = engine.scanAllNodes()
console.log(`Total nodes: ${all.length}`)
```

### Update Node Properties

```typescript
// Upsert with same name updates properties
await engine.upsertNode(1, 'alice', { props: { name: 'Alice', age: 31 } })
```

### Delete

```typescript
engine.deleteNode(aliceId)
engine.deleteEdge(bobId, carolId, 1)
```

### Clean Up

```typescript
engine.close()
```

---

## Graph Algorithms

### PageRank

```typescript
const scores = engine.pagerank({ dampingFactor: 0.85, maxIterations: 20 })
console.log(scores) // Map<nodeId, score>
```

### Shortest Path

```typescript
const path = engine.shortestPath(aliceId, carolId)
console.log(path) // [aliceId, bobId, carolId] or null
```

### BFS / DFS

```typescript
const bfsOrder = engine.bfsTraverse(aliceId, { maxDepth: 3 })
const dfsOrder = engine.dfsTraverse(aliceId, { maxDepth: 3 })
```

### Community Detection

```typescript
const communities = engine.louvain({ maxIterations: 100 })
const labels = engine.labelPropagation({ maxIterations: 50 })
```

---

## Running Tests

```bash
# All tests
npx vitest run

# Specific module
npx vitest run src/core/
npx vitest run src/e2e/cypher-e2e.spec.ts

# Benchmark (note: skip ldbc-snb which requires external data)
npx vitest run src/benchmark/throughput.spec.ts
npx vitest run src/benchmark/latency.spec.ts
npx vitest run src/benchmark/scalability.spec.ts

# Stress tests
npx vitest run src/stress/
```

---

## Architecture Overview

```
┌─────────────────────────────────┐
│           GraphEngine           │
│  ┌─────────┬────────┬────────┐  │
│  │ Storage │  Node  │  Edge  │  │
│  │ Backend │ Cache  │ Index  │  │
│  ├─────────┼────────┼────────┤  │
│  │ Algorithms │ Query │ HNSW  │  │
│  ├─────────┼────────┼────────┤  │
│  │ Security │ Replic │ Shard  │  │
│  └─────────┴────────┴────────┘  │
└─────────────────────────────────┘
```

---

## API Reference

See [API docs](./api/) for full API documentation.

Key exports from `agentix-graphvec`:

| Export | Type | Description |
|--------|------|-------------|
| `GraphEngine` | class | Main graph database engine |
| `GraphConfig` | class | Configuration options |
| `createConsensus` | fn | Create consensus provider |
| `ShardRouter` | class | Distributed shard routing |
| `Authenticator` | class | Authentication |
| `RBAC` | class | Role-based access control |
| `Metrics` | class | Performance metrics |
| `Backup` | class | Backup/restore |
