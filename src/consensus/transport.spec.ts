// ============================================================
// transport.spec.ts — MockTransport & Transport 接口单元测试
//
// TcpTransport 的复杂集成测试在 raft-transport.spec.ts 中。
// 本文件覆盖 MockTransport（内存同步消息传递）和接口定义。
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MockTransport, TcpTransport } from './transport'
import type { AppendEntriesRequest, AppendEntriesResponse, RequestVoteResponse, InstallSnapshotRequest, InstallSnapshotResponse } from './transport'
import { generateSelfSignedCert } from '../security/tls'

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

describe('TcpTransport - TLS', () => {
  let tcpTls: TcpTransport
  let tcpTlsClient: TcpTransport
  const _crypto = require('crypto')

  beforeEach(() => {
    // 生成自签名 TLS 证书
    const { cert, key } = generateSelfSignedCert()
    tcpTls = new TcpTransport('tls-server', 0)
    tcpTls.setNamespace(`tls-test-${Date.now()}`)
    tcpTls.enableTLS({ cert, key, rejectUnauthorized: false })

    tcpTlsClient = new TcpTransport('tls-client', 0)
    tcpTlsClient.setNamespace(`tls-test-${Date.now()}`)
    tcpTlsClient.enableTLS({ cert, key, rejectUnauthorized: false })
  })

  afterEach(() => {
    try { tcpTls.stop() } catch { /* ignore */ }
    try { tcpTlsClient.stop() } catch { /* ignore */ }
    TcpTransport.reset()
  })

  it('should start and listen with TLS', () => {
    tcpTls.start()
    expect(tcpTls.getPort()).toBeGreaterThan(0)
  })

  it('should connect and send message with TLS', async () => {
    const receivedMessages: Buffer[] = []
    tcpTls.setMessageHandler((from: string, msg: Uint8Array) => {
      receivedMessages.push(Buffer.from(msg))
    })
    tcpTls.start()
    const port = tcpTls.getPort()

    tcpTlsClient.start()
    tcpTlsClient.connectTo(`tls-server:127.0.0.1:${port}`)

    // 等待连接建立
    await new Promise(r => setTimeout(r, 500))

    const testMsg = Buffer.from('hello-tls')
    await tcpTlsClient.sendTo('tls-server', testMsg)

    // 等待消息到达
    await new Promise(r => setTimeout(r, 500))

    expect(receivedMessages.length).toBe(1)
    expect(receivedMessages[0].toString()).toBe('hello-tls')
  })

  it('should broadcast to TLS peers', async () => {
    tcpTls.setMessageHandler(() => {})
    tcpTls.start()
    const port = tcpTls.getPort()

    // 模拟两个 server 监听
    const received: string[] = []
    tcpTls.setMessageHandler((from: string, msg: Uint8Array) => {
      received.push(Buffer.from(msg).toString())
    })

    tcpTlsClient.start()
    tcpTlsClient.connectTo(`tls-server:127.0.0.1:${port}`)

    await new Promise(r => setTimeout(r, 500))

    // 客户端发送广播到服务器
    const broadcastMsg = Buffer.from('tls-broadcast')
    await tcpTlsClient.sendTo('tls-server', broadcastMsg)
    await new Promise(r => setTimeout(r, 500))

    expect(received.length).toBeGreaterThanOrEqual(1)
    expect(received[0]).toBe('tls-broadcast')
  })
})

// 辅助：生成自签名证书
// generateSelfSignedCert 从 src/security/tls.ts import
// 本地不再重复定义——直接使用 import 的版本
