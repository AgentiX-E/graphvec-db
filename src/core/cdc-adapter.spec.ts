/**
 * cdc-adapter.spec.ts — CdcAdapter 单元测试
 *
 * CdcAdapter 的实际测试涵盖在 src/api/cdc-server.spec.ts 中，
 * 此处提供更细粒度的 CdcAdapter 自身逻辑测试。
 *
 * GAP-60 覆盖：
 * - PropertyFilter: eq/neq/gt/gte/lt/lte/exists
 * - CdcFilter.properties 属性过滤
 * - querySince 属性过滤
 */

import { describe, it, expect } from 'vitest'
import {
  CdcAdapter,
  CdcEvent,
  CdcFilter,
  CdcPropertyFilter,
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

  // ── GAP-60: PropertyFilter ──────────────────────

  describe('GAP-60: PropertyFilter', () => {
    it('GAP-60-01: filters by property eq (string)', () => {
      const adapter = new CdcAdapter()
      const events: CdcEvent[] = []
      adapter.subscribe('test', (e) => events.push(e), {
        properties: { name: { op: 'eq', value: 'Alice' } },
      })
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1, name: 'Alice', age: 30 }))
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 2, name: 'Bob', age: 25 }))
      expect(events.length).toBe(1)
      expect(events[0].after?.name).toBe('Alice')
    })

    it('GAP-60-02: filters by property eq (number)', () => {
      const adapter = new CdcAdapter()
      const events: CdcEvent[] = []
      adapter.subscribe('test', (e) => events.push(e), {
        properties: { age: { op: 'eq', value: 30 } },
      })
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1, age: 30 }))
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 2, age: 25 }))
      expect(events.length).toBe(1)
      expect(events[0].after?.age).toBe(30)
    })

    it('GAP-60-03: filters by property neq', () => {
      const adapter = new CdcAdapter()
      const events: CdcEvent[] = []
      adapter.subscribe('test', (e) => events.push(e), {
        properties: { status: { op: 'neq', value: 'inactive' } },
      })
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1, status: 'active' }))
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 2, status: 'inactive' }))
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 3, status: 'pending' }))
      expect(events.length).toBe(2)
      expect(events[0].after?.id).toBe(1)
      expect(events[1].after?.id).toBe(3)
    })

    it('GAP-60-04: filters by property gt (number)', () => {
      const adapter = new CdcAdapter()
      const events: CdcEvent[] = []
      adapter.subscribe('test', (e) => events.push(e), {
        properties: { age: { op: 'gt', value: 30 } },
      })
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1, age: 20 }))
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 2, age: 30 }))
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 3, age: 40 }))
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 4, age: 50 }))
      expect(events.length).toBe(2)
      expect(events[0].after?.id).toBe(3)
      expect(events[1].after?.id).toBe(4)
    })

    it('GAP-60-05: filters by property gte', () => {
      const adapter = new CdcAdapter()
      const events: CdcEvent[] = []
      adapter.subscribe('test', (e) => events.push(e), {
        properties: { age: { op: 'gte', value: 30 } },
      })
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1, age: 20 }))
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 2, age: 30 }))
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 3, age: 40 }))
      expect(events.length).toBe(2)
      expect(events[0].after?.id).toBe(2)
      expect(events[1].after?.id).toBe(3)
    })

    it('GAP-60-06: filters by property lt (number)', () => {
      const adapter = new CdcAdapter()
      const events: CdcEvent[] = []
      adapter.subscribe('test', (e) => events.push(e), {
        properties: { age: { op: 'lt', value: 30 } },
      })
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1, age: 20 }))
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 2, age: 30 }))
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 3, age: 40 }))
      expect(events.length).toBe(1)
      expect(events[0].after?.id).toBe(1)
    })

    it('GAP-60-07: filters by property lte', () => {
      const adapter = new CdcAdapter()
      const events: CdcEvent[] = []
      adapter.subscribe('test', (e) => events.push(e), {
        properties: { age: { op: 'lte', value: 30 } },
      })
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1, age: 20 }))
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 2, age: 30 }))
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 3, age: 40 }))
      expect(events.length).toBe(2)
      expect(events[0].after?.id).toBe(1)
      expect(events[1].after?.id).toBe(2)
    })

    it('GAP-60-08: filters by property exists', () => {
      const adapter = new CdcAdapter()
      const events: CdcEvent[] = []
      adapter.subscribe('test', (e) => events.push(e), {
        properties: { email: { op: 'exists' } },
      })
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1, name: 'Alice', email: 'alice@test.com' }))
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 2, name: 'Bob' }))
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 3, name: 'Charlie', email: 'charlie@test.com' }))
      expect(events.length).toBe(2)
      expect(events[0].after?.id).toBe(1)
      expect(events[1].after?.id).toBe(3)
    })

    it('GAP-60-09: multiple property filters use AND logic', () => {
      const adapter = new CdcAdapter()
      const events: CdcEvent[] = []
      adapter.subscribe('test', (e) => events.push(e), {
        properties: {
          age: { op: 'gte', value: 30 },
          status: { op: 'eq', value: 'active' },
        },
      })
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1, age: 25, status: 'active' }))
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 2, age: 30, status: 'active' }))
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 3, age: 30, status: 'inactive' }))
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 4, age: 35, status: 'active' }))
      expect(events.length).toBe(2)
      expect(events[0].after?.id).toBe(2)
      expect(events[1].after?.id).toBe(4)
    })

    it('GAP-60-10: property filter combined with other filters', () => {
      const adapter = new CdcAdapter()
      const events: CdcEvent[] = []
      adapter.subscribe('test', (e) => events.push(e), {
        ops: ['create'],
        entities: ['node'],
        properties: { age: { op: 'gt', value: 25 } },
      })
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1, age: 20 }))
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 2, age: 30 }))
      adapter.handleEvent(makeMsg(NODE_DELETED, { id: 3, age: 30 }))
      expect(events.length).toBe(1)
      expect(events[0].after?.id).toBe(2)
    })

    it('GAP-60-11: property filter on delete events uses before', () => {
      const adapter = new CdcAdapter()
      const events: CdcEvent[] = []
      adapter.subscribe('test', (e) => events.push(e), {
        properties: { status: { op: 'eq', value: 'archived' } },
      })
      adapter.handleEvent(makeMsg(NODE_DELETED, { id: 1, status: 'active' }))
      adapter.handleEvent(makeMsg(NODE_DELETED, { id: 2, status: 'archived' }))
      expect(events.length).toBe(1)
      expect(events[0].before?.id).toBe(2)
    })

    it('GAP-60-12: property filter with neq on delete uses before', () => {
      const adapter = new CdcAdapter()
      const events: CdcEvent[] = []
      adapter.subscribe('test', (e) => events.push(e), {
        properties: { status: { op: 'neq', value: 'active' } },
      })
      adapter.handleEvent(makeMsg(NODE_DELETED, { id: 1, status: 'active' }))
      adapter.handleEvent(makeMsg(NODE_DELETED, { id: 2, status: 'archived' }))
      expect(events.length).toBe(1)
      expect(events[0].before?.id).toBe(2)
    })

    it('GAP-60-13: property filter with eq matches edge attributes', () => {
      const adapter = new CdcAdapter()
      const events: CdcEvent[] = []
      adapter.subscribe('test', (e) => events.push(e), {
        properties: { weight: { op: 'gt', value: 0.5 } },
      })
      adapter.handleEvent(makeMsg(EDGE_CREATED, { src: 1, dst: 2, weight: 0.3 }))
      adapter.handleEvent(makeMsg(EDGE_CREATED, { src: 1, dst: 3, weight: 0.8 }))
      expect(events.length).toBe(1)
      expect(events[0].after?.weight).toBe(0.8)
    })

    it('GAP-60-14: querySince supports property filter', () => {
      const adapter = new CdcAdapter()
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1, name: 'Alice', age: 25 }))
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 2, name: 'Bob', age: 30 }))
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 3, name: 'Charlie', age: 35 }))

      const results = adapter.querySince(0, {
        properties: { age: { op: 'gte', value: 30 } },
      })
      expect(results.length).toBe(2)
      expect(results[0].after?.id).toBe(2)
      expect(results[1].after?.id).toBe(3)
    })

    it('GAP-60-15: no events match when property value is absent', () => {
      const adapter = new CdcAdapter()
      const events: CdcEvent[] = []
      adapter.subscribe('test', (e) => events.push(e), {
        properties: { missingProp: { op: 'eq', value: 'value' } },
      })
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1, name: 'Alice' }))
      expect(events.length).toBe(0)
    })

    it('GAP-60-16: exists filter returns false for absent property', () => {
      const adapter = new CdcAdapter()
      const events: CdcEvent[] = []
      adapter.subscribe('test', (e) => events.push(e), {
        properties: { email: { op: 'exists' } },
      })
      adapter.handleEvent(makeMsg(NODE_CREATED, { id: 1, name: 'Alice' }))
      expect(events.length).toBe(0)
    })
  })
})
