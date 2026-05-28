# R9/R10: Network Partition Handling & Membership Change

## Technical Design & Implementation Guide

> **Generic architecture**: raft-logic (tikv/raft-rs WASM) + ZMQ EventBus + Outbox delivery
> **Database engine**: swappable (the state machine being replicated is a detail)
> **Source reference**: `agentiX-graphvec` implementation at `/src/consensus/`, `/src/core/outbox-replication.ts`, `/src/core/multi-leader-replication.ts`
> **Tests**: 4 test files across unit, integration, and application-layer suites

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [R9: Network Partition (Split-Brain) Handling](#2-r9-network-partition-split-brain-handling)
   - [2.1 Design Principles](#21-design-principles)
   - [2.2 Interface Design](#22-interface-design)
   - [2.3 Path A: Raft-Logic WASM Three-Tier Detection (Production)](#23-path-a-raft-logic-wasm-three-tier-detection-production)
   - [2.4 Path B: Application-Layer Heartbeat Manager (Recommended)](#24-path-b-application-layer-heartbeat-manager-recommended)
   - [2.5 Implementation: Outbox Freezing](#25-implementation-outbox-freezing)
   - [2.6 Wiring the Two Paths](#26-wiring-the-two-paths)
   - [2.7 Standalone Mode](#27-standalone-mode)
   - [2.8 Edge Cases & Failure Modes](#28-edge-cases--failure-modes)
3. [R10: Safe Membership Change](#3-r10-safe-membership-change)
   - [3.1 Design Principles](#31-design-principles)
   - [3.2 Interface Design](#32-interface-design)
   - [3.3 Path A: Application-Layer Membership Manager (Recommended)](#33-path-a-application-layer-membership-manager-recommended)
   - [3.4 Path B: WASM ConfChangeV2 (when bindings mature)](#34-path-b-wasm-confchangev2-when-bindings-mature)
   - [3.5 Integration: EventBus Dynamic Connection Management](#35-integration-eventbus-dynamic-connection-management)
   - [3.6 Safety Guarantees](#36-safety-guarantees)
   - [3.7 Edge Cases & Failure Modes](#37-edge-cases--failure-modes)
4. [Integration Checklist](#4-integration-checklist)
5. [Testing Strategy](#5-testing-strategy)
6. [Known Pitfalls & Bug Fix History](#6-known-pitfalls--bug-fix-history)
7. [Appendix: Complete Source Code References](#7-appendix-complete-source-code-references)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 6: Database Engine / State Machine                           │
│  (swappable: graphvec, MySQL, Redis, etc.)                          │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 5: OutboxReplicationManager                                  │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                │
│  │PerPeerWorker │ │PerPeerWorker │ │PerPeerWorker │                │
│  │  (peer A)    │ │  (peer B)    │ │  (peer C)    │                │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘                │
│         │                │                │                         │
├─────────┼────────────────┼────────────────┼─────────────────────────┤
│  Layer 4: ZMQ EventBus (ROUTER/DEALER transport)                    │
│  ┌──────┴────────────────┴────────────────┴─────────────────────┐  │
│  │  ZMQ ROUTER socket (receives) × N DEALER sockets (sends)     │  │
│  └───────────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 3: MultiLeaderReplication (orchestration)                     │
│  - Walks ConsensusProvider.onMajorityChange → OutboxManager         │
│  - Walks ConsensusProvider.onMembershipChange → EventBus dynamic    │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 2: ConsensusProvider (abstraction interface)                  │
│  ┌───────────────────────┐ ┌─────────────────┐ ┌─────────────────┐ │
│  │  RaftLogicConsensus   │ │SimulatedRaft    │ │StandaloneCons.  │ │
│  │  (tikv/raft-rs WASM)  │ │(in-memory test) │ │(single-node)    │ │
│  └───────────────────────┘ └─────────────────┘ └─────────────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 1: raft-logic (tikv/raft-rs WASM) — Raft consensus engine    │
│  - Leader election, log replication, preVote, checkQuorum           │
│  - onQuorumActive(), onRoleChange() events (R9 detection)           │
│  - proposeConfChange() / applyConfChange() (R10, when API matures)  │
├─────────────────────────────────────────────────────────────────────┤
│  Parallel: AppHeartbeatManager + AppMembershipManager                │
│  ┌───────────────────────┐ ┌──────────────────────────────────┐    │
│  │ AppHeartbeatManager   │ │ AppMembershipManager             │    │
│  │ (1s ping + Outbox     │ │ (Application-layer two-phase    │    │
│  │  failure cross-check) │ │  commit via EventBus broadcast) │    │
│  └───────────────────────┘ └──────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

### Layer Responsibilities

| Layer | Component | Responsibility |
|-------|-----------|---------------|
| **1** | raft-logic WASM (tikv/raft-rs) | Raft state machine: election, replication, membership proposals |
| **2** | ConsensusProvider | Abstract interface over any consensus implementation |
| **3** | MultiLeaderReplication | Orchestration: wires consensus to outbox, handles lifecycle |
| **4** | ZMQ EventBus | Network transport: ROUTER for receiving, DEALER per peer for sending, CurveZMQ auth |
| **5** | OutboxReplicationManager | Per-peer reliable delivery with backoff, ACK tracking, retries |
| **6** | Database Engine | The replicated state machine (any data store) |
| **7** | AppHeartbeatManager | Application-layer heartbeat partition detection (1s ping + Outbox failure cross-check) |
| **8** | AppMembershipManager | Application-layer two-phase commit membership change via EventBus broadcast |

### Key Design Principle: Two Parallel Paths

The system supports **two parallel implementation paths** for both R9 and R10:

| Requirement | Path A (Production Raft-Logic) | Path B (Application-Layer, Recommended) |
|-------------|-------------------------------|----------------------------------------|
| **R9 Partition Detection** | Three-tier via raft-logic WASM: `onQuorumActive` + `onRoleChange` + polling | `AppHeartbeatManager`: 1s ping + Outbox failure cross-check |
| **R10 Membership Change** | `ConfChangeV2` API via raft-logic WASM | `AppMembershipManager`: Two-phase commit via EventBus broadcast |

**The two paths are complementary and can run simultaneously.** Path B is production-ready today; Path A depends on raft-logic WASM bindings maturing.

---

## 2. R9: Network Partition (Split-Brain) Handling

### 2.1 Design Principles

1. **Fast detection over perfect accuracy** — Use multiple detection tiers; a brief false positive during leader election is acceptable (outbox freezes momentarily), whereas a missed partition could send ghost messages.
2. **Fail-closed** — When a node loses majority, freeze the outbox immediately. No messages leave the node during a partition.
3. **No ghost messages** — Messages queued during a partition must NOT be sent until the node re-enters the majority. They must also not be lost (durable persistence is orthogonal).
4. **Resume transparently** — When majority is regained, the outbox unfreezes and pending messages resume sending with no operator intervention.
5. **ACK cleanup continues** — Even in frozen state, ACK timeout tracking must continue to prevent `ackTracker` resource leaks.

### 2.2 Interface Design

The following methods are added to `ConsensusProvider`:

```typescript
export interface ConsensusProvider {
  // ... existing methods (start, stop, propose, readIndex, getRole, etc.) ...

  // ── R9: Network Partition Handling ──

  /** Whether the current node is in the raft majority quorum.
   *  Used by Outbox to pause outbound sends when not in majority. */
  inMajority(): boolean

  /** Register a majority-change callback.
   *  `true` = entered majority (cluster healthy)
   *  `false` = lost majority (network partition / leader demotion)
   *  The callback fires immediately upon registration with the current state. */
  onMajorityChange(cb: (inMajority: boolean) => void): void
}
```

### 2.3 Path A: Raft-Logic WASM Three-Tier Detection (Production)

When raft-logic WASM bindings are available, three tiers run in parallel for both low latency and robust coverage:

| Tier | Mechanism | Latency | Reliability |
|------|-----------|---------|-------------|
| **1** | `onQuorumActive()` event | Instant | Only fires on re-entry, not exit |
| **2** | `onRoleChange()` event | ~election timeout | Detects leader→follower transitions |
| **3** | Polling `_checkMajority()` every 2000ms | ≤2s | Universal fallback, catches missed events |

All three tiers share the same callback firing logic: they check `prev !== new` before notifying callbacks to avoid spurious notifications.

#### Tier 1: onQuorumActive (Realtime Event)

Registers directly on the raft node. This event fires when a quorum is re-established — useful for fast re-entry detection after a partition heals.

```typescript
// From raft-logic-consensus.ts, inside start() method.
// This live event only fires when quorum transitions from inactive to active.
if (typeof raft.onQuorumActive === 'function') {
  raft.onQuorumActive(() => {
    const prev = this._inMajority
    this._inMajority = true
    if (prev !== true) {
      this.logger.info('[RaftConsensus] Re-entered majority (quorum active)')
      for (const cb of this._majorityCallbacks) {
        try { cb(true) } catch { /* swallow callback errors */ }
      }
    }
  })
}
```

**Caution**: `onQuorumActive` typically only fires when quorum transitions from inactive to active (healing), not when quorum is lost. It is not a complete detection mechanism on its own.

#### Tier 2: onRoleChange (Role-Based)

Detects majority loss/gain through role transitions. A leader demoted to follower has lost quorum. A node that becomes a leader has gained it.

```typescript
if (typeof raft.onRoleChange === 'function') {
  raft.onRoleChange((rc: any) => {
    // Demoted from leader → lost majority
    if (rc.role === 'follower' || rc.role === 'candidate') {
      const prev = this._inMajority
      this._inMajority = false
      if (prev !== false) {
        this.logger.info('[RaftConsensus] Lost majority (role changed)', { role: rc.role })
        for (const cb of this._majorityCallbacks) {
          try { cb(false) } catch {}
        }
      }
    }
    // Became leader → gained majority
    if (rc.role === 'leader') {
      const prev = this._inMajority
      this._inMajority = true
      if (prev !== true) {
        this.logger.info('[RaftConsensus] Entered majority (became leader)')
        for (const cb of this._majorityCallbacks) {
          try { cb(true) } catch {}
        }
      }
    }
  })
}
```

#### Tier 3: Polling Fallback

A safety net set to fire every 2000ms. It checks the raft node's status for a valid leader.

```typescript
// In start():
this._majorityCheckTimer = setInterval(() => {
  this._checkMajority()
}, 2000)
this._majorityCheckTimer.unref()  // Don't keep process alive
```

```typescript
private _checkMajority(): void {
  if (!this._node) return
  const status = this._node.status()
  const leader = status.lead ?? status.leaderId ?? null
  const wasInMajority = this._inMajority
  this._inMajority = leader !== null && leader !== 0
  if (wasInMajority !== this._inMajority) {
    for (const cb of this._majorityCallbacks) {
      try { cb(this._inMajority) } catch {}
    }
  }
}
```

**Why polling is necessary**: Event-based detection may miss transitions if:
- The WASM runtime drops events or the callback field was not bound
- A follower simply loses connectivity without a role change (it remains a follower but no leader is reachable)
- During node startup, events fire before callbacks were registered

#### Callback Storage & Immediate Fire

```typescript
private _inMajority = true       // Default: assume we're in majority
private _majorityCallbacks: Array<(inMajority: boolean) => void> = []

onMajorityChange(cb: (inMajority: boolean) => void): void {
  this._majorityCallbacks.push(cb)
  cb(this._inMajority)  // Fire immediately with current state
}
```

**Why the immediate callback matters**: When `MultiLeaderReplication.setConsensus()` wires up the majority change, it must immediately set the correct frozen state. Without the immediate callback, there would be a window between registration and the next event where the outbox might be in the wrong state.

### 2.4 Path B: Application-Layer Heartbeat Manager (Recommended)

For teams that cannot or prefer not to rely on raft-logic's internal events, `AppHeartbeatManager` provides equivalent partition detection at the application layer via **EventBus heartbeat ping + Outbox failure cross-check**.

#### Architecture

```
┌─────────────────────────────────────────────────┐
│              AppHeartbeatManager                │
│                                                 │
│  每个 tick（默认 1s）：                          │
│  ┌─────────────────────────────────────┐        │
│  │ sendPings() → 给所有 peer 发 ping   │        │
│  └──────────┬──────────────────────────┘        │
│             ▼                                   │
│  Step 1: 更新 missedPings 计数                  │
│  ┌─────────────────────────────────────┐        │
│  │ 连续 N 次 tick 无 heartbeat →       │        │
│  │ peer.suspect = true (默认 N=3)      │        │
│  └──────────┬──────────────────────────┘        │
│             ▼                                   │
│  Step 2: 计算 majority                          │
│  ┌─────────────────────────────────────┐        │
│  │ suspect + outboxConfirmedFailing →   │        │
│  │ 计入 confirmedFailed                │        │
│  │ healthy = total - confirmedFailed   │        │
│  │ healthy >= quorum → inMajority      │        │
│  └──────────┬──────────────────────────┘        │
│             ▼                                   │
│  Step 3: onMajorityChange 回调                   │
│  ┌─────────────────────────────────────┐        │
│  │ only fires on actual state change   │        │
│  │ (prev !== new)                      │        │
│  └─────────────────────────────────────┘        │
└─────────────────────────────────────────────────┘
```

#### Complete Implementation

##### AppHeartbeatManager Interface

```typescript
export interface HeartbeatConfig {
  /** 当前节点 ID */
  nodeId: string
  /** peer 列表 */
  peers: Array<{ nodeId: string; addr: string }>
  /** 发送心跳的间隔（ms），默认 1000 */
  pingIntervalMs?: number
  /** 丢失几次心跳判定为 suspect，默认 3 */
  suspectThreshold?: number
  /** 分区确认后，连续成功几次心跳后恢复 healthy，默认 3 */
  recoveryThreshold?: number
  /** 传输层接口 */
  transport: HeartbeatTransport
  /** majority 状态变化回调 */
  onMajorityChange: (inMajority: boolean) => void
}

export class AppHeartbeatManager {
  constructor(config: HeartbeatConfig)
  start(): void
  stop(): void
  /** 由传输层回调：收到一个心跳消息 */
  handleHeartbeat(from: string): void
  /** 发送心跳 ping 到所有 peer，可外部直接调用 */
  async sendPings(): Promise<void>
  /** Outbox 报告发送失败：用于二次确认 suspect */
  reportSendFailure(peerId: string, consecutiveFailures: number): void
  /** 获取当前 suspect 状态 */
  getSuspects(): Map<string, boolean>
  /** 当前是否 in majority */
  isMajority(): boolean
  /** 更新 peer 列表（R10 成员变更后调用） */
  updatePeers(peers: Array<{ nodeId: string; addr: string }>): void
  /** 手动触发一次 tick（测试用） */
  async manualTick(): Promise<void>
  /** 获取状态统计 */
  getStats(): { total: number; suspect: number; confirmedFailed: number; inMajority: boolean }
}
```

##### Core Detection Logic

```typescript
// Internal tick: called every pingIntervalMs (default 1s)
private async _tick(): Promise<void> {
  if (!this._running) return

  // Step 1: Send ping to all peers
  await this.sendPings()

  // Step 2: Increment missedPings for all peers
  // When any peer's missedPings >= suspectThreshold, mark suspect
  for (const [peerId, state] of this._peers) {
    state.missedPings++
    if (state.missedPings >= this.config.suspectThreshold! && !state.suspect) {
      state.suspect = true
      state.consecutiveSuccesses = 0
      this.logger.warn(`[Heartbeat] Peer ${peerId} suspect`)
    }
  }

  // Step 3: Recalculate majority and fire callback if changed
  this._recalculateMajority()
}
```

##### Majority Calculation Rules

```typescript
private _computeMajority(): boolean {
  const total = this._peers.size
  if (total === 0) return true     // Single-node

  // confirmedFailed = suspect + outboxConfirmedFailing
  // suspect without outboxConfirm → tentative, does NOT count as failed
  let confirmedFailed = 0
  let suspectCount = 0
  for (const state of this._peers.values()) {
    if (state.suspect && state.outboxConfirmedFailing) {
      confirmedFailed++
    }
    if (state.suspect) {
      suspectCount++
    }
  }

  const healthy = total - confirmedFailed
  const quorum = Math.floor(total / 2) + 1
  return healthy >= quorum
}
```

##### Recovery: handleHeartbeat

When a heartbeat arrives after a peer was suspect:

```typescript
handleHeartbeat(from: string): void {
  const state = this._peers.get(from)
  if (!state) {
    // Unknown peer — may be a dynamically joined member (R10)
    this.logger.debug(`[Heartbeat] Received heartbeat from unknown peer ${from}`)
    return
  }

  state.lastReceived = Date.now()
  state.missedPings = 0

  // Imediately clear suspect (heartbeat = peer is alive)
  if (state.suspect) {
    state.suspect = false
    state.outboxConfirmedFailing = false
    state.consecutiveSuccesses = 0
  }

  // Recalculate majority — suspect removal may change state
  this._recalculateMajority()
}
```

**Design decision**: `handleHeartbeat` immediately clears `suspect` upon receiving any heartbeat. This is the most intuitive behavior: if we can receive heartbeats, the partition has healed. The `recoveryThreshold` config field is retained for API compatibility but is no longer used for suspect clearance.

##### Outbox Failure Cross-Check

```typescript
/**
 * Outbox reports send failure for secondary confirmation.
 * Only when suspect + outboxConfirm → confirmed partition.
 * This prevents false positives during network jitter.
 */
reportSendFailure(peerId: string, consecutiveFailures: number): void {
  const state = this._peers.get(peerId)
  if (!state) return

  if (consecutiveFailures >= this.config.suspectThreshold!) {
    state.outboxConfirmedFailing = true
    this.logger.warn(`[Heartbeat] Outbox confirms peer ${peerId} failing`)

    if (state.suspect) {
      this._recalculateMajority()
    }
  }
}
```

##### Peer List Update (R10 Integration)

When R10 membership change adds/removes peers, the heartbeat manager must stay in sync:

```typescript
updatePeers(peers: Array<{ nodeId: string; addr: string }>): void {
  const newPeers = new Map<string, PeerHeartbeatState>()
  for (const p of peers) {
    if (p.nodeId === this.config.nodeId) continue
    const existing = this._peers.get(p.nodeId)
    // Preserve existing state (suspect status, outbox fails, etc.)
    newPeers.set(p.nodeId, existing ?? {
      lastReceived: Date.now(),
      missedPings: 0,
      suspect: false,
      consecutiveSuccesses: 0,
      outboxConfirmedFailing: false,
    })
  }
  this._peers = newPeers
  this._recalculateMajority()
}
```

#### Detection Scenarios

| Scenario | ticks | suspect | outbox confirm | majority |
|----------|-------|---------|----------------|----------|
| Normal operation | <3 | 0 peers | 0 peers | ✅ true |
| Transient jitter (3 ticks lost) | ≥3 | 1+ peers | 0 peers | ✅ true |
| Net partition — outbox also failing | ≥3 | 1+ peers | ≥1 peers | ❌ false |
| Partition heals — heartbeat received | — | Cleared | Cleared | ✅ true |
| Single node | 0 | 0 | 0 | ✅ true (always) |
| 2 of 5 peers down | ≥3 | 2 suspects | 2 confirmed | ❌ false (need 3/5 healthy) |
| 1 of 5 peers down | ≥3 | 1 suspect | 1 confirmed | ✅ true (healthy=3 ≥ quorum=3) |

### 2.5 Implementation: Outbox Freezing

#### PerPeerWorker Frozen Flag

Each `PerPeerWorker` (one per peer) carries a `_frozen` flag.

```typescript
// PerPeerWorker field
private _frozen = false

setFrozen(frozen: boolean): void {
  if (this._frozen === frozen) return  // idempotent
  this._frozen = frozen
  if (frozen) {
    this.log.info(`[${this.peerId}] Outbox frozen (not in majority), deferring all sends`)
  } else {
    this.log.info(`[${this.peerId}] Outbox unfrozen (back in majority), resuming sends`)
  }
}
```

The critical behavior is in `_tick()`:

```typescript
private async _tick(): Promise<void> {
  // R9: Partition freeze — skip all outbound sends when not in majority
  if (this._frozen) {
    // Still run ACK timeout cleanup to prevent resource leaks
    if (this.ackTracker.size > 0) {
      const now = Date.now()
      for (const [msgId, sentAt] of this.ackTracker) {
        if (now - sentAt > this._ackTimeoutMs) {
          const loaded = this.outbox.fetchPendingByPeer(this.peerId)
          const found = loaded.find(e => e.msgId === msgId)
          if (found && this.outbox.isAcked(found.seq)) {
            this.log.info(`ack for ${msgId} found via LMDB mmap, clearing tracker`)
            this.ackTracker.delete(msgId)
          }
        }
      }
    }
    return  // <--- EARLY RETURN: no sends happen while frozen
  }

  // ... normal tick logic (fetch pending, send messages, handle backoff) ...
}
```

**Key behavior**: When frozen:
- All outbound sends are skipped (early return)
- ACK timeout cleanup still runs — prevents `ackTracker` map from accumulating stale entries during a long partition
- The tick loop continues to run (setTimeout chain is not paused), so when unfrozen, sending resumes on the next tick with no delay

#### OutboxReplicationManager Frozen Flag

```typescript
// OutboxReplicationManager
private _frozen = false

setFrozen(frozen: boolean): void {
  if (this._frozen === frozen) return
  this._frozen = frozen
  this.log.info(`[Outbox] ${frozen ? 'Frozen' : 'Unfrozen'}: propagating to all workers`)
  for (const worker of this.workerMap.values()) {
    worker.setFrozen(frozen)
  }
}

setMajorityStatus(inMajority: boolean): void {
  this.setFrozen(!inMajority)
}
```

### 2.6 Wiring the Two Paths

```typescript
// ─── Path B: Application-layer heartbeat (Recommended) ───

const heartbeatManager = new AppHeartbeatManager({
  nodeId,
  peers: config.peers,
  transport: eventBus,  // EventBus implements HeartbeatTransport.send()
  pingIntervalMs: 1000,
  suspectThreshold: 3,
  onMajorityChange: (inMajority) => {
    outboxManager.setMajorityStatus(inMajority)
  },
})
heartbeatManager.start()
eventBus.setHeartbeatHandler((from, msg) => heartbeatManager.handleHeartbeat(from))

// ─── Path A: Raft-logic ConsensusProvider (if available) ───
// consensus.onMajorityChange((inMajority) => {
//   outboxManager.setMajorityStatus(inMajority)
// })

// ─── Both paths can run simultaneously ───
// If both fire, the second call to setMajorityStatus(true) is idempotent
```

### 2.7 Standalone Mode

`StandaloneConsensus` provides safe stubs for single-node development:

```typescript
export class StandaloneConsensus implements ConsensusProvider {
  /** Single node is always in majority */
  inMajority(): boolean { return true }

  private _majorityCallbacks: Array<(inMajority: boolean) => void> = []

  /** Single node has no network — callbacks store but never fire */
  onMajorityChange(cb: (inMajority: boolean) => void): void {
    this._majorityCallbacks.push(cb)
  }
}
```

### 2.8 Edge Cases & Failure Modes

| Scenario | Detection | Behavior |
|----------|-----------|----------|
| Leader crash | Tier 2 → Tier 3 | All followers freeze until new leader elected |
| Network partition (minority) | Tier 2 (demoted) or Tier 3 | Minority side freezes |
| Network partition (majority) | Tier 1 when heals | Majority side unaffected |
| Node restart | Tier 3 / AppHB suspect all peers | Frozen until cluster re-joined |
| Brief disconnect (<2s/3 ticks) | May miss detection | Acceptable — false positive frozen briefly better than ghost messages |
| Large cluster partial partition (3 vs 2) | Both sides detect accordingly | Majority survives; minority freezes |
| Jitter causing 3 missed pings | suspect + no outbox confirm | Wait for outbox — false positive avoided |
| Standalone mode | Always true | Never freezes |

---

## 3. R10: Safe Membership Change

### 3.1 Design Principles

1. **Joint Consensus** — Use two-phase membership transitions (`C_old → C_old + C_new → C_new`) as specified in the Raft thesis (§6). This guarantees safety even during membership transitions.
2. **Leader-only proposals** — Only the current leader can propose membership changes. Followers return an error.
3. **Idempotent operations** — Adding an existing peer or removing a non-existent peer must be safe no-ops.
4. **Dynamic transport reconfiguration** — When membership changes, the event bus must dynamically create/close DEALER connections to new/removed peers.

### 3.2 Interface Design

```typescript
export interface ConsensusProvider {
  // ... existing methods, including R9 methods ...

  // ── R10: Membership Change ──

  /** Safely add a new peer via Joint Consensus two-phase transition.
   *  Only the leader can propose membership changes. */
  addPeer(peerId: string): Promise<void>

  /** Safely remove a peer via Joint Consensus two-phase transition. */
  removePeer(peerId: string): Promise<void>

  /** Get the current cluster membership (voters + learners). */
  getClusterMembers(): string[]

  /** Register a callback fired when cluster membership changes. */
  onMembershipChange(cb: (members: string[]) => void): void
}
```

### 3.3 Path A: Application-Layer Membership Manager (Recommended)

`AppMembershipManager` implements safe membership changes via EventBus broadcast with majority confirmation. It works **independently of raft-logic WASM**.

#### Architecture

```
                    AppMembershipManager
                    ─────────────────────

 proposeChange('add', 'node-4')
    │
    ▼
  ┌──────────────────────────────────────────┐
  │  Validation                              │
  │  ────────────                            │
  │  - Not self (add/remove self? → throw)   │
  │  - Already exists? → idempotent no-op    │
  │  - Not exists? → idempotent no-op        │
  │  - Concurrent proposal? → throw          │
  └──────────────────┬───────────────────────┘
                     │
                     ▼
  ┌──────────────────────────────────────────┐
  │ Phase 1: Broadcast Proposal              │
  │ ──────────────────────────               │
  │ { type: 'proposal',                      │
  │   seq: N,                                │
  │   from: 'node-1',                        │
  │   changeType: 'add',                     │
  │   targetPeerId: 'node-4',               │
  │   configHash: 'node-1,node-2,node-3' }  │
  │                                          │
  │ → ALL peers via EventBus broadcast        │
  └──────────────────┬───────────────────────┘
                     │
                     ▼
  ┌──────────────────────────────────────────┐
  │ Phase 2: Collect ACKs                     │
  │ ──────────────────────                   │
  │ 每个 peer 收到 proposal 后回复 ACK:       │
  │ { type: 'ack', seq, from, configHash }   │
  │                                          │
  │ 发起者等待 majority ACK:                  │
  │ quorum = floor(N / 2) + 1                │
  │ self vote + K ACKs >= quorum             │
  │                                          │
  │ timeout (5s) → broadcast abort → reject  │
  └──────────────────┬───────────────────────┘
                     │ (quorum met)
                     ▼
  ┌──────────────────────────────────────────┐
  │ Phase 3: Commit                          │
  │ ──────────────                           │
  │ 1. Apply locally: _applyMembershipChange │
  │ 2. Broadcast commit:                     │
  │    { type: 'commit',                     │
  │      seq, members: [...newMembers] }     │
  │ 3. Each peer applies locally             │
  │ 4. Fire onMembershipChange callbacks     │
  │ 5. resolve() the original Promise        │
  └──────────────────────────────────────────┘
```

#### Complete Implementation

##### Interface

```typescript
export interface MembershipManagerConfig {
  nodeId: string
  transport: MembershipTransport
  onMembershipChange: (members: string[]) => void
  ackTimeoutMs?: number   // default 5000
}

export class AppMembershipManager {
  constructor(config: MembershipManagerConfig)
  start(): void
  stop(): void
  proposeChange(type: 'add' | 'remove', peerId: string): Promise<void>
  handleMessage(from: string, msg: any): void
  getMembers(): string[]
  onMembershipChange(cb: (members: string[]) => void): void
}
```

##### Phase 1: Proposal Broadcast

```typescript
async proposeChange(type: MembershipChangeType, peerId: string): Promise<void> {
  if (!this._running) throw new Error('AppMembershipManager not started')

  // ── Validation ──
  if (type === 'add' && peerId === this.config.nodeId)
    throw new Error('Cannot add self to cluster')
  if (type === 'remove' && peerId === this.config.nodeId)
    throw new Error('Cannot remove self from cluster')
  if (type === 'add' && this._members.includes(peerId))
    return Promise.resolve()   // idempotent
  if (type === 'remove' && !this._members.includes(peerId))
    return Promise.resolve()   // idempotent
  if (this._pending)
    throw new Error(`Concurrent membership change in progress`)

  const seq = this._nextSeq++
  const configHash = this._computeConfigHash()

  return new Promise<void>((resolve, reject) => {
    // ── CRITICAL: Set _pending BEFORE broadcast ──
    // The broadcast may trigger other nodes' ACK replies synchronously.
    // If _pending is not set by then, the ACK handler will skip them.
    this._pending = {
      seq, changeType, targetPeerId: peerId,
      configHash, acks: new Set([this.config.nodeId]), // self vote
      ackTimer: null, startTime: Date.now(), resolve, reject,
    }

    // Set ack timeout (must be after _pending assignment)
    const timer = setTimeout(() => {
      const pending = this._pending
      if (!pending) return
      this._pending = null
      this.config.transport.broadcast({ type: 'abort', seq, ... })
      reject(new Error(`Membership change timeout`))
    }, this.config.ackTimeoutMs!)
    this._pending.ackTimer = timer

    // Broadcast proposal asynchronously
    this.config.transport.broadcast(proposal).then(() => {
      this._checkProposalCompletion(resolve, reject)
    }).catch(reject)
  })
}
```

**Critical Implementation Detail**: `_pending` must be set **before** `broadcast()`. The broadcast is synchronous in test mode — it triggers the other nodes' handlers, which reply with `send(ack)`, which synchronously invokes the proposer's `_handleAck`. If `_pending` is not set, the ACK is silently dropped.

##### Phase 2: ACK Collection

```typescript
// Called when a peer receives the proposal
private _handleProposal(from: string, msg: MembershipMessage): void {
  if (!msg.changeType || !msg.targetPeerId) return

  const localHash = this._computeConfigHash()
  this.config.transport.send(from, {
    type: 'ack',
    seq: msg.seq,
    from: this.config.nodeId,
    configHash: localHash,
  }).catch(() => {})

  this.logger.info(`[Membership] Received proposal seq=${msg.seq}, sent ACK`)
}

/** Proposer handles ACK from a peer */
private _handleAck(from: string, msg: MembershipMessage): void {
  if (!this._pending || this._pending.seq !== msg.seq) {
    // Old seq ACK or proposal already completed — drop silently
    return
  }

  // Config hash mismatch is logged but does NOT reject the ACK.
  // This is intentional: during fast sequential changes, the
  // proposer's configHash may differ from followers by one version.
  if (msg.configHash && msg.configHash !== this._pending.configHash) {
    this.logger.debug(`[Membership] ACK from ${from} configHash mismatch`)
  }

  this._pending.acks.add(from)
  this.logger.debug(`[Membership] ACK from ${from} seq=${msg.seq} (${this._pending.acks.size}/${Math.floor(this._members.length / 2) + 1})`)

  // Check quorum — delegate to _checkProposalCompletion
  const pending = this._pending
  const quorum = Math.floor(this._members.length / 2) + 1
  if (pending.acks.size >= quorum) {
    this._checkProposalCompletion(pending.resolve, pending.reject)
  }
}
```

##### Phase 3: Commit Completion

```typescript
private _checkProposalCompletion(
  resolve: (value: void) => void,
  reject: (err: Error) => void
): void {
  if (!this._pending) return
  const pending = this._pending
  const quorum = Math.floor(this._members.length / 2) + 1

  if (pending.acks.size >= quorum) {
    // Guard: prevent double-commit from duplicate ACK arrivals
    if (pending.ackTimer === null) return  // Already committed

    if (pending.ackTimer) {
      clearTimeout(pending.ackTimer)
      pending.ackTimer = null  // Flag: commit has started
    }

    this._commitChange(pending, resolve, reject)
  }
}

private _commitChange(
  pending: PendingProposal,
  resolve: (value: void) => void,
  reject: (err: Error) => void
): void {
  // Compute new member list
  let newMembers: string[]
  if (pending.changeType === 'add') {
    newMembers = [...this._members, pending.targetPeerId]
  } else {
    newMembers = this._members.filter(m => m !== pending.targetPeerId)
  }

  // Apply locally FIRST, then broadcast commit
  // This ensures the proposer's state is updated even if broadcast fails
  this._applyMembershipChange(newMembers)

  // Broadcast commit to all peers
  const commitMsg: MembershipMessage = {
    type: 'commit',
    seq: pending.seq,
    from: this.config.nodeId,
    members: newMembers,
  }

  this.config.transport.broadcast(commitMsg).then(() => {
    this._pending = null
    resolve()
  }).catch((err: Error) => {
    this._pending = null
    this.logger.error(`[Membership] Commit broadcast failed, local apply succeeded`)
    resolve()  // Local already applied; resolve anyway
  })
}

private _applyMembershipChange(newMembers: string[]): void {
  this._members = [...newMembers].sort()

  // Fire registered callbacks
  for (const cb of this._membershipCallbacks) {
    try { cb(this._members) } catch {}
  }
  try { this.config.onMembershipChange(this._members) } catch {}
}
```

##### Handling Commit/Abort on Non-Proposer Nodes

```typescript
private _handleCommit(msg: MembershipMessage): void {
  if (!msg.members || msg.members.length === 0) return

  // Idempotent: skip if already applied
  const sorted = [...msg.members].sort()
  if (this._members.length === sorted.length &&
      this._members.every((m, i) => m === sorted[i])) {
    return  // Already applied
  }

  this._applyMembershipChange(sorted)
}

private _handleAbort(msg: MembershipMessage): void {
  if (this._pending && this._pending.seq === msg.seq) {
    if (this._pending.ackTimer) clearTimeout(this._pending.ackTimer)
    this._pending = null
    this.logger.warn(`[Membership] Abort seq=${msg.seq}: ${msg.reason || 'No reason'}`)
  }
}
```

#### Message Dedup

Messages are deduped by `type:from:seq` key to handle three scenarios that otherwise cause failures:

```typescript
handleMessage(from: string, msg: any): void {
  const mm = msg as MembershipMessage

  // CRITICAL: dedup key includes type prefix + sender
  // - "proposal:node-1:0" is different from "commit:node-1:0"
  // - "ack:node-2:1" is different from "ack:node-3:1"
  const dedupKey = mm.type === 'proposal' || mm.type === 'commit' || mm.type === 'abort'
    ? `${mm.type}:${mm.from}:${mm.seq}`
    : `${mm.type}:${from}:${mm.seq}`
  if (this._seenSeqs.has(dedupKey)) return
  this._seenSeqs.add(dedupKey)

  // Limit set size
  if (this._seenSeqs.size > 1000) {
    const first = this._seenSeqs.values().next().value
    if (first !== undefined) this._seenSeqs.delete(first)
  }
  // ... dispatch to handler ...
}
```

**Historical Bug**: The original dedup key was just `mm.seq` (a plain number). This caused:
- `proposal:0` blocked `commit:0` (same seq = treated as duplicate → commit never applied)
- `ack:node-2:0` blocked `ack:node-3:0` (second ACK never received → quorum never met → timeout)

### 3.4 Path B: WASM ConfChangeV2 (when bindings mature)

When `raft-logic` exposes the ConfChangeV2 API, the standard raft-rs Joint Consensus lifecycle is:

```
Timeline:
  1. Leader proposes addPeer("node-D")    → Entry written: C_old → C_old + C_new
  2. Entry committed on majority of BOTH   → Cluster enters joint state
  3. Leader auto-proposes C_old + C_new → C_new
  4. Entry committed on majority of C_new  → Cluster in new config
  5. Finalized. Nodes not in C_new removed.
```

```typescript
async addPeer(peerId: string): Promise<void> {
  const raft = this._node
  const { ConfChangeV2, ConfChangeSingle, ConfChangeTransition, ConfChangeType } = this._raftModule

  const cc = new ConfChangeV2()
  cc.transition = ConfChangeTransition.Explicit  // Joint Consensus: C_old → C_old + C_new → C_new
  const change = new ConfChangeSingle()
  change.change_type = ConfChangeType.AddNode
  change.node_id = Number(peerId)
  cc.changes = [change]

  await raft.proposeConfChange(cc)
}
```

ConfChangeV2 entries appear in the `apply()` callback as `EntryConfChangeV2`:

```typescript
apply: async (entry: any) => {
  if (entry.entry_type === EntryType.EntryConfChangeV2) {
    const cc = ConfChangeV2.unmarshal(entry.data)
    this._node.applyConfChange(cc)
    const members = this.getClusterMembers()  // Now reads from confState()
    for (const cb of this._membershipCallbacks) {
      try { cb(members) } catch {}
    }
    return  // Don't pass to state machine
  }
  // Normal entry — apply to state machine
  if (this.applyFn) await this.applyFn(Buffer.from(entry.data))
}
```

### 3.5 Integration: EventBus Dynamic Connection Management

When R10 membership changes, the EventBus must dynamically adjust its DEALER sockets:

```typescript
class ZmqEventBus {
  private dealers = new Map<string, zmq.Dealer>()

  /** Called when cluster membership changes */
  onMembershipChange(members: string[]): void {
    const memberSet = new Set(members)

    // Close DEALERs for peers no longer in the cluster
    for (const [peerId, dealer] of this.dealers) {
      if (!memberSet.has(peerId)) {
        this.log.info(`[EventBus] Closing DEALER for removed peer ${peerId}`)
        dealer.close()
        this.dealers.delete(peerId)
      }
    }

    // Create DEALERs for new peers
    for (const peerId of members) {
      if (peerId === this.nodeId) continue
      if (this.dealers.has(peerId)) continue
      const addr = this.lookupPeerAddress(peerId)
      if (!addr) { this.log.warn(`No address for peer ${peerId}`); continue }
      const dealer = new zmq.Dealer()
      dealer.connect(addr)
      this.dealers.set(peerId, dealer)
    }
  }
}
```

Also, the `AppHeartbeatManager` must be updated:

```typescript
// In MultiLeaderReplication or application bootstrap:
membershipManager.onMembershipChange((members) => {
  eventBus.onMembershipChange(members)
  heartbeatManager.updatePeers(
    members.filter(m => m !== nodeId).map(m => ({ nodeId: m, addr: lookup(m) }))
  )
})
```

### 3.6 Safety Guarantees

| Property | How Path A (AppLayer) Ensures | How Path B (WASM) Ensures |
|----------|-------------------------------|---------------------------|
| No split-brain | Majority must ACK before commit | Joint Consensus: requires majority of BOTH C_old and C_old+C_new |
| Idempotent add/remove | Pre-validation: check _members before propose | ConfChangeV2 with same peer/node = no-op in raft log |
| Concurrent proposals | Single pending slot throws error | Raft log serializes all proposals |
| Crash during change | Timeout → abort broadcast | New leader picks up from joint state |
| All nodes converge | Same commit message applied everywhere | Same raft log entry applied everywhere |

### 3.7 Edge Cases & Failure Modes

| Scenario | Resolution |
|----------|-----------|
| **Concurrent changes from different nodes** | Only one can succeed; seq-based lock rejects second |
| **Proposer crashes before commit** | Other nodes time out on ACK; no commit applied |
| **ACK lost due to partition** | ACK not counted → quorum not met → timeout → abort |
| **Commit broadcast lost** | Proposer's local apply succeeds; other nodes don't see change until next proposal |
| **Adding a previously removed peer** | Works identically to adding a new peer |
| **Removing the current proposer** | Validate: "Cannot remove self" → throw. Must propose from another node |

---

## 4. Integration Checklist

### Per-Component Changes

| File / Component | R9 Change | R10 Change |
|---|---|---|
| `consensus-provider.ts` | `+inMajority()`, `+onMajorityChange(cb)` | `+addPeer()`, `+removePeer()`, `+getClusterMembers()`, `+onMembershipChange(cb)` |
| `raft-logic-consensus.ts` | Three-tier detection: `onQuorumActive` + `onRoleChange` + polling | Full `ConfChangeV2` lifecycle (when WASM API is available) |
| **AppHeartbeatManager** (new) | Application-layer heartbeat partition detection (recommended) | — |
| **AppMembershipManager** (new) | — | Application-layer two-phase commit membership (recommended) |
| `standalone-consensus.ts` | `inMajority()` → `true`; `onMajorityChange()` stores but never fires | `addPeer()`/`removePeer()` no-ops; `getClusterMembers()` returns `[nodeId]` |
| `outbox-replication.ts` | `_frozen` flag, `setFrozen()`, `setMajorityStatus()` | — (no changes) |
| `PerPeerWorker` | `_frozen` flag, early return in `_tick()`, ACK cleanup | — (no changes) |
| `MultiLeaderReplication` | Wire `onMajorityChange()` → `manager.setMajorityStatus()` | Wire `onMembershipChange()` → EventBus dynamic | + HeartbeatManager peer update |
| EventBus (ZMQ) | — (no changes) | Dynamic DEALER connect/disconnect |

### Line Count

| Component | Lines |
|-----------|-------|
| `AppHeartbeatManager` (core) | ~260 |
| AppHeartbeatManager unit tests | ~350 |
| Heartbeat partition integration tests | ~150 |
| `AppMembershipManager` (core) | ~470 |
| AppMembershipManager integration tests | ~210 |
| **Total core logic (new files)** | ~730 |
| **Total tests** | ~710 |

---

## 5. Testing Strategy

### 5.1 AppHeartbeatManager Unit Tests

Location: `src/consensus/app-heartbeat-manager.spec.ts`
**27 tests total** — 0 failed, 0 timeout ✅

Key approach: No fake timers. Test drives the heartbeat manager via `manualTick()` — a public method that calls `_tick()` synchronously.

| Test Group | Count | Key Tests |
|------------|-------|-----------|
| start/stop lifecycle | 4 | Idempotent start, clean stop timer cleanup, no pings after stop |
| Single-node cluster | 2 | Always majority, zero peers in stats |
| Ping sending | 3 | Sends to all peers, correct message format, seq increments |
| Heartbeat received | 2 | Clears suspect on heartbeat, handles unknown peer gracefully |
| Suspect on missed pings | 1 | Mark suspect after threshold ticks |
| Majority change | 4 | Fire false on suspect+outbox, don't fire without outbox confirm, recovery true, require suspect+outbox |
| updatePeers | 4 | Track new peers, preserve existing state, remove peers, recalculate |
| getStats | 5 | All healthy, suspect count, confirmed count, recovery counts |
| Edge cases | 3 | Non-existent peer report, below threshold, not started |

### 5.2 Heartbeat Partition Integration Tests

Location: `test/integration/heartbeat-partition.test.ts`
**7 tests total** — all passing ✅

| Test Group | Count | Description |
|------------|-------|-------------|
| Partition detection | 1 | Suspect + outbox confirm → lost majority |
| Partition recovery | 2 | Heartbeat clears suspect, suspect without outbox is not partition |
| Majority calculation | 4 | 2/5 down, 3/5 down, only some confirmed, single node |

### 5.3 AppMembershipManager Integration Tests

Location: `test/integration/membership-app.test.ts`
**9 tests total** — all passing ✅

| Test | Description | Key Assertion |
|------|-------------|---------------|
| adds peer-4 | Add to 3-node cluster | All 3 nodes see 4 members |
| removes node-2 | Remove from 3-node cluster | Remaining nodes don't contain node-2 |
| add peer is idempotent | Add existing peer | Resolves to undefined, no change |
| rejects concurrent proposals | Simultaneous adds | Second throws Concurrent, first completes |
| validates cannot add self | Add own nodeId | Throws "Cannot add self" |
| validates cannot remove self | Remove own nodeId | Throws "Cannot remove self" |
| rejects proposal when not started | Propose before start | Throws "not started" |
| add → add → remove sequence | Sequential operations | Correct final state |
| remove non-existent peer is no-op | Remove unknown peer | Members unchanged |

### 5.4 Full Integration Suite

All R9/R10 tests plus existing consensus/integration/fault-injection tests:
**197 passed, 5 skipped, 0 failed ✅** (vitest.int.config.ts, 27 files)

---

## 6. Known Pitfalls & Bug Fix History

The following bugs were discovered and fixed during integration testing. Document them here so future implementors don't repeat them.

### Bug 1: `_seenSeqs` Blocks Commit Messages (seq collision)

**Symptoms**: After Phase 2 ACK quorum is met, Phase 3 commit is broadcast but non-proposer nodes never apply the commit. The commit message exits silently.

**Root Cause**: `_seenSeqs` used a plain `mm.seq` number as dedup key. A `proposal:seq=0` and `commit:seq=0` shared the same key. When the commit arrived at a non-proposer node, `_seenSeqs.has(0)` returned `true` (because the earlier `proposal:0` had been added), and the commit was silently dropped.

**Fix**: Changed dedup key to include type prefix: `${mm.type}:${mm.from}:${mm.seq}`.

**Before (broken)**:
```typescript
if (this._seenSeqs.has(mm.seq)) return
this._seenSeqs.add(mm.seq)
// proposal:0 blocks commit:0
```

**After (fixed)**:
```typescript
const dedupKey = `${mm.type}:${mm.from}:${mm.seq}`
if (this._seenSeqs.has(dedupKey)) return
this._seenSeqs.add(dedupKey)
// "proposal:node-1:0" does not block "commit:node-1:0"
```

### Bug 2: `_seenSeqs` Blocks Second ACK (same seq, different source)

**Symptoms**: In a 3-node cluster, the proposer receives ACK from node-2 but never from node-3. Quorum never meets the threshold (need 2 of 3, stuck at 1).

**Root Cause**: ACKs from different sources share the same seq but are distinct messages. The plain-seq dedup key means `ack:node-2:0` blocked `ack:node-3:0` (both with key `0`).

**Fix**: ACK messages use a different dedup key that includes the source nodeId:

```typescript
const dedupKey = mm.type === 'proposal' || mm.type === 'commit' || mm.type === 'abort'
  ? `${mm.type}:${mm.from}:${mm.seq}`
  : `${mm.type}:${from}:${mm.seq}`   // "ack:node-2:0" vs "ack:node-3:0"
```

### Bug 3: Concurrent Proposal Bypass

**Symptoms**: `proposeChange('add', 'node-4')` and `proposeChange('add', 'node-5')` both succeed — the second call bypasses the "Concurrent membership change" guard.

**Root Cause**: `this._pending = null` was set inside `_checkProposalCompletion()` synchronously, **before** the `.then()` microtask that calls `resolve()`. The second `proposeChange()` call's `if (this._pending)` check in the next synchronous turn found `_pending === null` and started a new proposal, while the first proposal's Promise had not yet resolved.

```
Timeline (broken):
  _checkProposalCompletion()
    └→ this._pending = null          ← too early!
    └→ _commitChange()
         └→ broadcast(commit).then(() => resolve())
                                    ↑ microtask
                                    ↑ _pending is already null here
                                    ↑ second proposeChange can enter
```

**Fix**: Move `this._pending = null` into the `.then()` callback alongside `resolve()`:

```typescript
this.config.transport.broadcast(commitMsg).then(() => {
  this._pending = null   // Now alongside resolve
  resolve()
})
```

### Bug 4: Double Commit (duplicate ACK trigger)

**Symptoms**: Dozens of duplicate `_applyMembershipChange` calls. The commit is broadcast multiple times.

**Root Cause**: When the ACK collection path was called from `_handleAck` synchronously, and two ACKs arrived sequentially (e.g., node-2 and node-3), the second `_handleAck` call also met the quorum condition and called `_checkProposalCompletion` → `_commitChange` a second time. The `ackTimer` had been `clearTimeout`'d but not set to `null`.

**Fix**: Add a guard using `ackTimer === null` as a "commit started" flag:

```typescript
if (pending.acks.size >= quorum) {
  if (pending.ackTimer === null) return  // Already started commit
  if (pending.ackTimer) {
    clearTimeout(pending.ackTimer)
    pending.ackTimer = null   // Flag: commit started
  }
  this._commitChange(pending, resolve, reject)
}
```

### Bug 5: `resolve` is not defined

**Symptoms**: Error "resolve is not defined" in production code at runtime. All integration tests fail with this error.

**Root Cause**: The original code called `broadcast(proposal)` with `await` before creating the `return new Promise((resolve, reject) => ...)`. The `_handleAck` callback tried to use `resolve` from a not-yet-defined scope.

**Fix**: Move the `_pending` setup (which stores `resolve`/`reject`) **before** the broadcast call, inside the Promise constructor:

```typescript
return new Promise<void>((resolve, reject) => {
  this._pending = { resolve, reject, ... }   // Set BEFORE broadcast
  this.config.transport.broadcast(proposal).then(() => {
    this._checkProposalCompletion(resolve, reject)
  })
})
```

### Design Lessons Summary

| Lesson | Why It Matters |
|--------|---------------|
| **Set state before async operations** | Broadcast is synchronous in tests → handlers fire in same turn |
| **Clear state only alongside resolve** | Otherwise concurrent guard is defeated |
| **Dedup keys must include type + source** | Plain numbers collide between message types and sources |
| **Guard against repeat callback invocations** | Synchronous delivery can invoke the same handler twice |
| **`ackTimer` null is a better guard than a separate boolean** | Reuse existing field as state flag |
| `_applyMembershipChange` before `broadcast(commit)` | Proposer always has the latest state, even if commit broadcast fails |

---

## 7. Appendix: Complete Source Code References

### Primary Implementation Files

| File | Key Lines | Content |
|------|-----------|---------|
| `src/consensus/consensus-provider.ts` | 1-115 | Full interface: all R9/R10 method signatures with JSDoc |
| `src/consensus/raft-logic-consensus.ts` | 18-39 | Class fields: `_inMajority`, `_majorityCallbacks`, `_majorityCheckTimer` |
| `src/consensus/raft-logic-consensus.ts` | 153-270 | `start()`: onQuorumActive hook (L206-219), onRoleChange hook (L221-252), polling fallback (L254-262) |
| `src/consensus/raft-logic-consensus.ts` | 422-456 | `inMajority()`, `onMajorityChange()`, `_checkMajority()` |
| `src/consensus/raft-logic-consensus.ts` | 458-525 | `addPeer()`, `removePeer()`, `getClusterMembers()`, `onMembershipChange()` |
| `src/consensus/standalone-consensus.ts` | 56-100 | Standalone stubs for all R9/R10 methods |
| `src/consensus/app-heartbeat-manager.ts` | 1-430 | Full AppHeartbeatManager implementation |
| `src/consensus/app-membership-manager.ts` | 1-420 | Full AppMembershipManager implementation |
| `src/core/outbox-replication.ts` | 737-845 | PerPeerWorker: `_frozen` field, `setFrozen()`, `_tick()` early return |
| `src/core/outbox-replication.ts` | 1082-1511 | OutboxReplicationManager: `_frozen`, `setFrozen()`, `setMajorityStatus()` |
| `src/core/multi-leader-replication.ts` | 165-185 | `MultiLeaderReplication.setConsensus()` wiring |

### Test Files

| File | Tests | Suites |
|------|-------|--------|
| `src/consensus/app-heartbeat-manager.spec.ts` | 27 | AppHeartbeatManager unit tests |
| `test/integration/heartbeat-partition.test.ts` | 7 | AC-IT-R9 partition handling |
| `test/integration/membership-app.test.ts` | 9 | AC-IT-R10 membership change |
| `test/integration/partition-handling.test.ts` | 3 | Existing R9 integration tests |
| `test/fault-injection/partition-outbox.test.ts` | 1 | Existing FI-R9 freeze/heal lifecycle |
| Full integration suite | 197 | 27 files, 0 failed |

### Naming Conventions

| Prefix | Suite | Scope |
|--------|-------|-------|
| `AC-IT-R9` | Integration Test | R9 partition handling |
| `AC-IT-R10` | Integration Test | R10 membership change |
| `AC-FI-R9` | Fault Injection Test | R9 partition + outbox freeze |
