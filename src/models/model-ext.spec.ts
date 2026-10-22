// ============================================================
// model-ext.spec.ts — Extended model tests for NodeRecord, EdgeRecord
//
// Tests beyond the basic interface validation in types.spec.ts:
//   - Deep copy / spread semantics
//   - Property combinations (nested objects, edge cases)
//   - Comparison helpers
//   - Record factory/construction patterns
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest'
import {
  type NodeRecord,
  type EdgeRecord,
  type NodeProperties,
} from '../types'

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

function cloneNode(n: NodeRecord): NodeRecord {
  return JSON.parse(JSON.stringify(n))
}

function cloneEdge(e: EdgeRecord): EdgeRecord {
  return JSON.parse(JSON.stringify(e))
}

function compareNode(a: NodeRecord, b: NodeRecord): boolean {
  if (a.id !== b.id) return false
  if (a.type !== b.type) return false
  if (a.name !== b.name) return false
  if (JSON.stringify(a.props) !== JSON.stringify(b.props)) return false
  return true
}

function compareEdge(a: EdgeRecord, b: EdgeRecord): boolean {
  if (a.src !== b.src) return false
  if (a.dst !== b.dst) return false
  if (a.type !== b.type) return false
  if (JSON.stringify(a.props) !== JSON.stringify(b.props)) return false
  return true
}

// Factory functions
function makeNode(
  id: number,
  type: number,
  name: string,
  props: NodeProperties = {},
  extras?: Partial<Pick<NodeRecord, 'createdAt' | 'degree' | 'mvccVersion'>>,
): NodeRecord {
  return { id, type, name, props, ...extras }
}

function makeEdge(
  src: number,
  dst: number,
  type: number,
  props: NodeProperties = {},
  timestamp?: number,
): EdgeRecord {
  return { src, dst, type, props, timestamp }
}

// ──────────────────────────────────────────
// Tests
// ──────────────────────────────────────────

describe('NodeRecord — Construction Patterns', () => {
  it('GAP-14-1: factory function creates valid NodeRecord', () => {
    const node = makeNode(1, 1, 'test')
    expect(node.id).toBe(1)
    expect(node.type).toBe(1)
    expect(node.name).toBe('test')
    expect(node.props).toEqual({})
  })

  it('GAP-14-2: factory with all optional fields', () => {
    const node = makeNode(42, 2, 'alice', { role: 'admin' }, {
      createdAt: 1000,
      degree: 5,
      mvccVersion: 3,
    })
    expect(node.createdAt).toBe(1000)
    expect(node.degree).toBe(5)
    expect(node.mvccVersion).toBe(3)
    expect(node.props.role).toBe('admin')
  })

  it('GAP-14-3: spread operator copy creates independent object', () => {
    const original = makeNode(1, 1, 'original', { color: 'red' })
    const copy = { ...original, props: { ...original.props } }
    copy.props.color = 'blue'
    expect(original.props.color).toBe('red') // Unchanged
    expect(copy.props.color).toBe('blue')
  })

  it('GAP-14-4: deep copy via JSON round-trip', () => {
    const original = makeNode(1, 2, 'deep', { nested: { key: 'value', arr: [1, 2, 3] } } as unknown as NodeProperties, {
      createdAt: 500,
      degree: 10,
    })
    const copy = cloneNode(original)
    expect(compareNode(original, copy)).toBe(true)

    // Modify copy — original should be unchanged
    const nestedCopy = copy.props.nested as unknown as Record<string, any>
    nestedCopy.key = 'changed'
    expect((original.props.nested as unknown as Record<string, any>).key).toBe('value')
  })

  it('GAP-14-5: multiple nodes with shared structure', () => {
    const nodes: NodeRecord[] = [
      makeNode(1, 1, 'a', { group: 'x' }),
      makeNode(2, 1, 'b', { group: 'x' }),
      makeNode(3, 2, 'c', { group: 'y' }),
    ]
    expect(nodes.filter(n => n.props.group === 'x')).toHaveLength(2)
    expect(nodes.filter(n => n.type === 1)).toHaveLength(2)
  })
})

describe('NodeRecord — Property Combinations', () => {
  it('GAP-14-6: node with empty string name', () => {
    const node = makeNode(1, 1, '')
    expect(node.name).toBe('')
  })

  it('GAP-14-7: node with very long name', () => {
    const longName = 'x'.repeat(1000)
    const node = makeNode(1, 1, longName)
    expect(node.name.length).toBe(1000)
  })

  it('GAP-14-8: node with nested property objects', () => {
    const node = makeNode(1, 1, 'nested', {
      level1: {
        level2: {
          level3: 'deep',
          numbers: [1, 2, 3],
        },
        flag: true,
      },
      simple: 'value',
    } as unknown as NodeProperties)
    expect((node.props.level1 as unknown as any).level2.level3).toBe('deep')
    expect((node.props.level1 as unknown as any).level2.numbers[1]).toBe(2)
  })

  it('GAP-14-9: node with array properties', () => {
    const node = makeNode(1, 1, 'array-props', {
      tags: ['important', 'urgent', 'new'],
      scores: [98.5, 76.3, 88.1],
      matrix: [[1, 0], [0, 1]],
    } as unknown as NodeProperties)
    expect(node.props.tags).toHaveLength(3)
    expect((node.props.scores as number[])[0]).toBe(98.5)
    expect((node.props.matrix as unknown as number[][])[1][0]).toBe(0)
  })

  it('GAP-14-10: node with numeric properties including zero and negative', () => {
    const node = makeNode(1, 1, 'numbers', {
      zero: 0,
      negative: -42,
      float: 3.14159,
      bigInt: 9007199254740991,
    })
    expect(node.props.zero).toBe(0)
    expect(node.props.negative).toBe(-42)
    expect(node.props.float).toBeCloseTo(3.14159, 3)
  })

  it('GAP-14-11: node with boolean properties', () => {
    const node = makeNode(1, 1, 'bools', {
      isActive: true,
      isDeleted: false,
      isNull: null,
    })
    expect(node.props.isActive).toBe(true)
    expect(node.props.isDeleted).toBe(false)
    expect(node.props.isNull).toBeNull()
  })

  it('GAP-14-12: node with mixed property types', () => {
    const node = makeNode(1, 1, 'mixed', {
      str: 'hello',
      num: 42,
      bool: false,
      nil: null,
      arr: [1, 'two', true, null],
      obj: { a: 1 },
    } as unknown as NodeProperties)
    expect(typeof node.props.str).toBe('string')
    expect(typeof node.props.num).toBe('number')
    expect(typeof node.props.bool).toBe('boolean')
    expect(node.props.nil).toBeNull()
    expect(Array.isArray(node.props.arr)).toBe(true)
  })

  it('GAP-14-13: node with empty props', () => {
    const node = makeNode(1, 1, 'empty')
    expect(Object.keys(node.props)).toHaveLength(0)
  })

  it('GAP-14-14: node with single property', () => {
    const node = makeNode(1, 1, 'single', { key: 'value' })
    expect(Object.keys(node.props)).toEqual(['key'])
  })
})

describe('NodeRecord — Type and ID Variations', () => {
  it('GAP-14-15: node with zero ID', () => {
    const node = makeNode(0, 1, 'zero-id')
    expect(node.id).toBe(0)
  })

  it('GAP-14-16: node with negative ID', () => {
    const node = makeNode(-1, 1, 'negative-id')
    expect(node.id).toBe(-1)
  })

  it('GAP-14-17: node with high type value', () => {
    const node = makeNode(1, 9999, 'high-type')
    expect(node.type).toBe(9999)
  })

  it('GAP-14-18: node with zero type', () => {
    const node = makeNode(1, 0, 'zero-type')
    expect(node.type).toBe(0)
  })

  it('GAP-14-19: nodes with same id but different type are different records', () => {
    const n1 = makeNode(1, 1, 'same')
    const n2 = makeNode(1, 2, 'same')
    expect(compareNode(n1, n2)).toBe(false)
  })
})

describe('NodeRecord — Mutability Semantics', () => {
  it('GAP-14-20: node props are mutable after creation', () => {
    const node = makeNode(1, 1, 'mutable', { oldKey: 'oldVal' })
    node.props.newKey = 'newVal'
    node.props.oldKey = 'updated'
    expect(node.props.newKey).toBe('newVal')
    expect(node.props.oldKey).toBe('updated')
  })

  it('GAP-14-21: delete property from node', () => {
    const node = makeNode(1, 1, 'delete-prop', { a: 1, b: 2 })
    delete node.props.a
    expect(node.props.a).toBeUndefined()
    expect(node.props.b).toBe(2)
  })
})

describe('EdgeRecord — Construction Patterns', () => {
  it('GAP-14-22: factory function creates valid EdgeRecord', () => {
    const edge = makeEdge(1, 2, 10)
    expect(edge.src).toBe(1)
    expect(edge.dst).toBe(2)
    expect(edge.type).toBe(10)
    expect(edge.props).toEqual({})
  })

  it('GAP-14-23: factory with timestamp', () => {
    const ts = Date.now()
    const edge = makeEdge(1, 2, 10, { weight: '0.5' }, ts)
    expect(edge.timestamp).toBe(ts)
    expect(edge.props.weight).toBe('0.5')
  })

  it('GAP-14-24: spread operator copy of EdgeRecord', () => {
    const original = makeEdge(1, 2, 10, { label: 'knows' }, 1000)
    const copy = { ...original, props: { ...original.props } }
    copy.props.label = 'changed'
    expect(original.props.label).toBe('knows')
  })

  it('GAP-14-25: deep copy of EdgeRecord via JSON', () => {
    const original = makeEdge(1, 2, 10, { meta: { source: 'test' } } as unknown as NodeProperties, 500)
    const copy = cloneEdge(original)
    expect(compareEdge(original, copy)).toBe(true)

    const metaCopy = copy.props.meta as unknown as Record<string, any>
    metaCopy.source = 'modified'
    expect((original.props.meta as unknown as Record<string, any>).source).toBe('test')
  })
})

describe('EdgeRecord — Source/Destination Variations', () => {
  it('GAP-14-26: edge with same source and destination (self-loop)', () => {
    const edge = makeEdge(1, 1, 10)
    expect(edge.src).toBe(edge.dst)
  })

  it('GAP-14-27: edge with zero IDs', () => {
    const edge = makeEdge(0, 0, 10)
    expect(edge.src).toBe(0)
    expect(edge.dst).toBe(0)
  })

  it('GAP-14-28: edge with negative IDs', () => {
    const edge = makeEdge(-1, -2, 10)
    expect(edge.src).toBe(-1)
    expect(edge.dst).toBe(-2)
  })

  it('GAP-14-29: edge with high type value', () => {
    const edge = makeEdge(1, 2, 9999)
    expect(edge.type).toBe(9999)
  })

  it('GAP-14-30: edge with zero type', () => {
    const edge = makeEdge(1, 2, 0)
    expect(edge.type).toBe(0)
  })

  it('GAP-14-31: edge with various properties', () => {
    const edge = makeEdge(1, 2, 10, {
      weight: 0.85,
      directed: true,
      label: 'follows',
      metadata: { created: '2024-01-01', source: 'import' },
    } as unknown as NodeProperties)
    expect(edge.props.directed).toBe(true)
    expect(edge.props.weight).toBe(0.85)
  })
})

describe('EdgeRecord — Timestamp Variations', () => {
  it('GAP-14-32: edge with zero timestamp', () => {
    const edge = makeEdge(1, 2, 10, {}, 0)
    expect(edge.timestamp).toBe(0)
  })

  it('GAP-14-33: edge with negative timestamp', () => {
    const edge = makeEdge(1, 2, 10, {}, -1000)
    expect(edge.timestamp).toBe(-1000)
  })

  it('GAP-14-34: edge without timestamp', () => {
    const edge = makeEdge(1, 2, 10)
    expect(edge.timestamp).toBeUndefined()
  })

  it('GAP-14-35: edge with future timestamp', () => {
    const futureTs = Date.now() + 86400000 // 1 day in future
    const edge = makeEdge(1, 2, 10, {}, futureTs)
    expect(edge.timestamp).toBe(futureTs)
  })
})

describe('NodeRecord / EdgeRecord — Comparison Logic', () => {
  it('GAP-14-36: compareNode with identical nodes returns true', () => {
    const a = makeNode(1, 1, 'same', { value: 1 })
    const b = cloneNode(a)
    expect(compareNode(a, b)).toBe(true)
  })

  it('GAP-14-37: compareNode with different id returns false', () => {
    const a = makeNode(1, 1, 'x')
    const b = makeNode(2, 1, 'x')
    expect(compareNode(a, b)).toBe(false)
  })

  it('GAP-14-38: compareNode with different props returns false', () => {
    const a = makeNode(1, 1, 'x', { value: 1 })
    const b = makeNode(1, 1, 'x', { value: 2 })
    expect(compareNode(a, b)).toBe(false)
  })

  it('GAP-14-39: compareEdge with identical edges returns true', () => {
    const a = makeEdge(1, 2, 10, { weight: 1 })
    const b = cloneEdge(a)
    expect(compareEdge(a, b)).toBe(true)
  })

  it('GAP-14-40: compareEdge with different src returns false', () => {
    const a = makeEdge(1, 2, 10)
    const b = makeEdge(3, 2, 10)
    expect(compareEdge(a, b)).toBe(false)
  })

  it('GAP-14-41: compareEdge with different dst returns false', () => {
    const a = makeEdge(1, 2, 10)
    const b = makeEdge(1, 3, 10)
    expect(compareEdge(a, b)).toBe(false)
  })
})

describe('NodeRecord — createdAt / degree / mvccVersion Edge Cases', () => {
  it('GAP-14-42: createdAt values near epoch', () => {
    const node = makeNode(1, 1, 'epoch', {}, { createdAt: 0 })
    expect(node.createdAt).toBe(0)
  })

  it('GAP-14-43: degree can be zero', () => {
    const node = makeNode(1, 1, 'isolated', {}, { degree: 0 })
    expect(node.degree).toBe(0)
  })

  it('GAP-14-44: degree with large value', () => {
    const node = makeNode(1, 1, 'hub', {}, { degree: 1000000 })
    expect(node.degree).toBe(1000000)
  })

  it('GAP-14-45: mvccVersion with zero', () => {
    const node = makeNode(1, 1, 'v0', {}, { mvccVersion: 0 })
    expect(node.mvccVersion).toBe(0)
  })

  it('GAP-14-46: all optional fields undefined', () => {
    const node = makeNode(1, 1, 'naked')
    expect(node.createdAt).toBeUndefined()
    expect(node.degree).toBeUndefined()
    expect(node.mvccVersion).toBeUndefined()
  })
})

describe('NodeRecord / EdgeRecord — Large Batch Construction', () => {
  it('GAP-14-47: create 1000 NodeRecords', () => {
    const nodes: NodeRecord[] = []
    for (let i = 0; i < 1000; i++) {
      nodes.push(makeNode(i, 1, `node-${i}`, { index: i }))
    }
    expect(nodes).toHaveLength(1000)
    expect(nodes[500].name).toBe('node-500')
    expect(nodes[500].props.index).toBe(500)
  })

  it('GAP-14-48: create 1000 EdgeRecords', () => {
    const edges: EdgeRecord[] = []
    for (let i = 0; i < 1000; i++) {
      edges.push(makeEdge(i, i + 1, 10, { seq: i }))
    }
    expect(edges).toHaveLength(1000)
    expect(edges[0].src).toBe(0)
    expect(edges[999].dst).toBe(1000)
  })

  it('GAP-14-49: batch convert arrays to objects', () => {
    const rawNodes = [
      [1, 1, 'n1', { color: 'red' }] as const,
      [2, 2, 'n2', { color: 'blue' }] as const,
      [3, 1, 'n3', { color: 'green' }] as const,
    ]
    const nodes: NodeRecord[] = rawNodes.map(
      ([id, type, name, props]) => makeNode(id, type, name, props),
    )
    expect(nodes).toHaveLength(3)
    expect(nodes.filter(n => n.type === 1)).toHaveLength(2)
  })
})

describe('NodeProperties — Special Values', () => {
  it('GAP-14-50: properties with special characters in keys', () => {
    const props: NodeProperties = {
      'normal-key': 'value',
      'key.with.dots': 1,
      'key_with_underscores': true,
      '123numeric': 'start',
      '': 'empty-key',
    }
    expect(props['key.with.dots']).toBe(1)
  })

  it('GAP-14-51: properties with mixed depth', () => {
    const props: Record<string, unknown> = {
      shallow: 'value',
      deep: { deeper: { deepest: 'found' } },
      mixed: [{ a: 1 }, { b: 2 }],
    }
    expect((props.deep as unknown as any).deeper.deepest).toBe('found')
    expect((props.mixed as Array<{ a?: number; b?: number }>)[1].b).toBe(2)
  })

  it('GAP-14-52: properties with undefined value is valid', () => {
    const props: Record<string, unknown> = {
      defined: 'exists',
      missing: undefined,
    }
    expect(props.defined).toBe('exists')
    expect(props.missing).toBeUndefined()
  })

  it('GAP-14-53: properties with symbol-like keys (as strings)', () => {
    const props: NodeProperties = {
      '@special': true,
      '#tag': 'important',
      '$value': 100,
    }
    expect(props['@special']).toBe(true)
  })
})
