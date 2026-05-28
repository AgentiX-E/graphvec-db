# P0-1 ACID Transaction Enhancement Plan

Created: 2026-05-29 07:28

## Target
Enhance transaction system with SSI (read-set conflict), deadlock detection, version chain, and isolation levels.

## Implementation

### 1. MVCCSnapshot — add `version` field
- Rename existing to basic version, add `version?: number` for MVCC reads

### 2. IsolationLevel type + TransactionManager.begin({ isolation })
- `begin(opts?: { isolation: 'read-committed' | 'snapshot' | 'serializable' })`
- Default: `'snapshot'`

### 3. TransactionManager — add `detectDeadlock(snapshotId): string | null`
- Build wait-for graph from current locks
- Use DFS cycle detection
- Return first deadlock description string or null

### 4. Transaction — add `_checkReadSetConflict(engine): boolean`
- For each node in readSet, check if it's been modified since snapshot.createdAt
- Return true if conflict found

### 5. Enhanced commit() — add Phase 0 and Phase 0.5
- Phase 0: For serializable mode, call _checkReadSetConflict()
- Phase 0.5: Call mgr.detectDeadlock() after lock attempt, throw if deadlock

### 6. New tests (7+ new tests, existing 27 still pass)

## Current Progress
Ready to implement.
