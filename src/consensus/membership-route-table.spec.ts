/**
 * membership-route-table.spec.ts — 路由表单元测试
 */

import { describe, test, expect, beforeEach } from 'vitest'
import { MembershipRouteTable } from './membership-route-table'

describe('MembershipRouteTable', () => {
  let table: MembershipRouteTable

  beforeEach(() => {
    table = new MembershipRouteTable()
  })

  test('should initialize from peers list', () => {
    const peers = [
      { nodeId: 'node-1', addr: 'tcp://host1:7001' },
      { nodeId: 'node-2', addr: 'tcp://host2:7001' },
    ]
    table.initialize(peers)

    expect(table.getAddr('node-1')).toBe('tcp://host1:7001')
    expect(table.getAddr('node-2')).toBe('tcp://host2:7001')
    expect(table.getOnlineCount()).toBe(2)
  })

  test('should add new route', () => {
    table.initialize([])
    table.setRoute('node-3', 'tcp://host3:7001')

    expect(table.getAddr('node-3')).toBe('tcp://host3:7001')
    expect(table.getOnlineCount()).toBe(1)
  })

  test('should update existing route', () => {
    table.initialize([{ nodeId: 'node-1', addr: 'tcp://old:7001' }])
    table.setRoute('node-1', 'tcp://new:7001')

    expect(table.getAddr('node-1')).toBe('tcp://new:7001')
  })

  test('should remove route', () => {
    table.initialize([{ nodeId: 'node-1', addr: 'tcp://host1:7001' }])
    table.removeRoute('node-1')

    expect(table.getAddr('node-1')).toBeUndefined()
    expect(table.getOnlineCount()).toBe(0)
  })

  test('should mark health status', () => {
    table.initialize([{ nodeId: 'node-1', addr: 'tcp://host1:7001' }])
    expect(table.getOnlineCount()).toBe(1)

    table.setHealth('node-1', false)
    expect(table.getOnlineCount()).toBe(0)

    table.setHealth('node-1', true)
    expect(table.getOnlineCount()).toBe(1)
  })

  test('should convert to peers array', () => {
    table.initialize([
      { nodeId: 'node-1', addr: 'tcp://h1:7001' },
      { nodeId: 'node-2', addr: 'tcp://h2:7001' },
    ])

    const peers = table.toPeers()
    expect(peers).toHaveLength(2)
    expect(peers.find(p => p.nodeId === 'node-1')?.addr).toBe('tcp://h1:7001')
  })

  test('should take snapshot', () => {
    table.initialize([{ nodeId: 'node-1', addr: 'tcp://h1:7001' }])

    const snap = table.snapshot()
    expect(snap.has('node-1')).toBe(true)
    expect(snap.get('node-1')!.addr).toBe('tcp://h1:7001')

    // snapshot should be a copy
    table.setRoute('node-2', 'tcp://h2:7001')
    expect(snap.has('node-2')).toBe(false)
  })

  test('getAddr returns undefined for unknown node', () => {
    table.initialize([])
    expect(table.getAddr('unknown-node')).toBeUndefined()
  })

  test('removeRoute on non-existent node does not throw', () => {
    table.initialize([])
    expect(() => table.removeRoute('ghost')).not.toThrow()
  })

  test('setHealth on non-existent node does not throw', () => {
    table.initialize([])
    expect(() => table.setHealth('ghost', true)).not.toThrow()
  })
})
