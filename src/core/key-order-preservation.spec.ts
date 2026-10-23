// ============================================================
// key-order-preservation.spec.ts — Property key-order persistence
//
// Regression tests for the non-deterministic property key-order bug.
//
// Root cause: OverGraph (Rust) stores node/edge props as a HashMap; after
// flush/reopen the key order is lost. The fix serializes props as a single
// msgpack blob (under the `__c` key) so Rust cannot reorder individual keys,
// preserving the caller's insertion order across persistence.
//
// These tests assert that:
//   1. Insertion order survives a close → reopen cycle (the exact bug).
//   2. Order is deterministic across multiple reopens (no flakiness).
//   3. Order is preserved for nodes AND edges, and for mixed value types.
//   4. The explicit `compressionStrategy: 'none'` opt-out still functions.
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OverGraphStorage } from './overgraph-storage'
import type { NodeProperties } from '../types'
import * as fs from 'fs'

const TEST_DIR = '/tmp/og-keyorder-test'

describe('Property key-order preservation', () => {
  beforeAll(() => {
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* ok */ }
    fs.mkdirSync(TEST_DIR, { recursive: true })
  })

  afterAll(() => {
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* ok */ }
  })

  function writeNode(path: string, props: NodeProperties): number {
    const s = new OverGraphStorage()
    s.open({ path })
    const id = s.upsertNode(1, 'n0', { props })
    s.close()
    return id
  }

  function readNodeProps(path: string, id: number): Record<string, unknown> | undefined {
    const s = new OverGraphStorage()
    s.open({ path })
    const node = s.getNode(id, true)
    s.close()
    return node?.props
  }

  it('preserves non-alphabetical insertion order across reopen', () => {
    // Deliberately non-alphabetical: 'name' < 'id' alphabetically, but here
    // 'id' would sort before 'name'. Insertion order is name,num,id.
    const path = TEST_DIR + '/order-nonalpha'
    const props = { name: 'A', num: 0, id: 0 }
    writeNode(path, props)

    const read = readNodeProps(path, 1)
    expect(read).toBeDefined()
    expect(Object.keys(read!)).toEqual(['name', 'num', 'id'])
    // Values must round-trip intact
    expect(read!.name).toBe('A')
    expect(read!.num).toBe(0)
    expect(read!.id).toBe(0)
  })

  it('is deterministic across repeated reopens (no flakiness)', () => {
    const path = TEST_DIR + '/order-deterministic'
    const props = { zeta: 1, alpha: 'x', mid: true, beta: null }
    writeNode(path, props)

    // Read 5 times through fresh storage instances; order must be identical.
    const first = Object.keys(readNodeProps(path, 1)!)
    expect(first).toEqual(['zeta', 'alpha', 'mid', 'beta'])
    for (let i = 0; i < 5; i++) {
      expect(Object.keys(readNodeProps(path, 1)!)).toEqual(first)
    }
  })

  it('preserves edge property order across reopen', () => {
    const path = TEST_DIR + '/order-edge'
    const s = new OverGraphStorage()
    s.open({ path })
    const src = s.upsertNode(1, 'src', { props: { a: 1 } })
    const dst = s.upsertNode(1, 'dst', { props: { b: 2 } })
    s.upsertEdge(src, dst, 7, { props: { weight: 3.5, since: '2020', active: true } })
    s.close()

    const s2 = new OverGraphStorage()
    s2.open({ path })
    const edge = s2.getEdge(src, dst, 7)
    s2.close()

    expect(edge).not.toBeNull()
    expect(Object.keys(edge!.props || {})).toEqual(['weight', 'since', 'active'])
  })

  it('round-trips mixed value types with order intact', () => {
    const path = TEST_DIR + '/order-mixed'
    const nested = { inner: [1, 2, 3] }
    const props = {
      str: 'hello',
      num: 42,
      big: 9007199254740993n,
      bool: false,
      nil: null,
      arr: [1, 'two', true],
      obj: nested,
    } as unknown as NodeProperties
    writeNode(path, props)

    const read = readNodeProps(path, 1)
    expect(Object.keys(read!)).toEqual(['str', 'num', 'big', 'bool', 'nil', 'arr', 'obj'])
    expect(read!.str).toBe('hello')
    expect(read!.num).toBe(42)
    expect(read!.bool).toBe(false)
    expect(read!.nil).toBeNull()
    expect(Array.isArray(read!.arr)).toBe(true)
    expect((read!.obj as any).inner).toEqual([1, 2, 3])
  })

  it('still functions with explicit compressionStrategy: none opt-out', () => {
    const path = TEST_DIR + '/order-none'
    const s = new OverGraphStorage()
    s.open({ path, compressionStrategy: 'none' })
    s.upsertNode(1, 'n0', { props: { b: 1, a: 2 } })
    s.close()

    const s2 = new OverGraphStorage()
    s2.open({ path, compressionStrategy: 'none' })
    const node = s2.getNode(1, true)
    s2.close()

    // Bare JSON path still returns the props (values correct); key order is
    // explicitly not guaranteed in this opt-out mode, so we only assert values.
    expect(node).not.toBeNull()
    expect(node!.props!.a).toBe(2)
    expect(node!.props!.b).toBe(1)
  })

  it('keeps compress:true backward-compatible', () => {
    const path = TEST_DIR + '/order-compress'
    const s = new OverGraphStorage()
    s.open({ path, compress: true })
    s.upsertNode(1, 'n0', { props: { first: 1, second: 2, third: 3 } })
    s.close()

    const read = readNodeProps(path, 1)
    expect(Object.keys(read!)).toEqual(['first', 'second', 'third'])
  })
})
