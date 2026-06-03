// Debug: 验证 overgraph 0.11.0 核心 API
import { OverGraph } from 'overgraph'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'

const dbPath = path.join(os.tmpdir(), `og-011-api-test-${Date.now()}`)

describe('0.11.0 API smoke test', () => {
  let og: OverGraph

  beforeAll(() => {
    fs.mkdirSync(dbPath, { recursive: true })
    og = OverGraph.open(dbPath, { createIfMissing: true })
  })

  afterAll(() => {
    og.close()
    fs.rmSync(dbPath, { recursive: true, force: true })
  })

  it('upsertNode with labels+key', () => {
    const id = og.upsertNode('User', 'alice', { props: { color: 'red' } })
    expect(typeof id).toBe('number')
    expect(id).toBeGreaterThan(0)
  })

  it('getNode returns labels[] and key', () => {
    const id = og.upsertNode(['Admin', 'User'], 'bob', { props: { role: 'admin' } })
    const node = og.getNode(id)
    expect(node).not.toBeNull()
    // labels may be string[] or Float64Array; check it has both values
    expect(Array.from(node!.labels as any)).toContain('Admin')
    expect(Array.from(node!.labels as any)).toContain('User')
    expect(node!.key).toBe('bob')
    expect(node!.props.role).toBe('admin')
    expect(typeof node!.createdAt).toBe('number')
    expect(typeof node!.id).toBe('number')
  })

  it('upsertEdge with label string and returns edgeId', () => {
    const n1 = og.upsertNode('Person', 'p1')
    const n2 = og.upsertNode('Person', 'p2')
    const eid = og.upsertEdge(n1, n2, 'KNOWS', { props: { since: 2024 } })
    expect(typeof eid).toBe('number')
    expect(eid).toBeGreaterThan(0)
  })

  it('getEdgeByTriple works', () => {
    const n1 = og.upsertNode('Person', 'a1')
    const n2 = og.upsertNode('Person', 'a2')
    og.upsertEdge(n1, n2, 'FRIEND', { weight: 0.5 })
    const edge = og.getEdgeByTriple(n1, n2, 'FRIEND')
    expect(edge).not.toBeNull()
    expect(edge!.from).toBe(n1)
    expect(edge!.to).toBe(n2)
    expect(edge!.label).toBe('FRIEND')
    expect(edge!.weight).toBe(0.5)
    expect(typeof edge!.createdAt).toBe('number')
  })

  it('neighbors returns label (string) not typeId', () => {
    const n1 = og.upsertNode('Person', 'x1')
    const n2 = og.upsertNode('Person', 'x2')
    og.upsertEdge(n1, n2, 'FRIEND')
    const nbrs = og.neighbors(n1)
    expect(nbrs.length).toBe(1)
    expect(nbrs[0].nodeId).toBe(n2)
    expect(nbrs[0].label).toBe('FRIEND')
    expect(typeof nbrs[0].edgeId).toBe('number')
    expect(typeof nbrs[0].weight).toBe('number')
  })

  it('deleteEdge by edgeId', () => {
    const n1 = og.upsertNode('Person', 'y1')
    const n2 = og.upsertNode('Person', 'y2')
    const eid = og.upsertEdge(n1, n2, 'FRIEND')
    og.deleteEdge(eid)
    const edge = og.getEdgeByTriple(n1, n2, 'FRIEND')
    expect(edge).toBeNull()
  })

  it('degree returns total count', () => {
    const n1 = og.upsertNode('Person', 'z1')
    const n2 = og.upsertNode('Person', 'z2')
    og.upsertEdge(n1, n2, 'FRIEND')
    const deg = og.degree(n1)
    expect(typeof deg).toBe('number')
    expect(deg).toBeGreaterThanOrEqual(1)
  })

  it('degrees batch returns entries', () => {
    const n1 = og.upsertNode('Person', 'd1')
    const n2 = og.upsertNode('Person', 'd2')
    og.upsertEdge(n1, n2, 'FRIEND')
    const entries = og.degrees([n1, n2, 999999])
    // degrees only returns entries with nonzero degree
    expect(entries.length).toBeGreaterThanOrEqual(1)
    const n1Entry = entries.find(e => e.nodeId === n1)
    const n2Entry = entries.find(e => e.nodeId === n2)
    if (n1Entry) expect(n1Entry.degree).toBeGreaterThanOrEqual(1)
    if (n2Entry) expect(n2Entry.degree).toBeGreaterThanOrEqual(1)
  })
})
