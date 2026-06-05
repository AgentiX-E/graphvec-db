import { GraphEngine } from '../core/graph-engine'
import * as fs from 'fs'
import * as path from 'path'

const BASE_DIR = path.join(__dirname, '../../test-data/cluster')

function makeConfig(name: string) {
  const dir = path.join(BASE_DIR, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(dir, { recursive: true })
  return { path: dir, denseVector: { dimension: 384 } }
}

function cleanup(e: GraphEngine, config: { path: string }) {
  try { if (e.isOpen) e.close() } catch {}
  try { fs.rmSync(config.path, { recursive: true, force: true }) } catch {}
}

function cleanupE(e: GraphEngine) {
  try { if (e.isOpen) e.close() } catch {}
}

function cleanupC(c: { path: string }) {
  try { fs.rmSync(c.path, { recursive: true, force: true }) } catch {}
}

function cleanup2(e1: GraphEngine, c1: { path: string }, e2: GraphEngine, c2: { path: string }) {
  try { if (e1.isOpen) e1.close() } catch {}
  try { if (e2.isOpen) e2.close() } catch {}
  try { fs.rmSync(c1.path, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(c2.path, { recursive: true, force: true }) } catch {}
}

// ── 1. Single-Node Consistency ──
describe('Cluster Consistency — Single-Node', () => {
  test('write and immediately read back the same value', async () => {
    const config = makeConfig('writeread'); const e = new GraphEngine(config)
    try { e.open()
      const id = await e.upsertNode(1, 'alice', { props: { name: 'Alice', age: 30 } })
      const n = e.getNode(id)
      expect(n).not.toBeNull()
      expect(n!.id).toBe(id); expect(n!.name).toBe('alice')
      expect(n!.props!.name).toBe('Alice'); expect(n!.props!.age).toBe(30)
    } finally { cleanup(e, config) }
  }, 15000)

  test('correct count after batch upsert', async () => {
    const config = makeConfig('batchcnt'); const e = new GraphEngine(config)
    try { e.open()
      for (let i = 0; i < 100; i++) await e.upsertNode(1, `n-${i}`)
      expect(e.scanAllNodes().length).toBe(100)
    } finally { cleanup(e, config) }
  }, 15000)

  test('deleteNode returns null after deletion', async () => {
    const config = makeConfig('delnull'); const e = new GraphEngine(config)
    try { e.open()
      const id = await e.upsertNode(1, 'todel')
      expect(e.getNode(id)).not.toBeNull()
      await e.deleteNode(id)
      expect(e.getNode(id)).toBeNull()
    } finally { cleanup(e, config) }
  }, 15000)

  test('multiple upserts of same id converge to final', async () => {
    const config = makeConfig('converge'); const e = new GraphEngine(config)
    try { e.open()
      const id = await e.upsertNode(1, 'cv', { props: { v: 1 } })
      await e.upsertNode(id, 'cv', { props: { v: 2 } })
      await e.upsertNode(id, 'cv', { props: { v: 3 } })
      expect(e.getNode(id)!.props!.v).toBe(3)
    } finally { cleanup(e, config) }
  }, 15000)

  test('props update across upserts', async () => {
    const config = makeConfig('propup'); const e = new GraphEngine(config)
    try { e.open()
      const id = await e.upsertNode(1, 'pt', { props: { a: 1, b: 'x' } })
      await e.upsertNode(id, 'pt', { props: { a: 2, c: true } })
      expect(e.getNode(id)!.props!.a).toBe(2)
      expect(e.getNode(id)!.props!.c).toBe(true)
    } finally { cleanup(e, config) }
  }, 15000)

  test('edge write then neighbors returns correct', async () => {
    const config = makeConfig('edgenb'); const e = new GraphEngine(config)
    try { e.open()
      const a = await e.upsertNode(1, 'src'); const b = await e.upsertNode(1, 'dst')
      await e.upsertEdge(a, b, 10, { weight: 1 })
      const r = e.neighbors(a)
      expect(r.edges.length).toBe(1); expect(r.edges[0].dst).toBe(b)
      expect(r.edges[0].type).toBe(10); expect(r.nodes.length).toBe(1)
    } finally { cleanup(e, config) }
  }, 15000)

  test('deleteEdge returns true and getEdge null after', async () => {
    const config = makeConfig('edgedel'); const e = new GraphEngine(config)
    try { e.open()
      const a = await e.upsertNode(1, 'sdel'); const b = await e.upsertNode(1, 'ddel')
      await e.upsertEdge(a, b, 10)
      expect(e.getEdge(a, b, 10)).not.toBeNull()
      expect(await e.deleteEdge(a, b, 10)).toBe(true)
      expect(e.getEdge(a, b, 10)).toBeNull()
    } finally { cleanup(e, config) }
  }, 15000)

  test('pauseWrites rejects write operations', async () => {
    const config = makeConfig('pauserej'); const e = new GraphEngine(config)
    try { e.open()
      const resume = await e.pauseWrites()
      await expect(e.upsertNode(1, 'fail')).rejects.toThrow()
      resume()
    } finally { cleanup(e, config) }
  }, 15000)

  test('resume after pauseWrites allows writes again', async () => {
    const config = makeConfig('resume'); const e = new GraphEngine(config)
    try { e.open()
      const resume = await e.pauseWrites()
      await expect(e.upsertNode(1, 'blocked')).rejects.toThrow()
      resume()
      const id = await e.upsertNode(1, 'after')
      expect(e.getNode(id)).not.toBeNull()
    } finally { cleanup(e, config) }
  }, 15000)

  test('close then re-open preserves node via getNode', async () => {
    const config = makeConfig('reopen'); const e = new GraphEngine(config)
    let id = 0
    try { e.open()
      id = await e.upsertNode(1, 'persist', { props: { survive: true } })
      e.close()
    } finally { if (e.isOpen) e.close() }
    const e2 = new GraphEngine(config)
    try { e2.open()
      expect(e2.getNode(id)).not.toBeNull()
      expect(e2.getNode(id)!.props!.survive).toBe(true)
    } finally { try { if (e2.isOpen) e2.close() } catch {}; cleanupC(config) }
  }, 15000)

  test('multiple edges from same source', async () => {
    const config = makeConfig('multiedge'); const e = new GraphEngine(config)
    try { e.open()
      const src = await e.upsertNode(1, 'hub')
      for (let i = 0; i < 10; i++) {
        const t = await e.upsertNode(1, `spoke-${i}`)
        await e.upsertEdge(src, t, 10)
      }
      expect(e.neighbors(src).edges.length).toBe(10)
      expect(e.neighbors(src).nodes.length).toBe(10)
    } finally { cleanup(e, config) }
  }, 15000)

  test('neighbors returns empty for isolated node', async () => {
    const config = makeConfig('iso'); const e = new GraphEngine(config)
    try { e.open()
      const id = await e.upsertNode(1, 'alone')
      const r = e.neighbors(id)
      expect(r.edges.length).toBe(0); expect(r.nodes.length).toBe(0)
    } finally { cleanup(e, config) }
  }, 15000)

  test('upsertEdge with props and weight', async () => {
    const config = makeConfig('edgepr'); const e = new GraphEngine(config)
    try { e.open()
      const a = await e.upsertNode(1, 'ea'); const b = await e.upsertNode(1, 'eb')
      await e.upsertEdge(a, b, 20, { props: { rel: 'friend' }, weight: 0.5 })
      const eg = e.getEdge(a, b, 20)
      expect(eg).not.toBeNull(); expect(eg!.props!.rel).toBe('friend')
      expect(eg!.type).toBe(20)
    } finally { cleanup(e, config) }
  }, 15000)

  test('deleteEdge returns true then false correctly', async () => {
    const config = makeConfig('edgedelres'); const e = new GraphEngine(config)
    try { e.open()
      const a = await e.upsertNode(1, 'a'); const b = await e.upsertNode(1, 'b')
      await e.upsertEdge(a, b, 10)
      expect(await e.deleteEdge(a, b, 10)).toBe(true)
      expect(await e.deleteEdge(a, b, 10)).toBe(false)
    } finally { cleanup(e, config) }
  }, 15000)

  test('scanAllNodes returns all created nodes', async () => {
    const config = makeConfig('scan50'); const e = new GraphEngine(config)
    try { e.open()
      for (let i = 0; i < 50; i++) await e.upsertNode(1, `s-${i}`)
      expect(e.scanAllNodes().length).toBe(50)
    } finally { cleanup(e, config) }
  }, 15000)

  test('bulk edge chain neighbor verification', async () => {
    const config = makeConfig('bulkedge'); const e = new GraphEngine(config)
    try { e.open()
      const ids = await Promise.all(Array.from({length:10}, (_,i) => e.upsertNode(1, `b-${i}`)))
      for (let i = 0; i < ids.length - 1; i++) await e.upsertEdge(ids[i], ids[i+1], 10)
      expect(e.neighbors(ids[0]).edges.length).toBe(1)
      const last = ids[ids.length - 1]
      expect(e.neighbors(last).edges.length).toBe(0)
    } finally { cleanup(e, config) }
  }, 15000)

  test('pauseWrites rejects edge operations', async () => {
    const config = makeConfig('pauseedge'); const e = new GraphEngine(config)
    try { e.open()
      const a = await e.upsertNode(1, 'pza'); const b = await e.upsertNode(1, 'pzb')
      const resume = await e.pauseWrites()
      await expect(e.upsertEdge(a, b, 10)).rejects.toThrow()
      await expect(e.deleteEdge(a, b, 10)).rejects.toThrow()
      resume()
    } finally { cleanup(e, config) }
  }, 15000)

  test('pauseWrites rejects deleteNode', async () => {
    const config = makeConfig('pausedel'); const e = new GraphEngine(config)
    try { e.open()
      const id = await e.upsertNode(1, 'dx')
      const resume = await e.pauseWrites()
      await expect(e.deleteNode(id)).rejects.toThrow()
      resume()
    } finally { cleanup(e, config) }
  }, 15000)

  test('re-open restores node via getNode', async () => {
    const config = makeConfig('rreopen'); const e = new GraphEngine(config)
    const ids: number[] = []
    try { e.open()
      for (let i = 0; i < 10; i++) ids.push(await e.upsertNode(1, `r-${i}`))
      e.close()
    } finally { if (e.isOpen) e.close() }
    const e2 = new GraphEngine(config)
    try { e2.open()
      for (const id of ids) expect(e2.getNode(id)).not.toBeNull()
    } finally { try { if (e2.isOpen) e2.close() } catch {}; cleanupC(config) }
  }, 15000)

  test('re-open restores edges', async () => {
    const config = makeConfig('rreopene'); let a = 0, b = 0
    const e = new GraphEngine(config)
    try { e.open()
      a = await e.upsertNode(1, 'pa'); b = await e.upsertNode(1, 'pb')
      await e.upsertEdge(a, b, 10)
      e.close()
    } finally { if (e.isOpen) e.close() }
    const e2 = new GraphEngine(config)
    try { e2.open()
      const eg = e2.getEdge(a, b, 10)
      expect(eg).not.toBeNull(); expect(eg!.src).toBe(a); expect(eg!.dst).toBe(b); expect(eg!.type).toBe(10)
    } finally { try { if (e2.isOpen) e2.close() } catch {}; cleanupC(config) }
  }, 15000)

  test('deleteNode returns false for non-existent', async () => {
    const config = makeConfig('delnoex'); const e = new GraphEngine(config)
    try { e.open(); expect(await e.deleteNode(999999)).toBe(false) } finally { cleanup(e, config) }
  }, 15000)

  test('getNode returns null for non-existent', async () => {
    const config = makeConfig('getnoex'); const e = new GraphEngine(config)
    try { e.open(); expect(e.getNode(999999)).toBeNull() } finally { cleanup(e, config) }
  }, 15000)

  test('delete all nodes returns empty scan', async () => {
    const config = makeConfig('delall'); const e = new GraphEngine(config)
    try { e.open()
      const ids = await Promise.all(Array.from({length:10}, (_,i) => e.upsertNode(1, `d-${i}`)))
      await Promise.all(ids.map(id => e.deleteNode(id)))
      expect(e.scanAllNodes().length).toBe(0)
    } finally { cleanup(e, config) }
  }, 15000)

  test('star graph neighbor count', async () => {
    const config = makeConfig('star'); const e = new GraphEngine(config)
    try { e.open()
      const c = await e.upsertNode(1, 'center')
      for (let i = 0; i < 15; i++) {
        const l = await e.upsertNode(1, `leaf-${i}`)
        await e.upsertEdge(c, l, 10)
      }
      expect(e.neighbors(c).edges.length).toBe(15)
      expect(e.neighbors(c).nodes.length).toBe(15)
    } finally { cleanup(e, config) }
  }, 15000)

  test('multiple edge types between same nodes', async () => {
    const config = makeConfig('multitype'); const e = new GraphEngine(config)
    try { e.open()
      const a = await e.upsertNode(1, 'a'); const b = await e.upsertNode(1, 'b')
      await e.upsertEdge(a, b, 10); await e.upsertEdge(a, b, 20); await e.upsertEdge(a, b, 30)
      expect(e.neighbors(a).edges.length).toBe(3)
      expect(e.neighbors(a).edges.map(x => x.type).sort()).toEqual([10, 20, 30])
    } finally { cleanup(e, config) }
  }, 15000)

  test('delete one edge type preserves others via getEdge', async () => {
    const config = makeConfig('delonetype'); const e = new GraphEngine(config)
    try { e.open()
      const a = await e.upsertNode(1, 'a'); const b = await e.upsertNode(1, 'b')
      await e.upsertEdge(a, b, 10); await e.upsertEdge(a, b, 20)
      expect(await e.deleteEdge(a, b, 10)).toBe(true)
      expect(e.getEdge(a, b, 10)).toBeNull()
      expect(e.getEdge(a, b, 20)).not.toBeNull()
    } finally { cleanup(e, config) }
  }, 15000)

  test('same name different types are distinct', async () => {
    const config = makeConfig('nametype'); const e = new GraphEngine(config)
    try { e.open()
      await e.upsertNode(1, 'shared', { props: { t: 'A' } })
      await e.upsertNode(2, 'shared', { props: { t: 'B' } })
      expect(e.scanAllNodes().length).toBe(2)
    } finally { cleanup(e, config) }
  }, 15000)

  test('bidirectional edges each show one neighbor', async () => {
    const config = makeConfig('bidi'); const e = new GraphEngine(config)
    try { e.open()
      const a = await e.upsertNode(1, 'bidia'); const b = await e.upsertNode(1, 'bidib')
      await e.upsertEdge(a, b, 10); await e.upsertEdge(b, a, 10)
      expect(e.neighbors(a).edges.length).toBe(1); expect(e.neighbors(b).edges.length).toBe(1)
    } finally { cleanup(e, config) }
  }, 15000)

  test('node from getNode has correct id and name', async () => {
    const config = makeConfig('getidmatch'); const e = new GraphEngine(config)
    try { e.open()
      const id = await e.upsertNode(1, 'idmatch')
      const n = e.getNode(id)
      expect(n!.id).toBe(id); expect(n!.name).toBe('idmatch')
    } finally { cleanup(e, config) }
  }, 15000)

  test('deleteEdge returns false for non-existent edge', async () => {
    const config = makeConfig('delnoedge'); const e = new GraphEngine(config)
    try { e.open()
      const a = await e.upsertNode(1, 'noa'); const b = await e.upsertNode(1, 'nob')
      expect(await e.deleteEdge(a, b, 99)).toBe(false)
    } finally { cleanup(e, config) }
  }, 15000)

  test('neighbors returns nodes with correct ids', async () => {
    const config = makeConfig('nbid'); const e = new GraphEngine(config)
    try { e.open()
      const src = await e.upsertNode(1, 'nbsrc'); const dst = await e.upsertNode(1, 'nbdst')
      await e.upsertEdge(src, dst, 10)
      const r = e.neighbors(src)
      expect(r.nodes[0].id).toBe(dst)
      expect(r.nodes[0].name).toBe('nbdst')
    } finally { cleanup(e, config) }
  }, 15000)
})

// ── 2. Multi-Engine Isolation ──
describe('Cluster Consistency — Multi-Engine Isolation', () => {
  test('2 engines writing different data do not interfere', async () => {
    const c1 = makeConfig('isoa'); const c2 = makeConfig('isob')
    const e1 = new GraphEngine(c1); const e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      await e1.upsertNode(10, 'onlye1')
      await e2.upsertNode(20, 'onlye2')
      expect(e1.scanAllNodes().length).toBe(1); expect(e2.scanAllNodes().length).toBe(1)
      expect(e1.scanAllNodes()[0].name).toBe('onlye1')
      expect(e2.scanAllNodes()[0].name).toBe('onlye2')
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 15000)

  test('3 engines with same schema use distinct names', async () => {
    const cfgs = [makeConfig('tri1'), makeConfig('tri2'), makeConfig('tri3')]
    const es = cfgs.map(c => new GraphEngine(c))
    try { for (const e of es) e.open()
      for (let i = 0; i < 10; i++) {
        await es[0].upsertNode(1, `e0name-${i}`)
        await es[1].upsertNode(1, `e1name-${i}`)
        await es[2].upsertNode(1, `e2name-${i}`)
      }
      for (let i = 0; i < 3; i++) {
        expect(es[i].scanAllNodes().length).toBe(10)
        for (const n of es[i].scanAllNodes()) expect(n.name).toContain(`e${i}name-`)
      }
    } finally { for (const e of es) cleanupE(e); for (const c of cfgs) cleanupC(c) }
  }, 15000)

  test('2 engines with edges stay isolated', async () => {
    const c1 = makeConfig('edgea'); const c2 = makeConfig('edgeb')
    const e1 = new GraphEngine(c1); const e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      const a1 = await e1.upsertNode(1, 'e1a'); const b1 = await e1.upsertNode(1, 'e1b')
      await e1.upsertEdge(a1, b1, 10)
      const a2 = await e2.upsertNode(1, 'e2a'); const b2 = await e2.upsertNode(1, 'e2b')
      await e2.upsertEdge(a2, b2, 10)
      expect(e1.neighbors(a1).edges.length).toBe(1); expect(e2.neighbors(a2).edges.length).toBe(1)
      expect(e1.neighbors(a1).edges[0].dst).toBe(b1); expect(e2.neighbors(a2).edges[0].dst).toBe(b2)
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 15000)

  test('one engine bulk write 200 does not affect another', async () => {
    const c1 = makeConfig('bulka'); const c2 = makeConfig('bulkb')
    const e1 = new GraphEngine(c1); const e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      for (let i = 0; i < 200; i++) await e1.upsertNode(1, `ba-${i}`)
      expect(e1.scanAllNodes().length).toBe(200); expect(e2.scanAllNodes().length).toBe(0)
      await e2.upsertNode(1, 'lone')
      expect(e2.scanAllNodes().length).toBe(1); expect(e1.scanAllNodes().length).toBe(200)
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 30000)

  test('cross-engine reads by different path are isolated', async () => {
    const cA = makeConfig('crossa'); const cB = makeConfig('crossb')
    const eA = new GraphEngine(cA); const eB = new GraphEngine(cB)
    try { eA.open(); eB.open()
      const idA = await eA.upsertNode(10, 'alice', { props: { d: 'A' } })
      await eB.upsertNode(20, 'bob', { props: { d: 'B' } })
      expect(eA.getNode(idA)!.props!.d).toBe('A')
      expect(eA.scanAllNodes().length).toBe(1)
      expect(eA.scanAllNodes()[0].name).toBe('alice')
      expect(eB.scanAllNodes().length).toBe(1)
      expect(eB.scanAllNodes()[0].props!.d).toBe('B')
    } finally { cleanup2(eA, cA, eB, cB) }
  }, 15000)

  test('4 engines all isolated with 20 nodes each', async () => {
    const cfgs = Array.from({length:4}, (_,i) => makeConfig(`quad-${i}`))
    const es = cfgs.map(c => new GraphEngine(c))
    try {
      for (let i = 0; i < 4; i++) { es[i].open()
        for (let j = 0; j < 20; j++) await es[i].upsertNode(1, `e${i}-${j}`)
      }
      for (let i = 0; i < 4; i++) {
        expect(es[i].scanAllNodes().length).toBe(20)
        for (const n of es[i].scanAllNodes()) expect(n.name).toContain(`e${i}-`)
      }
    } finally { for (const e of es) cleanupE(e); for (const c of cfgs) cleanupC(c) }
  }, 15000)

  test('2 engines close one other still works', async () => {
    const c1 = makeConfig('close1'); const c2 = makeConfig('close2')
    const e1 = new GraphEngine(c1); const e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      await e1.upsertNode(1, 'e1n'); await e2.upsertNode(1, 'e2n')
      e1.close()
      const id2 = await e2.upsertNode(1, 'e2sec')
      expect(e2.getNode(id2)).not.toBeNull(); expect(e2.scanAllNodes().length).toBe(2)
      e1.open(); expect(e1.scanAllNodes().length).toBe(1)
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 15000)

  test('5 engines each write 10 nodes no leakage', async () => {
    const cfgs = Array.from({length:5}, (_,i) => makeConfig(`penta-${i}`))
    const es = cfgs.map(c => new GraphEngine(c))
    try {
      for (let i = 0; i < 5; i++) { es[i].open()
        for (let j = 0; j < 10; j++) await es[i].upsertNode(1, `g${i}-${j}`)
      }
      for (let i = 0; i < 5; i++) {
        expect(es[i].scanAllNodes().length).toBe(10)
        for (const n of es[i].scanAllNodes()) expect(n.name).toContain(`g${i}-`)
      }
    } finally { for (const e of es) cleanupE(e); for (const c of cfgs) cleanupC(c) }
  }, 15000)

  test('same name different engines using different types', async () => {
    const c1 = makeConfig('pata'); const c2 = makeConfig('patb')
    const e1 = new GraphEngine(c1); const e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      const id1 = await e1.upsertNode(10, 'samename', { props: { val: 1 } })
      const id2 = await e2.upsertNode(20, 'samename', { props: { val: 2 } })
      expect(e1.getNode(id1)!.props!.val).toBe(1)
      expect(e2.getNode(id2)!.props!.val).toBe(2)
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 15000)
})

// ── 3. Concurrent Consistency ──
describe('Cluster Consistency — Concurrent Operations', () => {
  test('10 concurrent writes to same id converge', async () => {
    const config = makeConfig('concid'); const e = new GraphEngine(config)
    try { e.open()
      const id = await e.upsertNode(1, 'tgt', { props: { v: 0 } })
      await Promise.all(Array.from({length:10}, (_,i) => e.upsertNode(id, 'tgt', { props: { v: i } })))
      expect(e.getNode(id)).not.toBeNull()
    } finally { cleanup(e, config) }
  }, 15000)

  test('50 concurrent writes to different ids scan correct', async () => {
    const config = makeConfig('conc50'); const e = new GraphEngine(config)
    try { e.open()
      const ids = await Promise.all(Array.from({length:50}, (_,i) => e.upsertNode(1, `c-${i}`)))
      expect(ids.length).toBe(50); expect(new Set(ids).size).toBe(50)
      expect(e.scanAllNodes().length).toBe(50)
    } finally { cleanup(e, config) }
  }, 15000)

  test('concurrent read and write on same node', async () => {
    const config = makeConfig('concrw'); const e = new GraphEngine(config)
    try { e.open()
      const id = await e.upsertNode(1, 'rw', { props: { v: 0 } })
      const ops: Promise<any>[] = []
      for (let i = 0; i < 20; i++) {
        ops.push(e.upsertNode(id, 'rw', { props: { v: i } }))
        ops.push(Promise.resolve(e.getNode(id)))
      }
      await Promise.all(ops)
      expect(e.getNode(id)).not.toBeNull()
    } finally { cleanup(e, config) }
  }, 15000)

  test('concurrent upsertEdge no data loss', async () => {
    const config = makeConfig('concedge'); const e = new GraphEngine(config)
    try { e.open()
      const ids = await Promise.all(Array.from({length:10}, (_,i) => e.upsertNode(1, `ce-${i}`)))
      await Promise.all(ids.slice(1).map(dst => e.upsertEdge(ids[0], dst, 10)))
      expect(e.neighbors(ids[0]).edges.length).toBe(9)
      expect(e.neighbors(ids[0]).nodes.length).toBe(9)
    } finally { cleanup(e, config) }
  }, 15000)

  test('concurrent edges from multiple sources', async () => {
    const config = makeConfig('concmulti'); const e = new GraphEngine(config)
    try { e.open()
      const ids = await Promise.all(Array.from({length:20}, (_,i) => e.upsertNode(1, `cm-${i}`)))
      await Promise.all(ids.map((src,i) => e.upsertEdge(src, ids[(i+1)%ids.length], 10)))
      for (const id of ids) expect(e.neighbors(id).edges.length).toBeGreaterThanOrEqual(1)
    } finally { cleanup(e, config) }
  }, 15000)

  test('concurrent delete and read same node', async () => {
    const config = makeConfig('concdel'); const e = new GraphEngine(config)
    try { e.open()
      const id = await e.upsertNode(1, 'dr')
      const results = await Promise.allSettled([
        e.deleteNode(id), e.getNode(id), e.getNode(id), e.deleteNode(id), e.getNode(id)
      ])
      expect(results.filter(r => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(3)
    } finally { cleanup(e, config) }
  }, 15000)

  test('concurrent edge creation and deletion', async () => {
    const config = makeConfig('conccrud'); const e = new GraphEngine(config)
    try { e.open()
      const a = await e.upsertNode(1, 'a'); const b = await e.upsertNode(1, 'b')
      const ops: Promise<any>[] = []
      for (let i = 0; i < 5; i++) { ops.push(e.upsertEdge(a, b, 10)); ops.push(e.deleteEdge(a, b, 10)) }
      const results = await Promise.allSettled(ops)
      expect(results.filter(r => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(5)
    } finally { cleanup(e, config) }
  }, 15000)

  test('100 concurrent inserts all unique', async () => {
    const config = makeConfig('conc100'); const e = new GraphEngine(config)
    try { e.open()
      const ids = await Promise.all(Array.from({length:100}, (_,i) => e.upsertNode(1, `c100-${i}`)))
      expect(new Set(ids).size).toBe(100); expect(e.scanAllNodes().length).toBe(100)
    } finally { cleanup(e, config) }
  }, 15000)

  test('concurrent props update same node', async () => {
    const config = makeConfig('concprop'); const e = new GraphEngine(config)
    try { e.open()
      const id = await e.upsertNode(1, 'pt', { props: { count: 0 } })
      await Promise.all(Array.from({length:20}, (_,i) => e.upsertNode(id, 'pt', { props: { count: i+1 } })))
      expect(e.getNode(id)!.props!.count).toBeGreaterThanOrEqual(1)
      expect(e.getNode(id)!.props!.count).toBeLessThanOrEqual(20)
    } finally { cleanup(e, config) }
  }, 15000)

  test('concurrent neighbor reads during writes', async () => {
    const config = makeConfig('concnbr'); const e = new GraphEngine(config)
    try { e.open()
      const ids = await Promise.all(Array.from({length:10}, (_,i) => e.upsertNode(1, `cn-${i}`)))
      await Promise.all(ids.slice(1).map(dst => e.upsertEdge(ids[0], dst, 10)))
      const reads = Array.from({length:20}, () => Promise.resolve(e.neighbors(ids[0])))
      const results = await Promise.all(reads)
      for (const r of results) expect(r.edges.length).toBe(9)
    } finally { cleanup(e, config) }
  }, 15000)
})

// ── 4. Crash Recovery Consistency ──
describe('Cluster Consistency — Crash Recovery', () => {
  test('open write close reopen node persists', async () => {
    const config = makeConfig('crcrash'); const e = new GraphEngine(config)
    let id = 0
    try { e.open()
      id = await e.upsertNode(1, 'cca', { props: { survive: true } })
      await e.upsertNode(1, 'ccb', { props: { survive: true } })
      e.close()
    } finally { if (e.isOpen) e.close() }
    const e2 = new GraphEngine(config)
    try { e2.open()
      expect(e2.getNode(id)).not.toBeNull()
      expect(e2.getNode(id)!.props!.survive).toBe(true)
    } finally { try { if (e2.isOpen) e2.close() } catch {}; cleanupC(config) }
  }, 15000)

  test('write close reopen getNode works', async () => {
    const config = makeConfig('crdirty'); let id = 0
    const e = new GraphEngine(config)
    try { e.open()
      id = await e.upsertNode(1, 'dirty', { props: { survived: true } })
      e.close()
    } finally { if (e.isOpen) e.close() }
    const e2 = new GraphEngine(config)
    try { e2.open()
      expect(e2.getNode(id)).not.toBeNull()
      expect(e2.getNode(id)!.props!.survived).toBe(true)
    } finally { try { if (e2.isOpen) e2.close() } catch {}; cleanupC(config) }
  }, 15000)

  test('pauseWrites then close reopen data exists', async () => {
    const config = makeConfig('crpause'); const e = new GraphEngine(config)
    let id = 0
    try { e.open()
      id = await e.upsertNode(1, 'psurvive')
      const resume = await e.pauseWrites()
      e.close()
      resume()
    } finally { if (e.isOpen) e.close() }
    const e2 = new GraphEngine(config)
    try { e2.open(); expect(e2.getNode(id)).not.toBeNull() }
    finally { try { if (e2.isOpen) e2.close() } catch {}; cleanupC(config) }
  }, 15000)

  test('reopen after edge write edge exists', async () => {
    const config = makeConfig('credel'); let a = 0, b = 0
    const e = new GraphEngine(config)
    try { e.open()
      a = await e.upsertNode(1, 'ea'); b = await e.upsertNode(1, 'eb')
      await e.upsertEdge(a, b, 10)
      e.close()
    } finally { if (e.isOpen) e.close() }
    const e2 = new GraphEngine(config)
    try { e2.open(); expect(e2.getEdge(a, b, 10)).not.toBeNull() }
    finally { try { if (e2.isOpen) e2.close() } catch {}; cleanupC(config) }
  }, 15000)

  test('edges and nodes both survive reopen', async () => {
    const config = makeConfig('crboth'); let a = 0, b = 0
    const e = new GraphEngine(config)
    try { e.open()
      a = await e.upsertNode(1, 'ba'); b = await e.upsertNode(1, 'bb')
      await e.upsertEdge(a, b, 10)
      e.close()
    } finally { if (e.isOpen) e.close() }
    const e2 = new GraphEngine(config)
    try { e2.open()
      expect(e2.getNode(a)).not.toBeNull(); expect(e2.getNode(b)).not.toBeNull()
      expect(e2.getEdge(a, b, 10)).not.toBeNull()
    } finally { try { if (e2.isOpen) e2.close() } catch {}; cleanupC(config) }
  }, 15000)

  test('reopen after write with props survives', async () => {
    const config = makeConfig('crprops'); let id = 0
    const e = new GraphEngine(config)
    try { e.open()
      id = await e.upsertNode(1, 'psurvive', { props: { x: 42, y: 'hello' } })
      e.close()
    } finally { if (e.isOpen) e.close() }
    const e2 = new GraphEngine(config)
    try { e2.open()
      expect(e2.getNode(id).props.x).toBe(42); expect(e2.getNode(id).props.y).toBe('hello')
    } finally { try { if (e2.isOpen) e2.close() } catch {}; cleanupC(config) }
  }, 15000)

  test('reopen delete before close persists', async () => {
    const config = makeConfig('crdelpersist'); let id = 0
    const e = new GraphEngine(config)
    try { e.open()
      id = await e.upsertNode(1, 'delme'); await e.deleteNode(id)
      e.close()
    } finally { if (e.isOpen) e.close() }
    const e2 = new GraphEngine(config)
    try { e2.open(); expect(e2.getNode(id)).toBeNull() }
    finally { try { if (e2.isOpen) e2.close() } catch {}; cleanupC(config) }
  }, 15000)

  test('reopen edge delete persists', async () => {
    const config = makeConfig('credgepersist'); let a = 0, b = 0
    const e = new GraphEngine(config)
    try { e.open()
      a = await e.upsertNode(1, 'eda'); b = await e.upsertNode(1, 'edb')
      await e.upsertEdge(a, b, 10); await e.deleteEdge(a, b, 10)
      e.close()
    } finally { if (e.isOpen) e.close() }
    const e2 = new GraphEngine(config)
    try { e2.open(); expect(e2.getEdge(a, b, 10)).toBeNull() }
    finally { try { if (e2.isOpen) e2.close() } catch {}; cleanupC(config) }
  }, 15000)

  test('reopen with multiple edges all survive', async () => {
    const config = makeConfig('crmultiedge')
    let a = 0, b = 0, c = 0
    const e = new GraphEngine(config)
    try { e.open()
      a = await e.upsertNode(1, 'ma'); b = await e.upsertNode(1, 'mb'); c = await e.upsertNode(1, 'mc')
      await e.upsertEdge(a, b, 10); await e.upsertEdge(a, c, 20)
      e.close()
    } finally { if (e.isOpen) e.close() }
    const e2 = new GraphEngine(config)
    try { e2.open()
      expect(e2.getEdge(a, b, 10)).not.toBeNull()
      expect(e2.getEdge(a, c, 20)).not.toBeNull()
      expect(e2.getNode(a)).not.toBeNull()
    } finally { try { if (e2.isOpen) e2.close() } catch {}; cleanupC(config) }
  }, 15000)

  test('reopen with node name and props intact', async () => {
    const config = makeConfig('crnameprops'); let id = 0
    const e = new GraphEngine(config)
    try { e.open()
      id = await e.upsertNode(1, 'survivor', { props: { a: 1, b: 'test' } })
      e.close()
    } finally { if (e.isOpen) e.close() }
    const e2 = new GraphEngine(config)
    try { e2.open()
      expect(e2.getNode(id).name).toBe('survivor')
      expect(e2.getNode(id).props.a).toBe(1)
    } finally { try { if (e2.isOpen) e2.close() } catch {}; cleanupC(config) }
  }, 15000)
})
