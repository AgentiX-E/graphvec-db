// ============================================================
// transport.spec.ts — MockTransport & Transport 接口单元测试
//
// TcpTransport 的复杂集成测试在 raft-transport.spec.ts 中。
// 本文件覆盖 MockTransport（内存同步消息传递）和接口定义。
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MockTransport } from './transport'
import type { AppendEntriesRequest, AppendEntriesResponse, RequestVoteResponse, InstallSnapshotRequest, InstallSnapshotResponse } from './transport'

describe('MockTransport', () => {
  beforeEach(() => {
    MockTransport.reset()
  })

  afterEach(() => {
    MockTransport.reset()
  })

  describe('basic lifecycle', () => {
    it('starts and stops without error', async () => {
      const t = new MockTransport('node-1')
      await t.start()
      expect(MockTransport.registeredCount).toBe(1)
      await t.stop()
      expect(MockTransport.registeredCount).toBe(0)
    })

    it('is idempotent on start', async () => {
      const t = new MockTransport('node-1')
      await t.start()
      await t.start()
      expect(MockTransport.registeredCount).toBe(1)
      await t.stop()
    })

    it('handles multiple transports', async () => {
      const t1 = new MockTransport('node-1')
      const t2 = new MockTransport('node-2')
      await t1.start()
      await t2.start()
      expect(MockTransport.registeredCount).toBe(2)
      await t1.stop()
      expect(MockTransport.registeredCount).toBe(1)
      await t2.stop()
      expect(MockTransport.registeredCount).toBe(0)
    })
  })

  describe('onMessage handler', () => {
    it('delivers message to handler via sendResponse', async () => {
      const t1 = new MockTransport('node-1')
      const t2 = new MockTransport('node-2')

      const received: string[] = []
      t2.onMessage((from, msg) => {
        received.push(from)
        if (msg.type === 'AppendEntries') {
          MockTransport.sendResponse(from, 'node-2', {
            type: 'AppendEntriesResponse',
            term: 1,
            from: 'node-2',
            to: from,
            data: { term: 1, success: true, lastLogIndex: 1 } as AppendEntriesResponse,
          })
        }
      })

      await t1.start()
      await t2.start()

      const resp = await t1.appendEntries('node-2', { term: 1, leaderId: 'n1', prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 })
      expect(resp.success).toBe(true)
      expect(received).toContain('node-1')

      await t1.stop()
      await t2.stop()
    })

    it('does not crash when target has no handler', async () => {
      const t1 = new MockTransport('node-1')
      const t2 = new MockTransport('node-2')

      await t1.start()
      await t2.start()

      // No handler on t2 — should get default response
      const result = await t1.appendEntries('node-2', { term: 1, leaderId: 'n1', prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 })
      expect(result).toBeDefined()
      expect(result.success).toBe(false)
      expect(result.term).toBe(0)

      await t1.stop()
      await t2.stop()
    })
  })

  describe('RPC methods', () => {
    it('appendEntries returns response', async () => {
      const t1 = new MockTransport('node-1')
      const t2 = new MockTransport('node-2')

      // Set up handler on t2 to send response via sendResponse
      t2.onMessage((from, msg) => {
        if (msg.type === 'AppendEntries') {
          MockTransport.sendResponse(from, 'node-2', {
            type: 'AppendEntriesResponse',
            term: 1,
            from: 'node-2',
            to: from,
            data: { term: 1, success: true, lastLogIndex: 5 } as AppendEntriesResponse,
          })
        }
      })

      await t1.start()
      await t2.start()

      const resp = await t1.appendEntries('node-2', { term: 1, leaderId: 'n1', prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 })
      expect(resp).toBeDefined()
      expect(resp.success).toBe(true)
      expect(resp.term).toBe(1)
      expect(resp.lastLogIndex).toBe(5)

      await t1.stop()
      await t2.stop()
    })

    it('requestVote returns response', async () => {
      const t1 = new MockTransport('node-1')
      const t2 = new MockTransport('node-2')

      t2.onMessage((from, msg) => {
        if (msg.type === 'RequestVote') {
          MockTransport.sendResponse(from, 'node-2', {
            type: 'RequestVoteResponse',
            term: 2,
            from: 'node-2',
            to: from,
            data: { term: 2, voteGranted: true } as RequestVoteResponse,
          })
        }
      })

      await t1.start()
      await t2.start()

      const resp = await t1.requestVote('node-2', { term: 2, candidateId: 'n1', lastLogIndex: 10, lastLogTerm: 2 })
      expect(resp).toBeDefined()
      expect(resp.voteGranted).toBe(true)
      expect(resp.term).toBe(2)

      await t1.stop()
      await t2.stop()
    })

    it('preVote returns response', async () => {
      const t1 = new MockTransport('node-1')
      const t2 = new MockTransport('node-2')

      t2.onMessage((from, msg) => {
        if (msg.type === 'PreVote') {
          MockTransport.sendResponse(from, 'node-2', {
            type: 'PreVoteResponse',
            term: 3,
            from: 'node-2',
            to: from,
            data: { term: 3, voteGranted: false } as RequestVoteResponse,
          })
        }
      })

      await t1.start()
      await t2.start()

      const resp = await t1.preVote('node-2', { term: 3, candidateId: 'n1', lastLogIndex: 5, lastLogTerm: 3 })
      expect(resp).toBeDefined()
      expect(resp.voteGranted).toBe(false)
      expect(resp.term).toBe(3)

      await t1.stop()
      await t2.stop()
    })

    it('installSnapshot returns response', async () => {
      const t1 = new MockTransport('node-1')
      const t2 = new MockTransport('node-2')

      t2.onMessage((from, msg) => {
        if (msg.type === 'InstallSnapshot') {
          MockTransport.sendResponse(from, 'node-2', {
            type: 'InstallSnapshotResponse',
            term: 1,
            from: 'node-2',
            to: from,
            data: { term: 1, success: true } as InstallSnapshotResponse,
          })
        }
      })

      await t1.start()
      await t2.start()

      const resp = await t1.installSnapshot('node-2', {
        term: 1,
        leaderId: 'n1',
        lastIncludedIndex: 100,
        lastIncludedTerm: 1,
        data: new Uint8Array([1, 2, 3]),
        done: true,
      })
      expect(resp).toBeDefined()
      expect(resp.success).toBe(true)
      expect(resp.term).toBe(1)

      await t1.stop()
      await t2.stop()
    })

    it('appendEntries returns default response when target has no handler', async () => {
      const t1 = new MockTransport('node-1')
      const t2 = new MockTransport('node-2')
      await t1.start()
      await t2.start()

      // t2 has no onMessage handler — should get default response
      const resp = await t1.appendEntries('node-2', { term: 1, leaderId: 'n1', prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 })
      expect(resp).toBeDefined()
      expect(resp.success).toBe(false)
      expect(resp.term).toBe(0)

      await t1.stop()
      await t2.stop()
    })

    it('returns default response for non-existent target node', async () => {
      const t1 = new MockTransport('node-1')
      await t1.start()

      const resp = await t1.appendEntries('nonexistent', { term: 1, leaderId: 'n1', prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 })
      expect(resp).toBeDefined()
      expect(resp.success).toBe(false)

      await t1.stop()
    })
  })

  describe('setNodeId', () => {
    it('changes node id', async () => {
      const t = new MockTransport('old-id')
      t.setNodeId('new-id')
      await t.start()
      expect(t['nodeId']).toBe('new-id')
      expect(MockTransport.registeredCount).toBe(1)
      await t.stop()
    })
  })

  describe('static methods', () => {
    it('reset clears all registrations', () => {
      const t1 = new MockTransport('a')
      const t2 = new MockTransport('b')
      // Just add directly to registry
      MockTransport.reset()
      expect(MockTransport.registeredCount).toBe(0)
    })

    it('getRegistryEntry returns handler for registered node', async () => {
      const t = new MockTransport('my-node')
      await t.start()

      const entry = MockTransport.getRegistryEntry('my-node')
      expect(entry).toBeDefined()
      expect(entry).toHaveProperty('pendingResponses')
      expect(entry).toHaveProperty('onMessage')

      await t.stop()
    })
  })
})
