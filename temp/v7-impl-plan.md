# V7 实现计划

## Step 1: GAP-20 — VariableLengthPathNode (query-planner.ts)
- Add `VARIABLE_LENGTH_PATH` to PlanNodeType enum
- Add `VariableLengthPathNode` interface
- Add BFS variable-length expansion in optimizer-executor.ts
- Write var-length-path.spec.ts

## Step 2: GAP-21 — Fluent traverse methods (fluent.ts)
- Add direction field to internal query state
- Add out()/in()/both()/has()/outE()/inE()/bothE() methods
- Add direction to QuerySpec
- Write fluent-traverse.spec.ts

## Step 3: GAP-22 — Batch delete (storage-provider.ts + graph-engine.ts + fluent.ts)
- Add batchDeleteNodes/batchDeleteEdges to StorageProvider interface
- Implement in GraphEngine (throw if not supported by storage)
- Add deleteNodes/deleteEdges to Fluent API
- Write batch-delete.spec.ts
