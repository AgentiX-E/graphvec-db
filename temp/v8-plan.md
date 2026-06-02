# V8 GAP Implementation Plan

创建时间: 2026-06-02 12:50

## GAPs to Implement

### 1. GAP-28: FullText Index Persistence (P2)
- Add periodic auto-snapshot (config.snapshotIntervalSec, default 300s)
- forceSnapshot() truncates WAL after snapshot (already implemented, verify)
- Startup maxOldWals cleanup enhancement
- Test: `src/search/fulltext-persistence.spec.ts` (new tests)

### 2. GAP-29: Schema Validation (P2)
- Create `src/schema/schema-validator.ts` (enhance with SchemaValidator class)
- SchemaDefinition interface: label/typeId, propertyTypes, required, unique, default
- SchemaValidator class: validateNode(node, schema)/validateEdge(edge, schema)
- Integration with graph-engine upsertNode/upsertEdge paths (already partially done)
- writeSchema/schema/disableSchema management
- Default value filling
- Test: `src/schema/schema-validator.spec.ts`

### 5. GAP-30: EXPLAIN Query Analyzer (P3)
- `src/query/explain.ts`:
  - ExplainFormatter: text format / JSON format / ANALYZE
  - QueryPlan → execution plan description
  - Support EXPLAIN MATCH ... syntax
  - AST ExplainNode
- Test: `src/query/explain.spec.ts`

### 6. GAP-31: Prometheus Metrics Integration (P3)
- `src/ops/prometheus-exporter.ts`:
  - Bridge MetricsCollector → prom-client
  - defaultMetrics collection
  - /metrics HTTP endpoint
  - query/node/edge operation counters + latency histograms
- Test: `src/ops/prometheus-exporter.spec.ts`

## Current Progress

### GAP-28: ✅
- Added periodic auto-snapshot timer
- Enhanced maxOldWals cleanup
- Added config.snapshotIntervalSec support
- Written tests for all persistence enhancements

### GAP-29: ✅
- Created SchemaValidator class
- Added default value filling
- Added unique constraint checking
- Added writeSchema/schema/disableSchema
- Created test file

### GAP-30: ✅
- Created ExplainFormatter with text/JSON/ANALYZE formats
- Added ExplainNode to AST
- Added EXPLAIN parsing support
- Created test file

### GAP-31: ✅
- Created PrometheusExporter class
- Default metrics collection
- /metrics HTTP endpoint
- Operation counters + latency histograms
- Created test file
