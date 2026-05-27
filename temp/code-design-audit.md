# Code-vs-Design Audit: Comprehensive Report

> Generated: 2026-05-27  
> Source: OverGraph (agentiX-graphvec)  
> Base Documents: `docs/design/whitepaper-raft-eventbus-multileader.md`, `docs/design/execution-plan.md`, `docs/design/raft-eventbus-multileader-design-pattern.md`, `docs/design/cross-dc-raft-sync-pattern.md`, `docs/design/code-optimization-report.md`, `docs/reliable-replication-设计.md`

---

## 1. Design Document Summary

### 1.1 Documents Found & Status

| Document | Lines | Role | Completeness |
|----------|-------|------|-------------|
| `docs/design/whitepaper-raft-eventbus-multileader.md` | 207 | [**核心白皮书**] Architecture spec, design principles, 一致性分层, 路径正交, 幂等三层保护, 拓扑感知退避 | ✅ Complete (v1.1) |
| `docs/design/execution-plan.md` | 461 | [**可执行计划**] Phase 0-6: 15 tasks covering infra, type safety, consistency, transport, perf, test, ops | ✅ Complete |
| `docs/design/raft-eventbus-multileader-design-pattern.md` | 534 | [**设计模式文档**] Generalized pattern, interface specs, deployment configs | ✅ Complete |
| `docs/design/cross-dc-raft-sync-pattern.md` | 688 | [**跨DC模式**] Dual-channel guarantee, conflict resolution, DR procedures | ✅ Complete |
| `docs/design/code-optimization-report.md` | 431 | [**优化报告**] 11+ issues identified (P0-P3), per-module analysis | ✅ Complete |
| `docs/reliable-replication-设计.md` | 93 | [**Outbox详细设计**] Peer state machine, PerPeerWorker spec | ✅ Complete |
| `docs/EventBus_WorkerPool_实现方案_v2.md` | 733 | [**WorkerPool设计**] Multi-process ZMQ offloading | ✅ Complete |
| `docs/EventBus_WorkerPool_多核方案_v3.md` | 409 | [**WorkerPool v3**] Improved multi-core scheme | ✅ Complete |
| `docs/deep-review-v2-报告.md` | 287 | [**深度审查报告**] Cross-cutting audit findings | ✅ Complete |

### 1.2 Design Requirements Summary (Extracted from White Paper + Cross-DC Pattern)

The design mandates the following **architectural invariants** and **functional requirements**:

| ID | Requirement | Source | Category |
|----|------------|--------|----------|
| **R1** | **Raft data path must NOT pass through EventBus** — Raft and EventBus are orthogonal channels | Whitepaper §1.2 | Architectural invariant |
| **R2** | **Raft is mandatory for production** — `StandaloneConsensus` is dev-only, **must not** be the default | Whitepaper §3 | Production constraint |
| **R3** | **Outbox enqueues AFTER Raft commit** — Write sequence: Raft propose → commit → Outbox enqueue | Whitepaper §2.2, Cross-DC §2.5 | Data consistency |
| **R4** | **Outbox write failure does NOT roll back local write** — Raft committed = data persisted; alert only | Whitepaper §2.4 | Recovery behavior |
| **R5** | **Outbox ACK timeout → retransmit** — At-least-once delivery with DedupRing for dedup | Whitepaper §1.3, §2.2 | Reliability |
| **R6** | **Per-Peer independent Outbox Workers** — One peer's failure does not block others | Whitepaper §2.2 | Isolation |
| **R7** | **Backoff per topology** — intra-DC: 3s, cross-DC: 60s, edge: 300s | Whitepaper §1.4, Cross-DC §4.2 | Topology awareness |
| **R8** | **Leader switch during write (~300ms black window)** — Outbox catches missed events | Whitepaper §2.4 | Fault tolerance |
| **R9** | **Network partition (split-brain)** — Majority serves, minority receives Outbox via EventBus | Whitepaper §2.4, Cross-DC §2.5 | Fault tolerance |
| **R10** | **Raft membership change** — EventBus persists during config transition | Whitepaper §2.4 | Fault tolerance |
| **R11** | **DedupRing (10K msgId capacity)** — In-memory dedup for short window | Whitepaper §1.3 | Deduplication |
| **R12** | **Recursion protection** — `_applyingRemote` + `skipReplication` + MAX_RECURSION_DEPTH | Whitepaper §1.3, Design Pattern §3.5 | Safety |
| **R13** | **Local callbacks during remote apply** — `_emit()` skipped but local EventEmitter must fire | Execution plan §2.2 | Correctness |
| **R14** | **`isRaftLeader` removed from EventBus** — All nodes bind ROUTER regardless of role | Execution plan §2.3 | Architecture |
| **R15** | **EventBus ZMQ architecture** — Each node: 1×ROUTER server + N×DEALER clients | Whitepaper §2.3 | Transport |
| **R16** | **CURVE25519 two-way auth + transport encryption** — Public keys via NAS shared dir | Whitepaper §2.3 | Security |
| **R17** | **ROUTER backpressure** — Producer-consumer pattern, buffer watermark | Execution plan §3.3 | Transport robustness |
| **R18** | **ZMQ dealer connection readiness probe** — Check before Outbox sends | Execution plan §3.1 | Transport robustness |
| **R19** | **Outbox TTL (14 days)** — Historical replay for long-duration node recovery | Whitepaper §2.4, Cross-DC §4.5 | Recovery |
| **R20** | **EventBus type safety** — No `as any` on ZMQ Router/Dealer types | Code-optimization §1.1, Execution plan §1 | Quality |
| **R21** | **Linearizable reads via barrier** — `barrier()` before read to catch up committed entries | Design Pattern §3.1 | Consistency |
| **R22** | **Leader switch test** — Verify write behavior during failover, Outbox integrity post-switch | Execution plan §5.4 | Test coverage |

---

## 2. Current Code Coverage vs Design

### 2.1 Coverage Heatmap by Module

| Module | Key Files | Design Reqs | Tested By | Coverage Level |
|--------|-----------|-------------|-----------|---------------|
| **GraphEngine (core)** | `graph-engine.ts` | R1, R3, R4, R12, R13 | `single-node.test.ts` (6 tests), `graph-engine.spec.ts` (unit) | 🟡 **Partial** — CRUD works, but R1/R3/R12/R13 paths not verified |
| **Raft Consensus** | `raft-core.ts`, `raft-logic-consensus.ts`, `simulated-raft.ts`, `standalone-consensus.ts` | R1, R2, R8, R9, R21 | `raft-cluster.test.ts` (5 tests), `consensus-failure.test.ts` (5 tests) | 🟡 **Partial** — Leader election, barrier, failover simulated; no production raft-rs coverage |
| **EventBus (ZMQ)** | `event-bus.ts` | R1, R15, R16, R17, R18, R20 | `event-bus-edge.spec.ts`, `event-bus.live.spec.ts`, `event-bus.curvespec.ts` (unit) | 🔴 **Weak** — Unit tests exist; no integration test for R17/R18/R20 |
| **EventStream** | `event-stream.ts` | R13 | `event-stream.spec.ts` (unit), `graph-engine-eventstream.spec.ts` | 🟡 **Partial** — Unit tests exist; R13 not verified |
| **Outbox** | `outbox-replication.ts`, `multi-leader-replication.ts` | R3, R4, R5, R6, R7, R19 | `outbox-replication.spec.ts`, `multi-leader-replication.spec.ts`, `multi-leader-integration.spec.ts`, `raft-eventbus-pipeline.test.ts` (just created) | 🟡 **Partial** — Unit tests exist; new pipeline test adds R1/R3/R5 coverage |
| **CDC / Audit** | `cdc-consumer.ts`, `audit-log.ts` | — | `rest-cdc-audit.test.ts` (21 tests) | 🟢 **Good** — Well covered |
| **Query** | `query-engine.ts`, `planner-bridge.ts` | — | `query-suite.test.ts` (18 tests) | 🟢 **Good** — Well covered |
| **Search / RLS** | `fulltext.ts`, `rls.ts` | — | `search-rls.test.ts` (16 tests) | 🟢 **Good** — Well covered |
| **Shard / DualWrite** | `shard-manager.ts`, `range-instance.ts`, `auto-splitter.ts` | R2 | `shard-dualwrite-backup.test.ts` (18 tests) | 🟡 **Partial** — R2 not verified |
| **WAL** | `wal.ts`, `lmdb-wal.ts` | — | `log-corruption.test.ts` (4 tests), `wal.spec.ts` (unit) | 🟡 **Partial** — WAL recovery tested; LMDB WAL not |
| **Reshard** | `reshard-worker.ts`, `reshard-manager.ts` | — | `reshard-failure.test.ts` (4 tests) | 🟡 **Partial** — Mock-based, not real reshard |
| **HLC** | `hlc-clock.ts` | — | `clock-skew.test.ts` (5 tests) | 🟢 **Good** — With known assertion bug |
| **Backup / TLS / Ops** | `backup.ts`, `tls.ts`, `health.ts` | — | `shard-dualwrite-backup.test.ts` (partial), backup spec | 🟡 **Partial** |

### 2.2 New Test Coverage Gaps vs Design Requirements

The newly created `raft-eventbus-pipeline.test.ts` (3 describe blocks) covers:

| Design Req | Tested? | How? |
|------------|---------|------|
| **R1** (Raft bypasses EventBus) | ✅ **New** | M4 test: spy on EventBus.emit, upsert via ML Replication, verify EventBus has 0 events |
| **R3** (Outbox after Raft commit) | ✅ **New** | M1 test: upsertNode, verify Outbox has pending entries via `getStats()` and `getPendingCount()` |
| **R5** (Outbox retry + dedup) | ✅ **New** | M5 test: simulate no-ACK → markPending → retransmit → dedup |

But the following remain **completely untested** (see §3 for full gap evaluation):

| Design Req | Status | Why Missing |
|------------|--------|-------------|
| R2 (StandaloneConsensus not default) | ❌ **Not tested** | No test verifies RangeInstance construction rejects absent ConsensusProvider |
| R4 (Outbox failure → local write not rolled back) | ❌ **Not tested** | Alert-only behavior not verified |
| R6 (Per-Peer Worker isolation) | ❌ **Not tested** | No integration test with multiple peers showing isolation |
| R7 (Topology-aware backoff) | ❌ **Not tested** | Backoff is global, not topology-aware; no test |
| R8 (Leader switch black window) | ❌ **Not tested** | No test simulates leader switch while Outbox sends |
| R9 (Network partition with Outbox) | ❌ **Not tested** | Current partition test uses SimulatedRaft only; no Outbox involvement |
| R10 (Raft membership change) | ❌ **Not tested** | Not addressed in any test |
| R11 (DedupRing capacity) | ❌ **Not tested** | No test for >10K rapid messages |
| R13 (Local callbacks during remote apply) | ❌ **Not tested** | No test sets `_applyingRemote=true` and checks EventEmitter fired |
| R14 (isRaftLeader removal) | ❌ **Not tested** | No test verifies all nodes bind ROUTER |
| R16 (CURVE error handling) | ❌ **Not tested** | CURVE tests exist but no error-handling integration test |
| R17 (ROUTER backpressure) | ❌ **Not tested** | Not implemented, not tested |
| R18 (Dealer connection readiness) | ❌ **Not tested** | Not implemented, not tested |
| R19 (Outbox TTL) | ❌ **Not tested** | No TTL enforcement test |
| R20 (No `as any` in EventBus) | ❌ **Not tested** | Static analysis only |
| R21 (Linearizable read via barrier) | 🟡 Partial | raft-cluster.test.ts calls barrier() but doesn't verify read-after-write linearizability |
| R22 (Leader switch comprehensive) | ❌ **Not tested** | Only basic failover in raft-cluster.test.ts |

---

## 3. Gap Evaluation

### 3.1 Re-evaluation of test-gap-analysis.md Findings

The prior `temp/test-gap-analysis.md` identified 23 missing test scenarios (M1-M23). Re-evaluated against design documents:

#### 🔴 Critical Gaps (Confirmed)

| Gap ID | Scenario | Original Severity | Design Req | Confirmed? | Current Status |
|--------|----------|-------------------|------------|------------|----------------|
| M1 | Raft commit + Outbox enqueue atomicity | 🔴 Critical | R3 | ✅ Confirmed | **Partially addressed** by new raft-eventbus-pipeline M1 tests — verify Outbox has entries after write, but do NOT verify atomicity (Raft commit and Outbox enqueue in the same transaction) |
| M2 | Raft propose failure → no Outbox entry | 🔴 Critical | R3 | ✅ Confirmed | **Untested.** The new M1 tests only cover the success path |
| M3 | Outbox failure → local write not rolled back | 🟠 Nice-to-have | R4 | ⬆️ **Should be upgraded to 🟠 Important** | Design says alert-only, but this behavior should be verified |
| M4 | Raft write bypasses EventBus | 🔴 Critical | R1 | ✅ Confirmed | **Partially addressed** by new M4 tests — verify ML replication path does not reach EventBus. RaftNode path also tested. |
| M5 | Outbox ACK timeout → retransmit → dedup | 🔴 Critical | R5 | ✅ Confirmed | **Partially addressed** by new M5 tests — verify Outbox lifecycle (markPending → retransmit → dedup) at Outbox layer. Full end-to-end (EventBus → ACK → retry) not tested. |
| M13 | Leader switch during write, Outbox buffer | 🔴 Critical | R8 | ✅ Confirmed | **Untested.** The consensus-failure test uses MockConsensus, not Outbox |
| M20 | StandaloneConsensus must not be default | 🔴 Critical | R2 | ✅ Confirmed | **Untested.** Whitepaper explicitly calls this P0 risk |

#### 🟠 Important Gaps (Confirmed)

| Gap ID | Scenario | Original Severity | Design Req | Confirmed? | Current Status |
|--------|----------|-------------------|------------|------------|----------------|
| M6 | Outbox replay after node recovery | 🟠 Important | R5/R19 | ✅ | **Untested** |
| M7 | Outbox topology-aware backoff | 🟠 Nice-to-have | R7 | ⬆️ **Should be upgraded to 🟠 Important** | Whitepaper §1.4 specifies this as core design |
| M8 | PerPeerWorker isolation | 🟠 Nice-to-have | R6 | ⬆️ **Should be upgraded to 🟠 Important** | Isolation is fundamental to reliability |
| M9 | ROUTER backpressure | 🟠 Nice-to-have | R17 | ✅ Confirmed | **Not implemented or tested** |
| M10 | Dealer connection readiness | 🟠 Nice-to-have | R18 | ✅ Confirmed | **Not implemented or tested** |
| M11 | CURVE config error handling | 🟠 Nice-to-have | R16 | ✅ Confirmed | **Untested** in integration |
| M14 | Post-switch Outbox consistency | 🟠 Important | R8 | ✅ Confirmed | **Untested** |
| M15 | Two-node minority partition (real Raft) | 🟠 Nice-to-have | R9 | ⬆️ **Should be upgraded to 🟠 Important** | Network partition is a core fault scenario |
| M17 | `_emitLocal` during remote apply | 🔴 Critical (original) / 🟠 (re-eval) | R13 | ✅ Confirmed | **Untested**. Downgraded to 🟠 because design is not fully finalized; fix plan exists |
| M21 | `isRaftLeader` removed from EventBus | 🟠 Nice-to-have | R14 | ✅ Confirmed | **Untested** |

#### 🟢 Nice-to-Have Gaps (Confirmed)

| Gap ID | Scenario | Original Severity | Design Req | Status |
|--------|----------|-------------------|------------|--------|
| M12 | Exponential backoff with jitter | 🟢 | — | Untested |
| M16 | Raft membership change consistency | 🟠 (re-eval) | R10 | ⬆️ **Should be upgraded to 🟠 Important** — Essential for operational correctness |
| M18 | DedupRing capacity exceeded | 🟢 | R11 | Untested |
| M19 | msgId-level dedup persistence | 🟢 | — | Untested |
| M22 | WorkerPool multi-process mode | 🟢 | — | Untested |
| M23 | msgpackr serialization throughput | 🟢 | — | Untested |

### 3.2 Severity Changes vs Original Gap Analysis

| Original Severity | Count | Corrected Count | Net Change |
|-------------------|-------|-----------------|------------|
| 🔴 Critical | 6 | 6 | No change |
| 🟠 Important | 8 | 11 | +3 (M3↑, M7↑, M8↑, M15↑, M16↑) |
| 🟢 Nice-to-have | 9 | 6 | -3 |

**Upgraded items**: M3 (Outbox failure behavior should be verified), M7 (topology-aware backoff is core design), M8 (peer isolation is fundamental), M15 (real partition test), M16 (membership change is operational essential).

### 3.3 Existing Test Failures (from test-gap-analysis.md §3)

| Failure | Root Cause | Classification | Impact on Audit |
|---------|-----------|----------------|-----------------|
| `network-partition.test.ts` — `Cannot find module '../../src/consensus/raft-node'` | File renamed to `raft-test-node.ts` | Vitest migration gap | **False gap** — test infrastructure only, not design coverage |
| `node-crash.test.ts` — same | Same `raft-node.ts` missing | Vitest migration gap | **False gap** — same |
| `raft-cluster.test.ts` — same | Same `raft-node.ts` missing | Vitest migration gap | **False gap** — same |
| `shard-dualwrite-backup.test.ts` — duplicate import | Double `import { collectFileInfo }` on lines 20+24 | Pre-existing bug | **Real bug** — cheap fix |
| `clock-skew.test.ts` — `expected 0 to be greater than 1` | HLC logical counter resets on wallTime advance | Pre-existing test assertion error | **Real bug** — assertion should be `>=` not `>` |

---

## 4. Production Readiness Checklist

For each design requirement, has it been verified by an integration or unit test?

### 4.1 Core Architecture Invariants

| Design Req | Integration Test | Unit Test | Production Ready? | Notes |
|------------|-----------------|-----------|-------------------|-------|
| R1: Raft bypasses EventBus | 🟡 Partial (M4 new) | ❌ | ❌ **Not ready** | ML + RaftNode paths tested; full production stack not verified |
| R2: StandaloneConsensus not default | ❌ | ❌ | ❌ **P0 Risk** | No test enforces this |
| R3: Outbox after Raft commit | 🟡 Partial (M1 new) | ❌ | ❌ **Not ready** | Success path only; no atomicity/failure path |
| R4: Outbox failure behavior | ❌ | ❌ | ❌ Not verified | Design says alert-only; untested |
| R14: Remove isRaftLeader from EventBus | ❌ | ❌ | ❌ Not verified | |

### 4.2 Reliability & Fault Tolerance

| Design Req | Integration Test | Unit Test | Production Ready? | Notes |
|------------|-----------------|-----------|-------------------|-------|
| R5: Outbox retry + dedup | 🟡 Partial (M5 new) | ✅ Outbox spec | 🟡 **Partial** | Outbox lifecycle verified; full ZMQ end-to-end not |
| R6: Per-Peer Worker isolation | ❌ | 🟡 Partial (outbox spec) | ❌ Not verified | |
| R7: Topology-aware backoff | ❌ | ❌ | ❌ Not implemented | Backoff is global |
| R8: Leader switch black window | ❌ | 🟡 Partial (consensus-failure spec) | ❌ Not verified | Mock-based only |
| R9: Network partition | ❌ | ❌ | ❌ Not verified | Existing test imports non-existent module |
| R10: Raft membership change | ❌ | ❌ | ❌ Not verified | |
| R19: Outbox TTL / replay | ❌ | ❌ | ❌ Not verified | |

### 4.3 Transport Robustness

| Design Req | Integration Test | Unit Test | Production Ready? | Notes |
|------------|-----------------|-----------|-------------------|-------|
| R15: ZMQ ROUTER/DEALER | ❌ | ✅ Unit spec | 🟡 **Partial** | Unit tests exist, no integration |
| R16: CURVE encryption | ❌ | ✅ CURVE spec | 🟡 **Partial** | No integration test for error handling |
| R17: ROUTER backpressure | ❌ | ❌ | ❌ Not implemented | |
| R18: Dealer readiness probe | ❌ | ❌ | ❌ Not implemented | |
| R20: EventBus type safety | ❌ | ❌ (static) | ❌ **P1 Risk** | 13+ `as any` in EventBus |

### 4.4 Data Correctness

| Design Req | Integration Test | Unit Test | Production Ready? | Notes |
|------------|-----------------|-----------|-------------------|-------|
| R11: DedupRing 10K | ❌ | ❌ | ❌ Not verified | |
| R12: Recursion protection | ❌ | 🟡 Partial (graph-engine spec) | 🟡 **Partial** | Unit tests may cover; no integration |
| R13: Local callbacks during remote apply | ❌ | ❌ | ❌ Not verified | |
| R21: Linearizable reads | 🟡 Partial | ❌ | 🟡 **Partial** | barrier() called but linearizability not verified |

### 4.5 Overall Production Readiness Score

| Layer | Requirements | Tested | Coverage |
|-------|-------------|--------|----------|
| **Core architecture** (R1-R4, R14) | 5 | 1 partial | **~10%** |
| **Reliability/FT** (R5-R10, R19) | 7 | 1 partial | **~7%** |
| **Transport** (R15-R18, R20) | 5 | 0 integration | **~0%** |
| **Data correctness** (R11-R13, R21) | 4 | 1 partial | **~12%** |
| **Total** | 21 | 3 partial | **~7% fully ready** |

> ⚠️ **Conclusion: Not production-ready.** 93% of design requirements lack full verification. Critical gaps in core architecture invariants (R1/R2/R3) and reliability scenarios (R5/R8/R9).

---

## 5. Recommendations

### 5.1 Immediate (Fix Existing Failures First)

| Priority | Task | Effort | Impact |
|----------|------|--------|--------|
| 🔴 **Critical** | Fix 3 `raft-node.ts` import paths in `raft-cluster.test.ts`, `network-partition.test.ts`, `node-crash.test.ts` — change `../../src/consensus/raft-node` to `../../src/consensus/raft-test-node` | 10 min | Unblocks 12 existing tests |
| 🔴 **Critical** | Fix duplicate `collectFileInfo` import in `shard-dualwrite-backup.test.ts` | 1 min | Fixes existing compilation error |
| 🟠 **Important** | Fix `clock-skew.test.ts` assertion — change `toBeGreaterThan(prev)` to `toBeGreaterThanOrEqual(prev)` | 2 min | Corrects HLC test contract |

### 5.2 High Priority (Architecture & Data Consistency)

| Priority | Task | Design Req | Effort | Notes |
|----------|------|------------|--------|-------|
| 🔴 **P0** | **Enforce StandaloneConsensus removal** — Make `consensus` parameter in `RangeInstance` constructor **required** (non-optional). Update all callers. Write test to verify. | R2 | 0.5d | Whitepaper §3 explicitly calls this P0 risk |
| 🔴 **P0** | **Build Raft + Outbox atomicity integration test** — Extend M1 tests to: (a) verify Raft propose failure → Outbox has 0 entries; (b) verify Outbox write failure does NOT roll back Raft commit | R3, R4 | 1d | Core correctness boundary |
| 🔴 **P0** | **Build Leader switch + Outbox buffer integration test** — Simulate Raft leader switch while writes in flight; verify Outbox entries are preserved and eventually replicated | R8 | 1d | Whitepaper §2.4 black window scenario |
| 🟠 **P1** | **Build end-to-end Outbox retry + dedup test** — Extend M5 tests to: (a) use real EventBus ZMQ transport; (b) simulate ACK loss by dropping messages; (c) verify receiver-side DedupRing catches duplicates | R5 | 1.5d | Full reliability pipeline |
| 🟠 **P1** | **Fix production `raft-logic-consensus` integration** — Verify raft-rs WASM consensus works end-to-end with integration test (currently only `SimulatedRaftConsensus` is tested) | R2 | 1d | Production readiness |
| 🟠 **P1** | **Remove `isRaftLeader` from EventBusConfig** — All nodes must bind ROUTER regardless of role | R14 | 0.5d | Architecture cleanup |

### 5.3 Medium Priority (Reliability & Robustness)

| Priority | Task | Design Req | Effort | Notes |
|----------|------|------------|--------|-------|
| 🟠 **P2** | **Implement + test ROUTER backpressure** — Producer-consumer pattern with buffer watermark | R17 | 1d | Execution plan §3.3 |
| 🟠 **P2** | **Implement + test ZMQ dealer readiness probe** — Probe-ACK before Outbox sends | R18 | 1d | Execution plan §3.1 |
| 🟠 **P2** | **Implement + test topology-aware Outbox backoff** — Intra-DC 3s / cross-DC 60s | R7 | 0.5d | Execution plan §3.2 |
| 🟠 **P2** | **Build end-to-end network partition test** (fix missing module + add Outbox coverage) — Real SimulatedRaft partition with Outbox verifying EventBus catch-up | R9 | 1d | Cross-DC pattern §2.5 |
| 🟠 **P2** | **Test `_emitLocal` during remote apply** — Set `_applyingRemote=true`, call upsertNode, verify EventEmitter local callbacks fire | R13 | 0.5d | Execution plan §2.2 |
| 🟠 **P2** | **Test Per-PeerWorker isolation** — Slow peer ACK should not block other peers | R6 | 0.5d | |
| 🟠 **P2** | **Test DedupRing capacity exhaustion** — Send >10K rapid messages, verify dedup still works and oldest entries are evicted | R11 | 0.5d | Code-optimization §3.1 |

### 5.4 Lower Priority (Nice to Have)

| Priority | Task | Design Req | Effort |
|----------|------|------------|--------|
| 🟡 **P3** | Implement exponential backoff with jitter on dealer reconnection | — | 0.5d |
| 🟡 **P3** | Test Outbox node recovery → replay historical entries from TTL window | R5/R19 | 0.5d |
| 🟡 **P3** | Test Raft membership change with EventBus catch-up | R10 | 1d |
| 🟡 **P3** | Update EventBus to use real ZMQ Router/Dealer types (eliminate 13 `as any`) | R20 | 2d |
| 🟡 **P3** | Test CURVE config error handling (bad keys, NAS issues) | R16 | 0.5d |
| 🟢 **P4** | msgpackr serialization benchmark | — | 0.5d |
| 🟢 **P4** | Outbox pagination query | — | 0.5d |

### 5.5 Implementation Roadmap

```
 Week 1: Fix existing failures + P0 tasks
   ├── Fix 3 raft-node.ts import paths (10 min)
   ├── Fix duplicate import in shard-dualwrite-backup (1 min)
   ├── Fix clock-skew assertion (2 min)
   ├── Enforce StandaloneConsensus removal (0.5d)
   ├── Raft + Outbox atomicity integration test (1d)
   └── Leader switch + Outbox buffer test (1d)
   ⇒ Unblocks 15 tests + covers 2 critical design reqs

 Week 2: P1 tasks
   ├── End-to-end Outbox retry + dedup (1.5d)
   ├── raft-logic-consensus production integration test (1d)
   ├── Remove isRaftLeader from EventBus (0.5d)
   └── Network partition + Outbox test (1d)
   ⇒ Covers 4 additional design reqs

 Week 3: P2 tasks
   ├── ROUTER backpressure (1d)
   ├── Dealer readiness probe (1d)
   ├── Topology-aware backoff (0.5d)
   ├── _emitLocal during remote apply (0.5d)
   ├── Per-PeerWorker isolation (0.5d)
   └── DedupRing capacity test (0.5d)
   ⇒ Covers 6 additional design reqs

 Week 4+: P3/P4 tasks
   ├── Exponential backoff with jitter (0.5d)
   ├── Outbox TTL / replay test (0.5d)
   ├── Raft membership change test (1d)
   ├── EventBus type cleanup (2d)
   ├── CURVE error handling test (0.5d)
   ├── msgpackr benchmark (0.5d)
   └── Outbox pagination (0.5d)
```

### 5.6 Summary of Key Risks

| Risk | Severity | What's Missing |
|------|----------|----------------|
| **StandaloneConsensus default may cause silent data inconsistency** in multi-node deployment | 🔴 **P0** | No test enforces that `RangeInstance` requires explicit `ConsensusProvider` |
| **Raft + Outbox pipeline may silently drop events** when Raft commits but Outbox fails | 🔴 **P0** | No test verifies the transaction boundary between Raft commit and Outbox enqueue |
| **Leader switch during writes may lose events** in the ~300ms black window | 🔴 **P0** | No test verifies Outbox buffers during leader election |
| **3 existing integration tests fail due to missing module** (reduced testing trust) | 🔴 **P0** | `raft-node.ts` was renamed to `raft-test-node.ts`; imports not updated |
| **EventBus has 13+ `as any` casts** — runtime type errors not caught at compile time | 🟠 **P1** | TypeScript cannot verify ZMQ socket operations |
| **No production raft-rs (WASM) integration test** — production Raft never exercised | 🟠 **P1** | All cluster tests use SimulatedRaftConsensus |
