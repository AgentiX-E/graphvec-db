# Node Property Key-Order Preservation — Execution Plan

Created: 2026-08-19 13:55

## Goal
Preserve node (and edge) property insertion order across OverGraph Rust persistence,
so that `MATCH (a) RETURN a` yields stable property order matching CREATE declaration
order. Eliminates TCK flakiness caused by non-deterministic key order.

## Root Cause (confirmed)
OverGraph (Rust) stores props as a HashMap; flush/close→reopen loses key order.
msgpackr encode/decode preserves order. Existing `_serializeProps`/`_deserializeProps`
already encode props as a msgpack blob under `__c` key, but are only active when
`_compress=true` (compressionStrategy='msgpack'). Default is 'none' → bare object →
Rust HashMap → order loss.

## Steps
- [x] Step 1: Read full overgraph-storage.ts (serialize/deserialize, upsertNode, getNode, edge paths, indexes)
- [x] Step 2: Read graph-engine.ts storageConfig construction (found hardcoded compressionStrategy bind at :404)
- [x] Step 3: Design order-preserving scheme = default msgpack blob (validated: `__c` single-key blob survives reopen, order stable across 5 reopens)
- [x] Step 4: Implement with minimal, precise change (3 code sites + docs)
- [x] Step 5: Unit tests proving order preservation across reopen (scientific, real-failure, ≥95% dimension coverage)
- [x] Step 6: Full regression (quick + targeted TCK) zero-regression
- [x] Step 7: Commit as Lambertyan (English comments/docs/commit) → 6372776e (pushed)

## Design (final)
- msgpack blob (single `__c` key) is the ONLY order-preserving format (Rust HashMap cannot reorder a single key).
- Make msgpack the DEFAULT strategy; `compressionStrategy:'none'` remains an explicit opt-out (bare JSON, may lose order).
- Sites:
  1. `overgraph-storage.ts` `open()`: default `_compressionStrategy = 'msgpack'`
  2. `overgraph-storage.ts` serialize conditions (×4): drop `_compress &&` gate → `strategy==='msgpack'`
  3. `graph-engine.ts:404`: `compressionStrategy: 'msgpack'` (not bound to storageCompression)
- Docs: storage-provider.ts, types.ts comments updated (English).

