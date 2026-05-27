# Test Gap Analysis: Integration & Fault-Injection Coverage vs Design Patterns

> Generated: 2026-05-27  
> Source: OverGraph (agentiX-graphvec)  
> Config: `vitest.int.config.ts`

---

## 1. Current Test Coverage Summary

### 1.1 Integration Tests (`test/integration/`)

| File | Tests | Coverage Area |
|------|-------|---------------|
| `single-node.test.ts` | 6 tests | AC-IT-1: Single-node GraphEngine CRUD (upsertNode, getNode, upsertEdge, neighbors, batchUpsertNodes, deleteNode, close) |
| `raft-cluster.test.ts` | 5 tests | AC-IT-2: 3-node simulated Raft cluster (leader election, linearizable read, barrier, follower reject write, leader failover) |
| `rest-cdc-audit.test.ts` | 21 tests | AC-IT-3: CDC end-to-end (subscribe, pause/resume, seq/timestamp), AuditLog (log, query, filter, close), Multi-DB (isolation, concurrent writes, list, not-found), CSV import, CDC checkpoint resume, log rotation, ConsumerGroup |
| `query-suite.test.ts` | 18 tests | Q01 (COUNT/SUM/AVG/MIN/MAX), Q02 (UNION/UNION ALL/INTERSECT/SUBTRACT), Q03 (optimizer bridge), Cypher-lite end-to-end, edge cases (bulk 100, empty result, UNION+aggregate, WHERE+aggregate) |
| `search-rls.test.ts` | 16 tests | S03 + E05: FullText search (index, multi-keyword, highlight, delete, sort-by-relevance, empty index, 50+ docs perf), RLS (owner isolation, admin bypass, search+RLS combined, multi-policy AND, empty RLS) |
| `shard-dualwrite-backup.test.ts` | 18 tests | SH01: Dual-write (2 engines sync), SH02: Snapshot migration (export/import, file round-trip), SH04: Hot node detection (degree-based), SH05: AutoSplitter (threshold, drain, lifecycle), O01: Backup (scheduler, execute, file info), TLS (init, server options, bind, CN extraction, watcher lifecycle) |

**Total integration tests: 84**

### 1.2 Fault-Injection Tests (`test/fault-injection/`)

| File | Tests | Coverage Area |
|------|-------|---------------|
| `network-partition.test.ts` | 3 tests | AC-FI-1: Simulated 3-node partition (leader election, partition one node, restore) |
| `node-crash.test.ts` | 4 tests | AC-FI-2: Simulated 3-node crash (cluster healthy, crash one node, restart, recover writes) |
| `log-corruption.test.ts` | 4 tests | AC-FI-3: WAL corruption (tail truncation, mid-file corruption, file deletion/recreate, data tampering) |
| `reshard-failure.test.ts` | 4 tests | AC-FI-4: Reshard failure (source range crash, target write failure, snapshot retry, mid-split rollback) |
| `clock-skew.test.ts` | 5 tests | AC-FI-5: HLC clock skew (forward jump, backward jump, extreme skew, rapid successive, binary encoding) |
| `consensus-failure.test.ts` | 5 tests | AC-FI-6: Consensus failure (leader crash/reelect, majority failure read-only, leader recovery, network partition majority/minority, multi-leader-change preservation) |

**Total fault-injection tests: 25**

---

## 2. Missing Test Scenarios vs Design Patterns

### 2.1 Raft + EventBus Architecture Isolation (Critical Gap)

The design patterns (whitepaper §1.2, §2.1; execution-plan §2.1) mandate:

> **Raft 数据路径**: `GraphEngine → RangeInstance → ConsensusProvider.propose()` — **完全不经过 EventBus**
> **EventBus 事件路径**: `GraphEngine._emit() → EventStream → EventBus.broadcast()` — 独立通道
> **Outbox 兜底路径**: `GraphEngine._mlReplication.replicate() → Outbox LMDB → PerPeerWorker → EventBus.send()` — 异步发送

**Missing tests:**

| # | Scenario | Design Reference | Gap Severity | Notes |
|---|----------|-----------------|--------------|-------|
| M1 | **Raft commit + Outbox enqueue atomicity** — Verify that after Raft commit, Outbox correctly enqueues the event | Whitepaper §1.2, Execution-Plan §5 (Task 5.1) | 🔴 Critical | No test verifies the Raft → Outbox pipeline. Currently `upsertNode` does both independently without transaction boundary |
| M2 | **Raft propose failure → Outbox has no entry** — When propose returns false, verify no stale Outbox entry | Execution-Plan §5 (Task 5.1) | 🔴 Critical | Design requires Outbox at Raft commit *after*. No test covers the failure path |
| M3 | **Outbox write failure → local write not rolled back** — Verifies behavior (log vs alert) when Outbox fails after Raft commits | Code-optimization-report §2.1 | 🟠 Nice-to-have | Design decision is alarm-only (Raft committed = data persisted); but should be tested |
| M4 | **Raft write path bypasses EventBus** — Assert that `propose()` never calls `_emit()` / `_mlReplication.replicate()` | Whitepaper §1.2 | 🔴 Critical | This is the core architectural invariant! No test proves Raft path is isolated from EventBus |

### 2.2 Outbox Replication (Critical Gap)

| # | Scenario | Design Reference | Gap Severity | Notes |
|---|----------|-----------------|--------------|-------|
| M5 | **Outbox ACK timeout → message retransmission → dedup on receiver** | Execution-Plan §5 (Task 5.2), Code-optimization-report §4.1 | 🔴 Critical | The full retry loop (Outbox → PerPeerWorker → EventBus → ACK → retry → dedup) has no integration test |
| M6 | **Outbox node recovery → replay historical entries** after reconnection | Whitepaper §2.2, §4 | 🔴 Critical | Design says "Outbox TTL (14 days) replay + Raft snapshot sync"; no test covers replay |
| M7 | **Outbox backoff per topology** — Verify intra-DC (3s) vs cross-DC (60s) vs edge (300s) backoff | Whitepaper §1.4, Code-optimization-report §9.2 | 🟠 Nice-to-have | Currently maxBackoffSeconds is global; topology-aware backoff not implemented or tested |
| M8 | **PerPeerWorker isolation** — One peer's failure (slow ACK) doesn't block other peers | Whitepaper §2.2 | 🟠 Nice-to-have | Each peer should have independent worker queue; no integration test |

### 2.3 EventBus ZMQ Transport (Critical Gap)

| # | Scenario | Design Reference | Gap Severity | Notes |
|---|----------|-----------------|--------------|-------|
| M9 | **ROUTER backpressure under high concurrency** — Verify producer-consumer pattern when buffer exceeds watermark | Code-optimization-report §5.1, Execution-Plan §3 (Task 3.3) | 🟠 Nice-to-have | Currently no backpressure; ROUTER could be overwhelmed |
| M10 | **ZMQ dealer connection readiness probe** — probe → ACK → notifyConnected timing | Code-optimization-report §4.2, Execution-Plan §3 (Task 3.1) | 🟠 Nice-to-have | Dealer connect is lazy (async), no probe before Outbox sends |
| M11 | **CURVE config error handling** — Bad public key, NAS directory unreadable, mismatch between nodes | Execution-Plan §5 (Task 5.3) | 🟠 Nice-to-have | Code-optimization-report §6.2 lists this explicitly |
| M12 | **Exponential backoff with jitter** on dealer reconnection | Code-optimization-report §4.1 | 🟢 Nice-to-have | Currently fixed timeout + linear backoff; no jitter |

### 2.4 Raft Leader Election & Failover (Critical Gap)

| # | Scenario | Design Reference | Gap Severity | Notes |
|---|----------|-----------------|--------------|-------|
| M13 | **Leader switch during write** — Writes accepted during ~300ms black window | Whitepaper §2.4, Execution-Plan §5 (Task 5.4) | 🔴 Critical | Whitepaper says "Leader switch ~300ms black window" and Outbox catches it; no test verifies this behavior |
| M14 | **Post-switch Outbox consistency** — Entries before/after leader switch are not lost | Execution-Plan §5 (Task 5.4) | 🔴 Critical | Outbox should buffer during switch; no integration test |
| M15 | **Two-node minority partition** — Verify 2-of-3 node cluster with 1 node isolated. 2-node side has quorum; verify writes succeed | Whitepaper §2.4, Consensus-failure test | 🟠 Nice-to-have | Current consensus-failure test uses MockConsensus, not real Raft; network-partition test tries but imports missing module |
| M16 | **Raft membership change consistency** — Verify EventBus catches changes during member config transition | Whitepaper §2.4 | 🟠 Nice-to-have | Whitepaper says "membership change → EventBus persists → config catch-up" |

### 2.5 EventStream & GraphEngine Events (Critical Gap)

| # | Scenario | Design Reference | Gap Severity | Notes |
|---|----------|-----------------|--------------|-------|
| M17 | **`_emitLocal` during remote apply** — Verify local callbacks fire when `_applyingRemote=true` | Code-optimization-report §9.4, Execution-Plan §2 (Task 2.2) | 🔴 Critical | Currently `_emit()` is completely skipped during remote apply, losing local callbacks |
| M18 | **DedupRing capacity exceeded** — Verify dedup still works after >10K messages in rapid succession | Code-optimization-report §3.1 | 🟠 Nice-to-have | Fixed 10K capacity; no test for window exhaustion |
| M19 | **msgId-level dedup persistence** — Verify dedup survives process restart (not just in-memory DedupRing) | Code-optimization-report §3.2 | 🟠 Nice-to-have | `_applyingRemote` is process-local only |

### 2.6 StandaloneConsensus & Production Readiness (Critical Gap)

| # | Scenario | Design Reference | Gap Severity | Notes |
|---|----------|-----------------|--------------|-------|
| M20 | **StandaloneConsensus must not be default** — Verify RangeInstance enforces consensus parameter requirement | Whitepaper §3, Code-optimization-report §2.2 | 🔴 Critical | P0 risk: multiple nodes with StandaloneConsensus default leads to data inconsistency |
| M21 | **`isRaftLeader` removed from EventBusConfig** — Verify all nodes bind ROUTER regardless of role | Code-optimization-report §9.1, Execution-Plan §2 (Task 2.3) | 🟠 Nice-to-have | Currently non-Leader nodes don't bind ROUTER → Outbox can't reach them |

### 2.7 WorkerPool / Multi-Process (Nice-to-Have)

| # | Scenario | Design Reference | Gap Severity | Notes |
|---|----------|-----------------|--------------|-------|
| M22 | **WorkerPool + EventBus ACK timeout in multi-process mode** | Code-optimization-report §6.2 | 🟢 Nice-to-have | Mentioned as missing coverage in optimization report |
| M23 | **msgpackr binary serialization throughput** — Verify >=30% throughput improvement over JSON | Execution-Plan §4 (Task 4.1) | 🟢 Nice-to-have | Performance benchmark, not functional correctness |

---

## 3. Test Failure Analysis: Code Bug vs Vitest Migration Issue

### 3.1 Failures from `vitest run --config vitest.int.config.ts`

| Test File | Failure | Root Cause | Classification |
|-----------|---------|-----------|----------------|
| `test/fault-injection/network-partition.test.ts` | `Cannot find module '../../src/consensus/raft-node'` | `raft-node.ts` does not exist in `src/consensus/`. Either the file was renamed to `raft-test-node.ts` or removed/restructured. The test imports `RaftNode` from `src/consensus/raft-node`. | ✅ **Vitest migration issue** — Jest config likely had aliases (`~` → `src`) or a different module resolution. The file simply no longer exists. |
| `test/fault-injection/node-crash.test.ts` | `Cannot find module '../../src/consensus/raft-node'` | Same root cause — duplicate import from the same non-existent file. | ✅ **Vitest migration issue** — Same missing `raft-node.ts` |
| `test/integration/raft-cluster.test.ts` | `Cannot find module '../../src/consensus/raft-node'` | Same root cause. | ✅ **Vitest migration issue** — Same missing `raft-node.ts` |
| `test/integration/shard-dualwrite-backup.test.ts` | `collectFileInfo has already been declared` | Duplicate import on lines 20 and 24: `import { collectFileInfo } from '../../src/ops/backup-helpers'` appears twice. | ✅ **Pre-existing code bug** — This is a straightforward duplicate import that would also fail under Jest. It was likely overlooked in manual editing (maybe a bad merge). |
| `test/fault-injection/clock-skew.test.ts` | `expected 0 to be greater than 1` in "should increment logical counter monotonically under rapid successive calls" | The test asserts `toBeGreaterThan(prev)` but HLC resets `logical=0` when `wallTime` advances (as per HLC algorithm spec). The assertion should be `toBeGreaterThanOrEqual` to account for wall-time jumps resetting the logical counter. | ✅ **Pre-existing code bug** — Race condition: if the wall clock ticks between two `nowWithWallTime()` calls, logical counter resets to 0. The test assertion is incorrect for the HLC contract. Was likely flaky under Jest too. |

### 3.2 Summary

| Root Cause | Failed Files | Count |
|-----------|-------------|-------|
| Vitest migration (missing module `raft-node.ts`) | `network-partition.test.ts`, `node-crash.test.ts`, `raft-cluster.test.ts` | 3 |
| Pre-existing code bug (duplicate import) | `shard-dualwrite-backup.test.ts` | 1 |
| Pre-existing code bug (incorrect test assertion) | `clock-skew.test.ts` | 1 |

**Note**: The 3 `raft-node.ts` failures are the *same* missing file. The file was part of an earlier implementation that was either renamed to `raft-test-node.ts` or removed entirely. This is a migration gap — these tests were probably working under Jest with a different module resolution.

---

## 4. Critical Gap Summary

### 🔴 Must-have (6 scenarios)
1. **M1**: Raft commit + Outbox enqueue atomicity — Core architectural invariant
2. **M2**: Raft propose failure → no Outbox entry — Correctness boundary
3. **M4**: Raft write path bypasses EventBus — Foundational design principle
4. **M5**: Outbox ACK timeout → retransmit → dedup — Reliability core
5. **M13**: Leader switch during write with Outbox buffering — Whitepaper §2.4 black window
6. **M20**: StandaloneConsensus not default — P0 production risk

### 🟠 Important (8 scenarios)
7. **M6**: Outbox replay after node recovery
8. **M9**: ROUTER backpressure
9. **M10**: Dealer connection readiness
10. **M11**: CURVE config error handling
11. **M14**: Post-switch Outbox consistency
12. **M15**: Two-node minority partition (real Raft)
13. **M17**: `_emitLocal` during remote apply
14. **M21**: Remove `isRaftLeader` from EventBus

### 🟢 Nice-to-have (5 scenarios)
15. M3, M7, M8, M12, M16, M18, M19, M22, M23

---

## 5. Recommendations

### First Priority (Fix Existing Failures)
1. **Remove duplicate `collectFileInfo` import** in `shard-dualwrite-backup.test.ts` — 30-second fix
2. **Fix `clock-skew.test.ts` assertion** — change `toBeGreaterThan` to `toBeGreaterThanOrEqual` (HLC algorithm correctness)
3. **Fix `raft-node.ts` missing module** — Either:
   - Re-create `raft-node.ts` as a wrapper around `raft-test-node.ts`, OR
   - Update the 3 failing tests to import from the correct module path

### Second Priority (New Integration Tests)
- Implement M1-M2 (Raft + Outbox pipeline) — ~1d
- Implement M4 (path isolation) — ~0.5d
- Implement M5 (Outbox retry + dedup) — ~0.5d
- Implement M13-M14 (Leader switch coverage) — ~1d

### Third Priority (New Fault-Injection Tests)
- Implement M6 (Outbox node recovery) — ~0.5d
- Implement M11 (CURVE error handling) — ~0.5d
- Implement M15 (minority partition with real Raft) — ~0.5d
