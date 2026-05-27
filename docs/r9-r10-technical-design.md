# R9/R10: Network Partition Handling & Membership Change

## Technical Design & Implementation Guide

> **Generic architecture**: raft-logic (tikv/raft-rs WASM) + ZMQ EventBus + Outbox delivery
> **Database engine**: swappable (the state machine being replicated is a detail)
> **Source reference**: `agentiX-graphvec` implementation at `/src/consensus/`, `/src/core/outbox-replication.ts`, `/src/core/multi-leader-replication.ts`
> **Tests**: 7 test files, 95+ tests across unit, integration, and fault-injection suites

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [R9: Network Partition (Split-Brain) Handling](#2-r9-network-partition-split-brain-handling)
3. [R10: Safe Membership Change](#3-r10-safe-membership-change)
4. [Integration Checklist](#4-integration-checklist)
5. [Testing Strategy](#5-testing-strategy)
6. [Migration Guide](#6-migration-guide)
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
│  - (Future) Walks ConsensusProvider.onMembershipChange → EventBus   │
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

### Key Design Principle: ConsensusProvider as a Seam

The `ConsensusProvider` interface is the critical abstraction seam. It decouples the raft engine from the replication machinery, making it possible to:

- Swap between `raft-logic` (WASM production), `simulated-raft` (in-memory test), and `standalone` (single-node dev)
- Add partition handling (R9) and membership change (R10) without changing the outbox layer's internals
- Test each component independently with mock consensus providers

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

### 2.3 Implementation: Majority Detection (Three-Tier)

Majority detection uses three tiers in parallel to achieve both low-latency and robust coverage:

| Tier | Mechanism | Latency | Reliability |
|------|-----------|---------|-------------|
| **1** | `onQuorumActive()` event | Instant | Only fires on re-entry, not exit |
| **2** | `onRoleChange()` event | ~election timeout | Detects leader→follower transitions |
| **3** | Polling `_checkMajority()` every 2000ms | ≤2s | Universal fallback, catches missed events |

All three tiers share the same callback firing logic: they check `prev !== new` before notifying callbacks to avoid spurious notifications.

#### Tier 1: onQuorumActive (Realtime Event)

Registers directly on the raft node. This event fires when a quorum is re-established — useful for fast re-entry detection after a partition heals.

```typescript
// From raft-logic-consensus.ts, inside start() method
// Tier 1: onQuorumActive — real-time quorum re-entry detection
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
// From raft-logic-consensus.ts, inside start() method
// Tier 2: onRoleChange — role-based majority detection
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

A safety net set to fire every 2000ms. It checks the raft node's status for a valid leader. This catches scenarios where the event-based tiers might miss transitions (e.g., a node that was never leader suddenly loses quorum).

```typescript
// From raft-logic-consensus.ts, inside start() method
// Tier 3: Polling fallback — 2000ms interval
this._majorityCheckTimer = setInterval(() => {
  this._checkMajority()
}, 2000)
this._majorityCheckTimer.unref()  // Don't keep process alive
```

```typescript
// _checkMajority() implementation
private _checkMajority(): void {
  if (!this._node) return
  const status = this._node.status()
  const leader = status.lead ?? status.leaderId ?? null
  const wasInMajority = this._inMajority

  // Strategy: if leader is null or 0, we've lost majority
  // In raft-rs WASM: status().lead returns 0 when no leader is known
  this._inMajority = leader !== null && leader !== 0

  if (wasInMajority !== this._inMajority) {
    this.logger.info('[RaftConsensus] Majority status changed', {
      from: wasInMajority,
      to: this._inMajority,
      leaderId: leader,
      term: status.term,
    })
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

#### Callback Storage

```typescript
// Class-level fields
private _inMajority = true       // Default: assume we're in majority
private _majorityCallbacks: Array<(inMajority: boolean) => void> = []
```

```typescript
// onMajorityChange implementation — note the IMMEDIATE callback
onMajorityChange(cb: (inMajority: boolean) => void): void {
  this._majorityCallbacks.push(cb)
  // Fire immediately with current state — critical for wiring safety
  cb(this._inMajority)
}
```

**Why the immediate callback matters**: When `MultiLeaderReplication.setConsensus()` wires up the majority change, it must immediately set the correct frozen state. Without the immediate callback, there would be a window between registration and the next event where the outbox might be in the wrong state.

### 2.4 Implementation: Outbox Freezing

#### PerPeerWorker Frozen Flag

Each `PerPeerWorker` (one per peer) carries a `_frozen` flag.

```typescript
// PerPeerWorker field
private _frozen = false
```

```typescript
// PerPeerWorker.setFrozen()
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
- ACK timeout cleanup still runs — this prevents the `ackTracker` map from accumulating stale entries during a long partition
- The tick loop continues to run (setTimeout chain is not paused), so when unfrozen, sending resumes on the next tick with no delay

#### OutboxReplicationManager Frozen Flag

The `OutboxReplicationManager` also carries a `_frozen` flag and propagates to all workers:

```typescript
// OutboxReplicationManager field
private _frozen = false
```

```typescript
// OutboxReplicationManager.setFrozen()
setFrozen(frozen: boolean): void {
  if (this._frozen === frozen) return  // idempotent
  this._frozen = frozen
  if (frozen) {
    this.log.warn('[Outbox] Frozen: not in majority, pausing all outbox sends')
  } else {
    this.log.info('[Outbox] Unfrozen: back in majority, resuming all outbox sends')
  }
  for (const worker of this.workerMap.values()) {
    worker.setFrozen(frozen)
  }
}
```

The public API for external callers (like `MultiLeaderReplication`) is `setMajorityStatus()`:

```typescript
/**
 * R9: Set majority status, synchronously reflected as outbox frozen/unfrozen.
 *
 * @param inMajority - true = in majority → unfrozen (normal sends)
 *                     false = not in majority → frozen (pause sends, prevent ghost messages)
 */
setMajorityStatus(inMajority: boolean): void {
  this.setFrozen(!inMajority)
}
```

**Why two methods?** `setMajorityStatus()` is the semantically meaningful public API that expresses **why** we're freezing. `setFrozen()` is the lower-level mechanism. This separation makes the code intent-clear: external callers say "we're not in majority" rather than "please freeze."

### 2.5 Wiring Example

The `MultiLeaderReplication` orchestrator wires consensus to the outbox in a single method:

```typescript
// From multi-leader-replication.ts
/**
 * Bind a ConsensusProvider to automatically freeze/unfreeze the outbox
 * based on majority status.
 *
 * When the node loses majority (network partition), outbound sends are
 * automatically frozen. When majority is regained, sends resume.
 *
 * This is OPTIONAL — the system works without it (no partition protection).
 */
setConsensus(consensus: ConsensusProvider): void {
  consensus.onMajorityChange((inMajority) => {
    this.manager.setMajorityStatus(inMajority)
  })
}
```

The `onMajorityChange` callback fires immediately upon registration (see §2.3), so the outbox state is synchronized instantly — there is no race between wiring and the first event.

**Integration with application startup**:

```typescript
// Application bootstrap (simplified)
const consensus = new RaftLogicConsensus(config)
await consensus.init()
await consensus.start()

const replication = new MultiLeaderReplication(config)
replication.start()

// Wire them together — one line is all it takes
replication.setConsensus(consensus)
```

### 2.6 Standalone Mode

`StandaloneConsensus` provides safe stubs for single-node development:

```typescript
export class StandaloneConsensus implements ConsensusProvider {
  // ... other methods ...

  /** Single node is always in majority */
  inMajority(): boolean {
    return true
  }

  private _majorityCallbacks: Array<(inMajority: boolean) => void> = []

  /** Single node has no network — callbacks are stored but never fired */
  onMajorityChange(cb: (inMajority: boolean) => void): void {
    this._majorityCallbacks.push(cb)
  }
}
```

### 2.7 Edge Cases & Failure Modes

#### False Positives During Leader Election

During leader election, there may be a brief period where no leader exists. The 2000ms polling check sees `status().lead === 0` and declares the node out of majority.

- **Impact**: The outbox briefly freezes (~2s), then unfreezes when a new leader is elected.
- **Mitigation**: This is acceptable — a brief freeze is safer than sending during an unstable period. The `onRoleChange` tier typically fires faster than the polling tier, reducing the window.

#### Brief Majority Loss on Leader Transition

When the leader steps down and a new leader is elected, followers briefly see no quorum. The `onRoleChange` tier fires immediately when the old leader becomes a follower.

- **Impact**: Outbox freezes for the duration of the election (typically 200-500ms in a healthy cluster).
- **Mitigation**: Pre-vote (`preVote: true` in config) reduces unnecessary elections during transient partitions.

#### Node Restart After Crash

On restart, the raft node starts without a leader. `inMajority()` returns `false` until the node re-joins the cluster and learns the leader.

- **Impact**: Outbox is frozen during recovery. No messages are sent until the node catches up.
- **Mitigation**: This is correct behavior — the node should not send messages until it has caught up with committed entries.

```typescript
// In start(): _inMajority is initialized to true but the polling tier
// will correct it to false within 2000ms if no leader exists
private _inMajority = true
```

**Design note**: The initial `_inMajority = true` is deliberately optimistic. During the brief window between `onMajorityChange` registration and the first raft event, assuming majority prevents spurious freezing on startup. The immediate callback in `onMajorityChange()` + polling tier corrects the state within one tick.

#### Large Cluster Partial Partition

In a 5-node cluster, partitioning 3 vs 2: the side with 3 nodes maintains quorum, the side with 2 loses it.

- **Behavior**: The 2-node minority correctly detects loss of majority. Their outboxes freeze.
- **The 3-node majority**: Remains in majority. Their outboxes operate normally.
- **Recovery**: When the partition heals, `onQuorumActive` fires on the minority nodes, unfreezing their outboxes.

#### Interaction with Outbox Retries (R5)

The outbox's retry mechanism (with exponential backoff) continues to function during freeze:

- **Queue persists**: Messages are not dropped when frozen stays. They remain in the LMDB-backed queue.
- **Backoff state preserved**: The `inBackoff`, `lastSendMs`, and `lastError` state of each `PerPeerWorker` is preserved across freeze/unfreeze cycles.
- **No message loss**: A freeze does not clear queues or ACK trackers.
- **No message duplication**: The ACK tracker continues to be checked during freeze (see §2.4), so messages that were sent just before the freeze and whose ACKs arrive during the freeze are properly cleaned up.

#### Edge Case Summary

| Scenario | Detection Tier | Behavior |
|----------|---------------|----------|
| Leader crash | Tier 2 → Tier 3 | All followers freeze until new leader elected |
| Network partition (minority) | Tier 2 (demoted leader) or Tier 3 | Minority side freezes |
| Network partition (majority) | Tier 1 when heals | Majority side unaffected |
| Node restart | Tier 3 | Frozen until cluster re-joined |
| Brief disconnect (<2s) | Tier 3 may miss it | Depends on timing of polling check |
| onRoleChange missed by WASM | Tier 3 catches it | ≤2s delay for detection |

---

## 3. R10: Safe Membership Change

### 3.1 Design Principles

1. **Joint Consensus** — Use two-phase membership transitions (`C_old → C_old + C_new → C_new`) as specified in the Raft thesis (§6). This guarantees safety even during membership transitions.
2. **Leader-only proposals** — Only the current leader can propose membership changes. Followers return an error.
3. **Idempotent operations** — Adding an existing peer or removing a non-existent peer must be safe no-ops at the raft level.
4. **Dynamic transport reconfiguration** — When membership changes, the event bus must dynamically create/close DEALER connections to new/removed peers.

### 3.2 Interface Design

```typescript
export interface ConsensusProvider {
  // ... existing methods, including R9 methods ...

  // ── R10: Membership Change ──

  /** Safely add a new peer via Joint Consensus two-phase transition.
   *  Only the leader can propose membership changes. */
  addPeer(peerId: string): Promise<void>

  /** Safely remove a peer via Joint Consensus two-phase transition.
   *  Only the leader can propose membership changes. */
  removePeer(peerId: string): Promise<void>

  /** Get the current cluster membership (voters + learners).
   *  Returns node IDs as strings. */
  getClusterMembers(): string[]

  /** Register a callback fired when cluster membership changes,
   *  after a ConfChangeV2 entry is applied via the apply callback. */
  onMembershipChange(cb: (members: string[]) => void): void
}
```

### 3.3 Current Implementation Status

**raft-logic WASM 0.3.x limitation**: The `raft-logic` npm package (tikv/raft-rs compiled to WASM) does not currently expose the following types/methods on its TypeScript API surface:

| Missing API | Required For |
|-------------|-------------|
| `RaftNode.confState()` | Reading current membership from raft state |
| `ConfChangeV2` class | Proposing Joint Consensus membership changes |
| `ConfChangeSingle` class | Individual add/remove operations within a change |
| `ConfChangeTransition` enum | Transition type (Explicit for Joint Consensus) |
| `ConfChangeType` enum | AddNode, RemoveNode, AddLearnerNode, etc. |
| `EntryType.EntryConfChangeV2` | Detecting conf change entries in the apply callback |
| `RaftNode.proposeConfChange()` | Submitting a conf change proposal |
| `RaftNode.applyConfChange()` | Applying a committed conf change |

Until these bindings are available, the implementation provides:

#### getClusterMembers(): Falls back to config.peers

```typescript
/**
 * Get the current cluster node list.
 *
 * Since raft-logic WASM does not expose confState(), this falls back
 * to config.peers + nodeId.
 *
 * When confState() becomes available, this should read:
 *   return this._node.confState().voters.map(String)
 */
getClusterMembers(): string[] {
  if (!this._node) return this.config.peers

  // Build complete member list from config
  const members = new Set<string>()
  members.add(this.config.nodeId)
  for (const p of this.config.peers) {
    // peers may be "nodeId:host:port" format — extract nodeId
    const idx = p.indexOf(':')
    members.add(idx > 0 ? p.substring(0, idx) : p)
  }
  return Array.from(members)
}
```

#### addPeer / removePeer: Throw with clear error

```typescript
async addPeer(peerId: string): Promise<void> {
  if (!this._node || !this._started) {
    throw new Error('RaftLogicConsensus not started')
  }

  this.logger.warn('[RaftConsensus] addPeer not yet supported in raft-logic WASM', { peerId })
  throw new Error('addPeer not available: raft-logic WASM does not expose ConfChange API')
}

async removePeer(peerId: string): Promise<void> {
  if (!this._node || !this._started) {
    throw new Error('RaftLogicConsensus not started')
  }

  this.logger.warn('[RaftConsensus] removePeer not yet supported in raft-logic WASM', { peerId })
  throw new Error('removePeer not available: raft-logic WASM does not expose ConfChange API')
}
```

#### StandaloneConsensus: Safe no-ops

```typescript
async addPeer(_peerId: string): Promise<void> {
  // standalone mode has no other nodes — no-op
}

async removePeer(_peerId: string): Promise<void> {
  // standalone mode has no other nodes — no-op
}

getClusterMembers(): string[] {
  return [this.config.nodeId]
}

private _membershipCallbacks: Array<(members: string[]) => void> = []

onMembershipChange(cb: (members: string[]) => void): void {
  this._membershipCallbacks.push(cb)
  // Standalone has no membership changes — callbacks are stored but never fire
}
```

### 3.4 Full Implementation Guide (When WASM Bindings Are Available)

This section describes the complete implementation that should be applied when `raft-logic` exposes the ConfChangeV2 API. It follows the standard raft-rs two-phase Joint Consensus lifecycle.

#### Step 1: Propose a Membership Change (addPeer)

```typescript
// Pseudocode for when ConfChangeV2 is exposed on the WASM module

async addPeer(peerId: string): Promise<void> {
  if (!this._node || !this._started) {
    throw new Error('RaftLogicConsensus not started')
  }

  // Only leader can propose membership changes
  const status = this._node.status()
  if (status.lead === 0 || String(status.lead) !== this.config.nodeId) {
    throw new Error('Only the leader can propose a membership change')
  }

  // Get ConfChange types from the WASM module
  const {
    ConfChangeV2,
    ConfChangeSingle,
    ConfChangeTransition,
    ConfChangeType,
  } = this._raftModule

  // Build a Joint Consensus transition: C_old → C_old + C_new
  // "Explicit" transition means the cluster enters a joint state;
  // the leader will auto-transition to C_new once committed.
  const cc = new ConfChangeV2()
  cc.transition = ConfChangeTransition.Explicit

  // Create the individual change: add this node as a voter
  const change = new ConfChangeSingle()
  change.change_type = ConfChangeType.AddNode
  change.node_id = Number(peerId)
  cc.changes = [change]

  // Propose via raft. This writes the ConfChange entry to the raft log.
  // It will be replicated and committed like any other log entry.
  try {
    await this._node.proposeConfChange(cc)
  } catch (err) {
    throw new Error(`Failed to propose membership change: ${(err as Error).message}`)
  }
}
```

Similarly for removePeer:

```typescript
async removePeer(peerId: string): Promise<void> {
  if (!this._node || !this._started) {
    throw new Error('RaftLogicConsensus not started')
  }

  const status = this._node.status()
  if (status.lead === 0 || String(status.lead) !== this.config.nodeId) {
    throw new Error('Only the leader can propose a membership change')
  }

  const { ConfChangeV2, ConfChangeSingle, ConfChangeTransition, ConfChangeType } = this._raftModule

  const cc = new ConfChangeV2()
  cc.transition = ConfChangeTransition.Explicit

  const change = new ConfChangeSingle()
  change.change_type = ConfChangeType.RemoveNode
  change.node_id = Number(peerId)
  cc.changes = [change]

  try {
    await this._node.proposeConfChange(cc)
  } catch (err) {
    throw new Error(`Failed to propose membership change: ${(err as Error).message}`)
  }
}
```

**Important design decisions**:

1. **Use `ConfChangeV2` (not `ConfChange`)**: `ConfChangeV2` supports Joint Consensus transitions via the `transition` field. The older `ConfChange` only supports single-phase transitions (C_old → C_new directly), which are unsafe. Always prefer `ConfChangeV2`.

2. **Use `Explicit` transition type**: This tells raft to explicitly enter the joint state `C_old + C_new`, then auto-transition to `C_new` once the joint state is committed. The alternative `Auto` transition skips the joint state, which is faster but less safe during membership changes.

#### Step 2: Apply ConfChange in the Apply Callback

When a ConfChangeV2 entry is committed, it appears in the `apply()` callback with `entry_type === EntryType.EntryConfChangeV2`. The implementation must:

1. Unmarshal the entry data into a `ConfChangeV2` object
2. Call `this._node.applyConfChange(cc)` to update the raft node's internal membership state
3. Notify upper layers via `onMembershipChange` callbacks

```typescript
// In the RaftNode constructor's apply callback (or raft.start() apply parameter)

apply: async (entry: any) => {
  // Check if this is a membership change entry
  const { EntryType, ConfChangeV2 } = this._raftModule

  if (entry.entry_type === EntryType.EntryConfChangeV2) {
    // Unmarshal the ConfChangeV2 from the entry data
    const cc = ConfChangeV2.unmarshal(entry.data)

    // Apply to the raft node's internal state
    this._node.applyConfChange(cc)

    // Notify upper layers of the new membership
    const members = this.getClusterMembers()  // Now uses confState()
    this.logger.info('[RaftConsensus] Membership changed', { members })

    for (const cb of this._membershipCallbacks) {
      try { cb(members) } catch { /* swallow callback errors */ }
    }

    return  // Don't pass to the state machine apply function
  }

  // Normal state machine entry — apply to the engine
  if (this.applyFn) {
    await this.applyFn(Buffer.from(entry.data))
  }
}
```

**With this change**, `getClusterMembers()` should switch from the config-based fallback to reading from `confState()`:

```typescript
// Updated getClusterMembers — use when confState() is available
getClusterMembers(): string[] {
  if (!this._node) return this.config.peers

  // Prefer confState() when available
  if (typeof this._node.confState === 'function') {
    return this._node.confState().voters.map(String)
    // Optionally include learners:
    // const state = this._node.confState()
    // return [
    //   ...state.voters.map(String),
    //   ...state.learners.map(String),
    // ]
  }

  // Fallback: construct from config
  const members = new Set<string>()
  members.add(this.config.nodeId)
  for (const p of this.config.peers) {
    const idx = p.indexOf(':')
    members.add(idx > 0 ? p.substring(0, idx) : p)
  }
  return Array.from(members)
}
```

#### Step 3: EventBus Dynamic Connection Management

When membership changes, the EventBus must dynamically create or close DEALER sockets for new/removed peers.

```typescript
// Pseudocode for EventBus dynamic reconfiguration

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
      if (peerId === this.nodeId) continue  // Skip self
      if (this.dealers.has(peerId)) continue  // Already connected

      const addr = this.lookupPeerAddress(peerId)
      if (!addr) {
        this.log.warn(`[EventBus] No address for peer ${peerId}, skipping`)
        continue
      }

      this.log.info(`[EventBus] Creating DEALER for new peer ${peerId}`)
      const dealer = new zmq.Dealer()
      // ... configure CurveZMQ keys ...
      dealer.connect(addr)
      this.dealers.set(peerId, dealer)
    }
  }
}
```

**Wiring in the orchestrator**:

```typescript
// In MultiLeaderReplication or application bootstrap

replication.setConsensus(consensus)

// When WASM bindings support it:
consensus.onMembershipChange((members) => {
  eventBus.onMembershipChange(members)
})
```

### 3.5 Safety Guarantees (Joint Consensus)

Joint Consensus ensures safety during membership transitions through the following guarantees:

| Guarantee | Mechanism |
|-----------|-----------|
| **No split-brain** | During `C_old + C_new` phase, decisions require majority in BOTH configurations |
| **Leader continuity** | Leader must be in both C_old and C_new to remain leader during transition |
| **Crash recovery** | If the leader crashes during transition, a new leader from C_old + C_new picks up from the committed joint state |
| **Idempotent operations** | addPeer of an existing node = safe no-op; removePeer of a non-existent node = safe no-op |
| **Safe rollback** | If the transition fails to commit, the cluster remains in the previous known-good configuration |

**The Joint Consensus lifecycle**:

```
Timeline:
  1. Leader proposes addPeer("node-D")    → Entry written: C_old → C_old + C_new
  2. Entry committed on majority of BOTH   → Cluster enters joint state
  3. Leader auto-proposes C_old + C_new → C_new
  4. Entry committed on majority of C_new  → Cluster in new config
  5. Finalized. Nodes not in C_new are removed.
```

### 3.6 Edge Cases & Failure Modes

#### Concurrent Membership Changes

raft-rs serializes membership changes through the log — you cannot have two concurrent changes. If you call `addPeer()` while a previous change is in progress, the proposal is appended to the log but will be applied after the current transition completes. The `proposeConfChange()` call returns after the entry is appended, not after it's applied — callers should listen for `onMembershipChange` to know when the change is effective.

#### Leader Change During Transition

If the leader that proposed a Joint Consensus transition crashes, the newly elected leader reads the committed log entries and continues from the joint state. The new leader automatically completes the transition:

1. It reads the committed `EntryConfChangeV2` with `C_old → C_old + C_new`
2. It applies it to its own `ConfState`
3. It automatically proposes `C_old + C_new → C_new`
4. The transition completes normally

**The cluster is never stuck in a partial transition state.** This is a core property of Joint Consensus in raft-rs.

#### Removing the Current Leader

If a leader proposes`removePeer` with its own node ID:

1. The proposal is committed through the joint state
2. On transition to `C_new` (which excludes the old leader), the node steps down
3. A new leader is elected from the remaining nodes
4. The removed node stops participating in elections

**Safety concern**: The old leader's outbox may briefly continue sending before the role change callback fires. Mitigation: The `onRoleChange` tier (Tier 2 of R9) will detect the demotion from leader and freeze the outbox.

#### Removing a Non-Existent Peer

`removePeer` with a peer ID not in the current configuration is a safe no-op at the raft level — raft-rs ignores no-op conf changes. The implementation should still track this in logs.

#### Adding a Previously Removed Peer

When a peer that was previously removed is added back, the Joint Consensus transition works the same as adding a new peer. The node must re-join from scratch (catch up on logs, receive snapshots if necessary).

#### Transport Reconfiguration During Change

When membership changes, the EventBus must reconfigure its DEALER connections (see §3.4 Step 3). The reconfiguration must be **idempotent** and **thread-safe**:

- Creating a DEALER for a node that already has one = duplicate connection (ZMQ handles this gracefully but wastes resources)
- Closing a DEALER for a node that still needs it = message loss

**Recommendation**: Use a `Map<peerId, Dealer>` and only create/close on explicit add/remove events. Do not reconfigure on every `onMembershipChange` callback — only on actual changes from the previous state.

---

## 4. Integration Checklist

### Per-Component Changes

| File / Component | R9 Change | R10 Change |
|---|---|---|
| **Interface** (`consensus-provider.ts`) | `+inMajority()`, `+onMajorityChange(cb)` | `+addPeer(peerId)`, `+removePeer(peerId)`, `+getClusterMembers()`, `+onMembershipChange(cb)` |
| **RaftLogicConsensus** | `onQuorumActive` + `onRoleChange` event handlers + `_checkMajority()` 2000ms polling timer | Full `ConfChangeV2` lifecycle (when WASM API is available): `proposeConfChange()` + `applyConfChange()` in apply callback |
| **StandaloneConsensus** | `inMajority()` returns `true` always; `onMajorityChange()` stores but never fires | `addPeer()` / `removePeer()` are no-ops; `onMembershipChange()` stores but never fires; `getClusterMembers()` returns `[nodeId]` |
| **OutboxReplicationManager** | `_frozen` flag, `setFrozen()`, `setMajorityStatus()` — propagates to all PerPeerWorkers | — (no changes needed) |
| **PerPeerWorker** | `_frozen` flag, `setFrozen()` — early return in `_tick()` when frozen; ACK cleanup still runs | — (no changes needed) |
| **MultiLeaderReplication** | `setConsensus()`: wires `consensus.onMajorityChange()` → `manager.setMajorityStatus()` | Wire `consensus.onMembershipChange()` → EventBus dynamic connection (future) |
| **EventBus (ZMQ)** | — (no changes needed) | Dynamic DEALER connect/disconnect on membership change |
| **Tests** | Partition handling: AC-IT-R9 + AC-FI-R9 | Membership change: AC-IT-R10 (standalone) + future ConfChange tests |

### Line Count Estimate

| Component | Est. lines added |
|---|---|
| `consensus-provider.ts` (interface) | ~15 (6 method signatures + JSDoc) |
| `raft-logic-consensus.ts` (implementation) | ~80 (R9: 50 lines, R10: 30 lines) |
| `outbox-replication.ts` (freezing) | ~40 (PerPeerWorker: 15, Manager: 25) |
| `multi-leader-replication.ts` (wiring) | ~5 |
| `standalone-consensus.ts` (stubs) | ~30 |
| Tests (unit + integration + fault injection) | ~200 |

**Total core logic**: ~170 lines
**Total tests**: ~200 lines
**Grand total**: ~370 lines (excluding existing tests)

---

## 5. Testing Strategy

### 5.1 Unit Tests (ConsensusProvider)

Located in `test/consensus/` (7 test files, 95 tests total). Key coverage:

| Test | Description |
|------|-------------|
| `inMajority()` returns correct state after role change | Verify that leader→follower transition flips state |
| `inMajority()` returns correct state after leader election | Verify that follower→leader transition flips state |
| `onMajorityChange` fires on transitions | Each role change fires the correct (true/false) callback |
| `onMajorityChange` fires immediately on registration | Callback gets current state, even if no transition occurred |
| `onMajorityChange` does NOT fire on no-op transitions | Same state → no callback (prevents spam) |
| `addPeer` throws on non-leader node | Follower correctly rejects membership proposals |
| `removePeer` throws on non-leader node | Follower correctly rejects membership proposals |
| `getClusterMembers` includes all config peers | Returns correct list from config fallback |
| `onMembershipChange` stores callbacks without error | Registration does not throw |
| Cleanup on `stop()` | Timers are cleared, no orphan intervals |

### 5.2 Integration Tests

#### AC-IT-R9: Partition Handling (test/integration/partition-handling.test.ts)

Uses real `OutboxReplicationManager` and `PerPeerWorker` instances with in-memory event bus (no real ZMQ). Tests:

1. **Freeze**: `setMajorityStatus(false)` → worker frozen → messages queued but not sent
2. **Cycle**: `false → true → false` transitions without throwing
3. **Unfreeze**: `setMajorityStatus(true)` → worker unfrozen → pending messages eventually sent
4. **Idempotency**: Double freeze/unfreeze calls do not throw or corrupt state

```typescript
// Key test: freeze → no sends, unfreeze → sends resume
it('Simulate partition → outbox freezes → partition heals → outbox resumes', async () => {
  mgr.start()
  await sleep(200)

  // Freeze: simulate partition
  mgr.setMajorityStatus(false)

  // Add message while frozen
  mgr.addMessage('test_type', { key: 'value-1' })
  expect(mgr.getStats().pending).toBeGreaterThan(0)

  // Wait for several tick cycles while frozen
  await sleep(400)
  expect(sentMsgs.length).toBe(0)  // No sends while frozen

  // Heal: simulate partition recovery
  mgr.setMajorityStatus(true)

  // Wait for ticks to resume sending
  await sleep(1200)
  expect(sentMsgs.length).toBeGreaterThan(0)  // Messages now sent
})
```

#### AC-IT-R10: Membership Change (test/integration/membership-change.test.ts)

Uses `StandaloneConsensus` (no real ZMQ/Raft needed). Tests:

1. **addPeer is no-op** in standalone mode (does not throw, does not change members)
2. **removePeer is no-op** in standalone mode (does not throw, does not change members)
3. **onMembershipChange** registers without errors
4. **Multiple callbacks** can be registered
5. **Callbacks not fired** in standalone mode (no membership changes to report)
6. **getClusterMembers** returns only [nodeId] consistently

#### Fault Injection Tests

##### AC-FI-R9: Partition → Freeze → Heal → Resume (test/fault-injection/partition-outbox.test.ts)

Full lifecycle test simulating real fault scenarios:

1. Start manager with real timers (tickMs=50, fast for testing)
2. Inject partition: `setMajorityStatus(false)`
3. Verify outbox freezes within one tick (no sends)
4. Add messages during partition
5. Heal: `setMajorityStatus(true)`
6. Verify messages resume sending within backoff-tolerant window
7. Cleanup: unfreeze before stopping

##### AC-FI-1: Network Partition via SimulatedRaft (test/fault-injection/network-partition.test.ts)

Full 3-node SimulatedRaft partition test (uses real raft state machine in memory):

1. Create 3-node Raft cluster
2. Wait for leader election
3. Partition: stop a follower node's transport
4. Verify majority still functional (writes succeed)
5. Rejoin partitioned node
6. Verify data consistency after recovery

### 5.3 Fault Injection Tests

| Test File | Test | Scenario |
|-----------|------|----------|
| `network-partition.test.ts` | AC-FI-1 | 3-node simulated raft partition |
| `partition-outbox.test.ts` | AC-FI-R9 | Outbox freeze/heal lifecycle |
| `node-crash.test.ts` | AC-FI-2 | Single node crash and recovery |
| `leader-switch-black-window.test.ts` | AC-FI-3 | Leader failover timing |
| `consensus-failure.test.ts` | AC-FI-4 | Raft consensus engine failure |

---

## 6. Migration Guide

### From No Partition Handling to R9

For teams adopting this pattern in their own projects, here is the step-by-step recipe:

#### Step 1: Update the ConsensusProvider Interface

Copy the full interface from `consensus-provider.ts` — specifically the R9 and R10 method signatures:

```typescript
export interface ConsensusProvider {
  // ... your existing methods ...

  // ── Add these ──
  inMajority(): boolean
  onMajorityChange(cb: (inMajority: boolean) => void): void
  addPeer(peerId: string): Promise<void>
  removePeer(peerId: string): Promise<void>
  getClusterMembers(): string[]
  onMembershipChange(cb: (members: string[]) => void): void
}
```

#### Step 2: Add Majority Detection to Your Raft Implementation

Implement the three-tier detection pattern described in §2.3. The essential code:

```typescript
// Class fields
private _inMajority = true
private _majorityCallbacks: Array<(inMajority: boolean) => void> = []

// In your raft.start():
raft.onRoleChange((rc) => {
  // leader→follower = majority loss
  if (rc.role === 'follower' || rc.role === 'candidate') {
    this._setMajority(false)
  }
  // becomes leader = majority gain
  if (rc.role === 'leader') {
    this._setMajority(true)
  }
})

// Optional: onQuorumActive for fast re-entry
if (raft.onQuorumActive) {
  raft.onQuorumActive(() => this._setMajority(true))
}

// Polling fallback (2000ms)
setInterval(() => {
  const status = this._node.status()
  const leader = status.lead ?? status.leaderId ?? null
  this._setMajority(leader !== null && leader !== 0)
}, 2000)

// Helper
private _setMajority(val: boolean): void {
  if (this._inMajority === val) return  // No change
  this._inMajority = val
  for (const cb of this._majorityCallbacks) {
    try { cb(val) } catch {}
  }
}

// In onMajorityChange:
onMajorityChange(cb) {
  this._majorityCallbacks.push(cb)
  cb(this._inMajority)  // Immediate callback!
}
```

#### Step 3: Add Freeze Support to Your Outbox Manager

```typescript
// In your outbox manager (OutboxReplicationManager equivalent):
private _frozen = false

setFrozen(frozen: boolean): void {
  if (this._frozen === frozen) return
  this._frozen = frozen
  for (const worker of this.allWorkers()) {
    worker.setFrozen(frozen)
  }
}

setMajorityStatus(inMajority: boolean): void {
  this.setFrozen(!inMajority)
}
```

In each per-peer worker:

```typescript
private _frozen = false

setFrozen(frozen: boolean): void {
  if (this._frozen === frozen) return
  this._frozen = frozen
}

// In the worker's tick/send loop:
async _tick(): Promise<void> {
  if (this._frozen) {
    // Still process ACK timeouts (prevent leaks)
    this._processAckTimeouts()
    return  // Skip all sends
  }
  // ... normal send logic ...
}
```

#### Step 4: Wire It Up

```typescript
// One line in your orchestration layer
consensus.onMajorityChange((inMajority) => {
  outboxManager.setMajorityStatus(inMajority)
})
```

#### Step 5: (Optional) Add Membership Change Support

When your raft bindings support ConfChangeV2, follow the pattern in §3.4. For now, `addPeer`/`removePeer` can throw with a clear error message.

### Rollback

To disable partition handling without losing state:

1. Stop wiring: remove `setConsensus()` call
2. The outbox will operate normally without partition protection
3. Messages queued during a freeze are not lost (they're in LMDB)
4. To unfreeze from a stuck state: call `manager.setMajorityStatus(true)`

---

## 7. Appendix: Complete Source Code References

### Primary Implementation Files

| File | Key Lines | Content |
|------|-----------|---------|
| `src/consensus/consensus-provider.ts` | 1-115 | Full interface: all R9/R10 method signatures with JSDoc |
| `src/consensus/raft-logic-consensus.ts` | 18-39 | Class fields: `_inMajority`, `_majorityCallbacks`, `_majorityCheckTimer` |
| `src/consensus/raft-logic-consensus.ts` | 153-270 | `start()`: raft initialization, onQuorumActive hook (L206-219), onRoleChange hook (L221-252), polling fallback (L254-262) |
| `src/consensus/raft-logic-consensus.ts` | 422-456 | `inMajority()`, `onMajorityChange()`, `_checkMajority()` |
| `src/consensus/raft-logic-consensus.ts` | 458-525 | `addPeer()`, `removePeer()`, `getClusterMembers()`, `onMembershipChange()` |
| `src/consensus/standalone-consensus.ts` | 56-100 | Standalone stubs for all R9/R10 methods |
| `src/core/outbox-replication.ts` | 737-845 | PerPeerWorker fields, `setFrozen()`, `_tick()` early return on freeze |
| `src/core/outbox-replication.ts` | 1082-1511 | OutboxReplicationManager: `_frozen` field, `setFrozen()`, `setMajorityStatus()`, `start()`, `getStats()` |
| `src/core/multi-leader-replication.ts` | 165-185 | `MultiLeaderReplication.setConsensus()` wiring |

### Test Files

| File | Content |
|------|---------|
| `test/integration/partition-handling.test.ts` | AC-IT-R9: Outbox freeze/unfreeze (no ZMQ, in-memory event bus) |
| `test/integration/membership-change.test.ts` | AC-IT-R10: StandaloneConsensus addPeer/removePeer/getClusterMembers |
| `test/fault-injection/partition-outbox.test.ts` | AC-FI-R9: Partition → freeze → heal → resume lifecycle |
| `test/fault-injection/network-partition.test.ts` | AC-FI-1: 3-node simulated raft partition |

### Naming Conventions

| Prefix | Suite | Scope |
|--------|-------|-------|
| `AC-IT-R9` | Integration Test | R9 partition handling |
| `AC-IT-R10` | Integration Test | R10 membership change |
| `AC-FI-R9` | Fault Injection Test | R9 partition + outbox freeze |
| `AC-FI-[1-9]` | Fault Injection Test | General fault scenarios |
