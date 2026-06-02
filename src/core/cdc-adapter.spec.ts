/**
 * cdc-adapter.spec.ts — CdcAdapter 单元测试
 *
 * CdcAdapter 的实际测试涵盖在 src/api/cdc-server.spec.ts 中，
 * 此处提供更细粒度的 CdcAdapter 自身逻辑测试。
 */

import { describe, it, expect } from 'vitest'
import {
  CdcAdapter,
  CdcEvent,
  NODE_CREATED,
  NODE_DELETED,
  NODE_UPDATED,
  EDGE_CREATED,
  EDGE_DELETED,
  EDGE_UPDATED,
} from './cdc-adapter'

function makeMsg(type: string, data: Record<string, unknown>, seq: number = 1) {
  return {
    msgId: `test-${seq}`,
    seq,
    nodeId: 'test-node',
    timestamp: Date.now(),
    type,
    data,
  }
}

describe('CdcAdapter', () => {
  it('handles node:updated events', () => {
    const adapter = new CdcAdapter()
    const events: CdcEvent[] = []
    adapter.subscribe('test', (e) => events.push(e))
    adapter.handleEvent(makeMsg(NODE_UPDATED, { id: 1, name: 'Alice', age: 31 }))
    expect(events.length).toBe(1)
    expect(events[0].op).toBe('update')
    expect(events[0].entity).toBe('node')
    expect(events[0].after?.name).toBe('Alice')
  })

  it('handles edge:updated events', () => {
    const adapter = new CdcAdapter()
    const events: CdcEvent[] = []
    adapter.subscribe('test', (e) => events.push(e))
    adapter.handleEvent(makeMsg(EDGE_UPDATED, { src: 1, dst: 2, typeId: 5, weight: 0.8 }))
    expect(events.length).toBe(1)
    expect(events[0].op).toBe('update')
    expect(events[0].entity).toBe('edge')
    expect(events[0].after?.weight).toBe(0.8)
  })

  it('default filter is applied to all subscribers', () => {
    const adapter = new CdcAdapter({
      maxBufferSize: 100,
      defaultFilter: { ops: ['create'] },
    })
    const events: CdcEvent[] = []
    adapter.subscribe('test', (e) => events.push(e))
    adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1 }))
    adapter.handleEvent(makeMsg(NODE_DELETED, { id: 1 }))
    expect(events.length).toBe(1)
    expect(events[0].op).toBe('create')
  })

  it('subscriber filter overrides default filter', () => {
    const adapter = new CdcAdapter({
      maxBufferSize: 100,
      defaultFilter: { ops: ['create'] },
    })
    const events: CdcEvent[] = []
    adapter.subscribe('test', (e) => events.push(e), { ops: ['delete'] })
    adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1 }))
    adapter.handleEvent(makeMsg(NODE_DELETED, { id: 1 }))
    expect(events.length).toBe(1)
    expect(events[0].op).toBe('delete')
  })

  it('querySince returns empty when buffer is full and old events evicted', () => {
    const adapter = new CdcAdapter({ maxBufferSize: 3 })
    // Fill buffer
    adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1 }, 1))
    adapter.handleEvent(makeMsg(NODE_CREATED, { id: 2 }, 2))
    adapter.handleEvent(makeMsg(NODE_CREATED, { id: 3 }, 3))
    adapter.handleEvent(makeMsg(NODE_CREATED, { id: 4 }, 4))
    // seq 1 was evicted
    expect(adapter.querySince(0).length).toBe(3) // seq 2,3,4
    expect(adapter.querySince(1).length).toBe(3) // seq 2,3,4
    expect(adapter.querySince(2).length).toBe(2) // seq 3,4
  })

  it('getSubscriberIds returns all subscriber ids', () => {
    const adapter = new CdcAdapter()
    adapter.subscribe('a', () => {})
    adapter.subscribe('b', () => {})
    const ids = adapter.getSubscriberIds()
    expect(ids).toContain('a')
    expect(ids).toContain('b')
    expect(ids.length).toBe(2)
  })

  it('unsubscribe removes subscriber', () => {
    const adapter = new CdcAdapter()
    adapter.subscribe('a', () => {})
    adapter.unsubscribe('a')
    expect(adapter.getSubscriberIds()).not.toContain('a')
  })
})
