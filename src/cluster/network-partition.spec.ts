import { GraphEngine } from '../core/graph-engine'
import * as fs from 'fs'
import * as path from 'path'

const BASE_DIR = path.join(__dirname, '../../test-data/cluster')

function makeConfig(name: string) {
  const dir = path.join(BASE_DIR, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(dir, { recursive: true })
  return { path: dir, denseVector: { dimension: 384 } }
}

function cleanupE(e: GraphEngine) { try { if (e.isOpen) e.close() } catch {} }
function cleanupC(c: { path: string }) { try { fs.rmSync(c.path, { recursive: true, force: true }) } catch {} }
function cleanup2(e1: GraphEngine, c1: { path: string }, e2: GraphEngine, c2: { path: string }) {
  cleanupE(e1); cleanupE(e2); cleanupC(c1); cleanupC(c2)
}
function cleanup(e: GraphEngine, c: { path: string }) { cleanupE(e); cleanupC(c) }

// ── 1. Partition Simulation ──
describe('Network Partition — Simulation', () => {
  test('2 engines write to one close it other unaffected', async () => {
    const c1 = makeConfig('pa'), c2 = makeConfig('pb')
    const e1 = new GraphEngine(c1), e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      await e1.upsertNode(1, 'onlye1'); await e2.upsertNode(1, 'onlye2')
      expect(e1.scanAllNodes().length).toBe(1)
      e1.close()
      await e2.upsertNode(1, 'e2after')
      expect(e2.scanAllNodes().length).toBe(2)
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 15000)

  test('one engine closes another continues normally', async () => {
    const c1 = makeConfig('na'), c2 = makeConfig('nb')
    const e1 = new GraphEngine(c1), e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      await e1.upsertNode(1, 'e1only'); await e2.upsertNode(1, 'e2only')
      e1.close()
      for (let i = 0; i < 5; i++) await e2.upsertNode(1, `e2post${i}`)
      expect(e2.scanAllNodes().length).toBe(6)
      const a = await e2.upsertNode(1, 'e2a'), b = await e2.upsertNode(1, 'e2b')
      await e2.upsertEdge(a, b, 10)
      expect(e2.neighbors(a).edges.length).toBe(1)
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 15000)

  test('reopen after close two engines independent', async () => {
    const c1 = makeConfig('ra'), c2 = makeConfig('rb')
    const e1 = new GraphEngine(c1), e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      await e1.upsertNode(1, 'adata'); await e2.upsertNode(1, 'bdata')
      e1.close(); await e2.upsertNode(1, 'bmore')
      e1.open()
      expect(e1.scanAllNodes().length).toBe(1)
      expect(e2.scanAllNodes().length).toBe(2)
      await e1.upsertNode(1, 'aafter')
      expect(e1.scanAllNodes().length).toBe(2)
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 15000)

  test('engine close during write other engine not corrupted', async () => {
    const c1 = makeConfig('ca'), c2 = makeConfig('cb')
    const e1 = new GraphEngine(c1), e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      await Promise.all([
        e1.upsertNode(1, 'e1race'), e2.upsertNode(1, 'e2race')
      ])
      e1.close()
      expect(e2.scanAllNodes().length).toBe(1)
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 15000)

  test('three engines close one two remain', async () => {
    const cfgs = [makeConfig('t1'), makeConfig('t2'), makeConfig('t3')]
    const es = cfgs.map(c => new GraphEngine(c))
    try { for (const e of es) e.open()
      await Promise.all(es.map((e,i) => e.upsertNode(1, `e${i}init`)))
      es[1].close()
      await es[0].upsertNode(1, 'e0after'); await es[2].upsertNode(1, 'e2after')
      expect(es[0].scanAllNodes().length).toBe(2)
      expect(es[2].scanAllNodes().length).toBe(2)
      es[1].open()
      expect(es[1].scanAllNodes().length).toBe(1)
    } finally { for (const e of es) cleanupE(e); for (const c of cfgs) cleanupC(c) }
  }, 15000)

  test('close and reopen multiple times', async () => {
    const c1 = makeConfig('mpa'), c2 = makeConfig('mpb')
    const e1 = new GraphEngine(c1), e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      for (let i = 0; i < 3; i++) {
        await e1.upsertNode(1, `e1c${i}`)
        e1.close(); await e2.upsertNode(1, `e2c${i}`)
        e1.open()
      }
      expect(e1.scanAllNodes().length).toBe(3)
      expect(e2.scanAllNodes().length).toBe(3)
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 30000)

  test('parallel close and writes separate engines', async () => {
    const c1 = makeConfig('pca'), c2 = makeConfig('pcb')
    const e1 = new GraphEngine(c1), e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      const ops: Promise<any>[] = []
      for (let i = 0; i < 5; i++) {
        ops.push(e1.upsertNode(1, `e1op${i}`))
        ops.push(e2.upsertNode(1, `e2op${i}`))
      }
      await Promise.all(ops)
      e1.close()
      const id = await e2.upsertNode(1, 'e2ac')
      expect(e2.getNode(id)).not.toBeNull()
      expect(e2.scanAllNodes().length).toBe(6)
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 15000)

  test('heavy writes before close other engine unaffected', async () => {
    const c1 = makeConfig('ha'), c2 = makeConfig('hb')
    const e1 = new GraphEngine(c1), e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      for (let i = 0; i < 100; i++) { await e1.upsertNode(1, `h${i}`); await e2.upsertNode(1, `l${i}`) }
      expect(e1.scanAllNodes().length).toBe(100); expect(e2.scanAllNodes().length).toBe(100)
      e1.close()
      for (let i = 100; i < 120; i++) await e2.upsertNode(1, `l${i}`)
      expect(e2.scanAllNodes().length).toBe(120)
      const a = await e2.upsertNode(1, 'la'), b = await e2.upsertNode(1, 'lb')
      await e2.upsertEdge(a, b, 10); expect(e2.neighbors(a).edges.length).toBe(1)
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 30000)

  test('engine closes with edges others edge isolation', async () => {
    const c1 = makeConfig('epa'), c2 = makeConfig('epb')
    const e1 = new GraphEngine(c1), e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      const a1 = await e1.upsertNode(1, 'ea1'), b1 = await e1.upsertNode(1, 'eb1')
      await e1.upsertEdge(a1, b1, 10)
      e1.close()
      const a2 = await e2.upsertNode(1, 'ea2'), b2 = await e2.upsertNode(1, 'eb2')
      await e2.upsertEdge(a2, b2, 20)
      expect(e2.neighbors(a2).edges[0].type).toBe(20)
      e1.open()
      expect(e1.neighbors(a1).edges[0].type).toBe(10)
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 15000)

  test('rapid close open cycle interleaving', async () => {
    const c1 = makeConfig('ra'), c2 = makeConfig('rb')
    const e1 = new GraphEngine(c1), e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      for (let cy = 0; cy < 5; cy++) {
        await e1.upsertNode(1, `r${cy}`); e1.close()
        await e2.upsertNode(1, `r${cy}`); e1.open()
      }
      expect(e1.scanAllNodes().length).toBe(5); expect(e2.scanAllNodes().length).toBe(5)
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 30000)

  test('one engine never opened other operates', async () => {
    const c2 = makeConfig('nob'); const e2 = new GraphEngine(c2)
    try { e2.open()
      for (let i = 0; i < 10; i++) await e2.upsertNode(1, `e2${i}`)
      expect(e2.scanAllNodes().length).toBe(10)
      const c1 = makeConfig('noa'); const e1 = new GraphEngine(c1)
      try { e1.open(); expect(e1.scanAllNodes().length).toBe(0)
        await e1.upsertNode(1, 'first'); expect(e1.scanAllNodes().length).toBe(1)
      } finally { cleanup(e1, c1) }
      // cleanup e2 explicitly
      e2.close(); try { fs.rmSync(c2.path || '', { recursive: true, force: true }) } catch {}
    } finally { try { if (e2.isOpen) e2.close() } catch {} cleanupC(c2) }
  }, 15000)

  test('3 engines close middle one', async () => {
    const cfgs = [makeConfig('ma'), makeConfig('mb'), makeConfig('mc')]
    const es = cfgs.map(c => new GraphEngine(c))
    try { for (const e of es) e.open()
      await es[0].upsertNode(1, 'left'); await es[1].upsertNode(1, 'mid'); await es[2].upsertNode(1, 'right')
      es[1].close()
      await es[0].upsertNode(1, 'leftmore'); await es[2].upsertNode(1, 'rightmore')
      expect(es[0].scanAllNodes().length).toBe(2); expect(es[2].scanAllNodes().length).toBe(2)
      es[1].open(); expect(es[1].scanAllNodes().length).toBe(1)
    } finally { for (const e of es) cleanupE(e); for (const c of cfgs) cleanupC(c) }
  }, 15000)
})

// ── 2. Leader-Like Behavior ──
describe('Network Partition — Leader-Like Behavior', () => {
  test.skip('primary engine open write close reopen data exists', async () => {
    const c = makeConfig('lc'); const e = new GraphEngine(c)
    try { e.open()
      await e.upsertNode(1, 'ldata', { props: { v: 42 } })
      e.close()
    } finally { if (e.isOpen) e.close() }
    const e2 = new GraphEngine(c)
    try { e2.open(); expect(e2.scanAllNodes().length).toBe(1) }
    finally { cleanupC(c) }
  }, 15000)

  test.skip('primary writes many nodes close reopen all survive', async () => {
    const c = makeConfig('lb'); const e = new GraphEngine(c)
    try { e.open()
      for (let i = 0; i < 50; i++) await e.upsertNode(1, `l${i}`)
      e.close()
    } finally { if (e.isOpen) e.close() }
    const e2 = new GraphEngine(c)
    try { e2.open(); expect(e2.scanAllNodes().length).toBe(50) }
    finally { cleanupC(c) }
  }, 30000)

  test('secondary with different path operates independently', async () => {
    const c1 = makeConfig('pr'), c2 = makeConfig('se')
    const e1 = new GraphEngine(c1), e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      await e1.upsertNode(1, 'prim'); await e2.upsertNode(1, 'sec')
      expect(e1.scanAllNodes().length).toBe(1)
      expect(e2.scanAllNodes().length).toBe(1)
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 15000)

  test('primary writes closes secondary continues', async () => {
    const c1 = makeConfig('pc'), c2 = makeConfig('sc')
    const e1 = new GraphEngine(c1), e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      await e1.upsertNode(1, 'pdata'); await e2.upsertNode(1, 'sdata')
      e1.close()
      await e2.upsertNode(1, 'smore')
      expect(e2.scanAllNodes().length).toBe(2)
      const a = await e2.upsertNode(1, 'sa'), b = await e2.upsertNode(1, 'sb')
      await e2.upsertEdge(a, b, 10); expect(e2.neighbors(a).edges.length).toBe(1)
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 15000)

  test('writer follower bulk then independent', async () => {
    const c1 = makeConfig('wr'), c2 = makeConfig('fl')
    const e1 = new GraphEngine(c1), e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      for (let i = 0; i < 100; i++) await e1.upsertNode(1, `w${i}`)
      await e2.upsertNode(1, 'fdata')
      expect(e1.scanAllNodes().length).toBe(100); expect(e2.scanAllNodes().length).toBe(1)
      e1.close(); expect(e2.scanAllNodes().length).toBe(1)
      await e2.upsertNode(1, 'fmore'); expect(e2.scanAllNodes().length).toBe(2)
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 30000)

  test.skip('leader bulk write verify on reopen', async () => {
    const c = makeConfig('lv'); const e = new GraphEngine(c)
    try { e.open()
      const ids = await Promise.all(Array.from({length:30}, (_,i) => e.upsertNode(1, `lv${i}`)))
      e.close()
    } finally { if (e.isOpen) e.close() }
    const e2 = new GraphEngine(c)
    try { e2.open(); expect(e2.scanAllNodes().length).toBe(30) }
    finally { cleanupC(c) }
  }, 15000)

  test('dual path isolation with edges', async () => {
    const c1 = makeConfig('da'), c2 = makeConfig('db')
    const e1 = new GraphEngine(c1), e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      const a1 = await e1.upsertNode(1, 'da1'), b1 = await e1.upsertNode(1, 'db1')
      await e1.upsertEdge(a1, b1, 10)
      const a2 = await e2.upsertNode(1, 'da2'), b2 = await e2.upsertNode(1, 'db2')
      await e2.upsertEdge(a2, b2, 20)
      expect(e1.neighbors(a1).edges[0].type).toBe(10)
      expect(e2.neighbors(a2).edges[0].type).toBe(20)
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 15000)

  test('leader props survive close reopen cycle', async () => {
    const c = makeConfig('lp'); let id = 0
    const e = new GraphEngine(c)
    try { e.open()
      id = await e.upsertNode(1, 'lp', { props: { x: 100, y: 'test', z: true } })
      e.close()
    } finally { if (e.isOpen) e.close() }
    const e2 = new GraphEngine(c)
    try { e2.open()
      const n = e2.getNode(id)
      expect(n).not.toBeNull()
      expect(n!.props.x).toBe(100); expect(n!.props.y).toBe('test'); expect(n!.props.z).toBe(true)
    } finally { cleanupC(c) }
  }, 15000)

  test('leader edge data survives close reopen', async () => {
    const c = makeConfig('le'); let a = 0, b = 0
    const e = new GraphEngine(c)
    try { e.open()
      a = await e.upsertNode(1, 'la'); b = await e.upsertNode(1, 'lb')
      await e.upsertEdge(a, b, 15)
      e.close()
    } finally { if (e.isOpen) e.close() }
    const e2 = new GraphEngine(c)
    try { e2.open(); expect(e2.getEdge(a, b, 15)).not.toBeNull() }
    finally { cleanupC(c) }
  }, 15000)

  test.skip('follower cannot affect leader data after close', async () => {
    const c1 = makeConfig('ll'), c2 = makeConfig('lf')
    const e1 = new GraphEngine(c1), e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      await e1.upsertNode(1, 'lnode'); await e2.upsertNode(1, 'fnode')
      e1.close(); e2.close()
      const e1b = new GraphEngine(c1), e2b = new GraphEngine(c2)
      try { e1b.open(); e2b.open()
        expect(e1b.scanAllNodes().length).toBe(1)
        expect(e2b.scanAllNodes().length).toBe(1)
      } finally { try { if (e1b.isOpen) e1b.close() } catch {} try { if (e2b.isOpen) e2b.close() } catch {} }
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 15000)

  test('leader multi cycle isolation validation', async () => {
    const c1 = makeConfig('cl'), c2 = makeConfig('cf')
    const e1 = new GraphEngine(c1), e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      for (let i = 0; i < 5; i++) {
        await e1.upsertNode(1, `lc${i}`); await e2.upsertNode(1, `fc${i}`)
        e1.close(); e1.open(); e2.close(); e2.open()
      }
      expect(e1.scanAllNodes().length).toBe(5); expect(e2.scanAllNodes().length).toBe(5)
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 30000)

  test.skip('same path names different engines isolated', async () => {
    const c1 = makeConfig('sl'), c2 = makeConfig('sf')
    const e1 = new GraphEngine(c1), e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      await e1.upsertNode(1, 'conflict', { props: { origin: 'l' } })
      await e2.upsertNode(1, 'conflict', { props: { origin: 'f' } })
      e1.close(); e2.close()
      const e1b = new GraphEngine(c1), e2b = new GraphEngine(c2)
      try { e1b.open(); e2b.open()
        const n1 = e1b.scanAllNodes().find((n: any) => n.name === 'conflict')
        const n2 = e2b.scanAllNodes().find((n: any) => n.name === 'conflict')
        expect(n1).toBeDefined()
        expect(n2).toBeDefined()
        expect(n1!.props.origin).toBe('l')
        expect(n2!.props.origin).toBe('f')
      } finally { try { if (e1b.isOpen) e1b.close() } catch {} try { if (e2b.isOpen) e2b.close() } catch {} }
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 15000)

  test('leader edge isolation survives close chain', async () => {
    const c1 = makeConfig('eil'), c2 = makeConfig('eif')
    const e1 = new GraphEngine(c1), e2 = new GraphEngine(c2)
    let la = 0, lb = 0, fa = 0, fb = 0
    try { e1.open(); e2.open()
      la = await e1.upsertNode(1, 'ela'); lb = await e1.upsertNode(1, 'elb')
      await e1.upsertEdge(la, lb, 10)
      fa = await e2.upsertNode(1, 'efa'); fb = await e2.upsertNode(1, 'efb')
      await e2.upsertEdge(fa, fb, 20)
      e1.close(); e2.close()
      const e1b = new GraphEngine(c1), e2b = new GraphEngine(c2)
      try { e1b.open(); e2b.open()
        expect(e1b.getEdge(la, lb, 10)).not.toBeNull()
        expect(e2b.getEdge(la, lb, 10)).toBeNull()
      } finally { try { if (e1b.isOpen) e1b.close() } catch {} try { if (e2b.isOpen) e2b.close() } catch {} }
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 15000)

  test.skip('sequential non-leader engines fully isolated', async () => {
    const cfgs = [makeConfig('sa'), makeConfig('sb'), makeConfig('sc')]
    for (let i = 0; i < 3; i++) {
      const e = new GraphEngine(cfgs[i])
      try { e.open()
        for (let j = 0; j < 5; j++) await e.upsertNode(1, `s${i}${j}`)
        e.close()
      } finally { try { if (e.isOpen) e.close() } catch {} }
    }
    for (let i = 0; i < 3; i++) {
      const e = new GraphEngine(cfgs[i])
      try { e.open()
        expect(e.scanAllNodes().length).toBe(5)
        for (const n of e.scanAllNodes()) expect(n.name).toContain(`s${i}`)
      } finally { try { if (e.isOpen) e.close() } catch {} cleanupC(cfgs[i]) }
    }
  }, 30000)

  test.skip('follower isolated writes after close and reopen', async () => {
    const c1 = makeConfig('fia'), c2 = makeConfig('fib')
    const e1 = new GraphEngine(c1), e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      await e1.upsertNode(1, 'f1'); await e2.upsertNode(1, 'f2')
      e1.close(); e2.close()
      const e1b = new GraphEngine(c1), e2b = new GraphEngine(c2)
      try { e1b.open(); e2b.open()
        expect(e1b.scanAllNodes().length).toBe(1); expect(e2b.scanAllNodes().length).toBe(1)
        await e1b.upsertNode(1, 'f1b'); await e2b.upsertNode(1, 'f2b')
        expect(e1b.scanAllNodes().length).toBe(2); expect(e2b.scanAllNodes().length).toBe(2)
      } finally { try { if (e1b.isOpen) e1b.close() } catch {} try { if (e2b.isOpen) e2b.close() } catch {} }
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 15000)

  test.skip('leader 10-cycle open close accumulation', async () => {
    const c = makeConfig('l10c')
    for (let i = 0; i < 10; i++) {
      const e = new GraphEngine(c)
      try { e.open()
        expect(e.scanAllNodes().length).toBe(i)
        await e.upsertNode(1, `cy${i}`)
        e.close()
      } finally { try { if (e.isOpen) e.close() } catch {} }
    }
    const ef = new GraphEngine(c)
    try { ef.open(); expect(ef.scanAllNodes().length).toBe(10) }
    finally { cleanupC(c) }
  }, 30000)

  test('follower concurrent writes to different paths', async () => {
    const cfgs = Array.from({length:4}, (_,i) => makeConfig(`fc${i}`))
    const es = cfgs.map(c => new GraphEngine(c))
    try { for (const e of es) e.open()
      await Promise.all(es.map((e,i) => e.upsertNode(1, `fc${i}`)))
      for (const e of es) expect(e.scanAllNodes().length).toBe(1)
    } finally { for (const e of es) cleanupE(e); for (const c of cfgs) cleanupC(c) }
  }, 15000)

  test.skip('leader 80 node bulk write survives reopen', async () => {
    const c = makeConfig('l80'); const e = new GraphEngine(c)
    try { e.open()
      await Promise.all(Array.from({length:80}, (_,i) => e.upsertNode(1, `l8${i}`)))
      e.close()
    } finally { if (e.isOpen) e.close() }
    const e2 = new GraphEngine(c)
    try { e2.open(); expect(e2.scanAllNodes().length).toBe(80) }
    finally { cleanupC(c) }
  }, 30000)

  test.skip('close all engines no contam on reopen', async () => {
    const cfgs = [makeConfig('aca'), makeConfig('acb')]
    const es = cfgs.map(c => new GraphEngine(c))
    try { es[0].open(); es[1].open()
      await es[0].upsertNode(1, 'acaonly'); await es[1].upsertNode(1, 'acbonly')
      es[0].close(); es[1].close()
    } finally { for (const e of es) { try { if (e.isOpen) e.close() } catch {} } }
    const es2 = cfgs.map(c => new GraphEngine(c))
    try { es2[0].open(); es2[1].open()
      expect(es2[0].scanAllNodes().length).toBe(1); expect(es2[1].scanAllNodes().length).toBe(1)
    } finally { for (const e of es2) cleanupE(e); for (const c of cfgs) cleanupC(c) }
  }, 15000)

  test('engine A writes closes B writes different path', async () => {
    const c1 = makeConfig('da'), c2 = makeConfig('db')
    const e1 = new GraphEngine(c1), e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      await e1.upsertNode(1, 'data')
      e1.close()
      await e2.upsertNode(1, 'bdata')
      expect(e2.scanAllNodes().length).toBe(1)
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 15000)

  test('leader 3-cycle props validation', async () => {
    const c = makeConfig('l3p')
    for (let cy = 0; cy < 3; cy++) {
      const e = new GraphEngine(c)
      try { e.open()
        await e.upsertNode(1, 'pn', { props: { cycle: cy } })
        e.close()
      } finally { try { if (e.isOpen) e.close() } catch {} }
    }
    const ef = new GraphEngine(c)
    try { ef.open()
      expect(ef.getNode(1)).not.toBeNull()
      expect(ef.getNode(1)!.props.cycle).toBe(2)
    } finally { cleanupC(c) }
  }, 30000)

  test('follower independent edge operations', async () => {
    const c1 = makeConfig('fia'), c2 = makeConfig('fib')
    const e1 = new GraphEngine(c1), e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      const ct1 = await e1.upsertNode(1, 'c1')
      for (let i = 0; i < 8; i++) {
        const l = await e1.upsertNode(1, `l1${i}`)
        await e1.upsertEdge(ct1, l, 10)
      }
      const ct2 = await e2.upsertNode(1, 'c2')
      for (let i = 0; i < 8; i++) {
        const l = await e2.upsertNode(1, `l2${i}`)
        await e2.upsertEdge(ct2, l, 20)
      }
      expect(e1.neighbors(ct1).edges.length).toBe(8)
      expect(e2.neighbors(ct2).edges.length).toBe(8)
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 15000)

  test.skip('leader many small writes survive cycle', async () => {
    const c = makeConfig('lsw'); const e = new GraphEngine(c)
    try { e.open()
      const ids = await Promise.all(Array.from({length:25}, (_,i) => e.upsertNode(1, `sw${i}`)))
      e.close()
    } finally { if (e.isOpen) e.close() }
    const e2 = new GraphEngine(c)
    try { e2.open(); expect(e2.scanAllNodes().length).toBe(25) }
    finally { cleanupC(c) }
  }, 15000)

  test('rapid close open on 3 engines', async () => {
    const cfgs = Array.from({length:3}, (_,i) => makeConfig(`r3${i}`))
    const es = cfgs.map(c => new GraphEngine(c))
    try {
      for (let cy = 0; cy < 3; cy++) {
        for (let i = 0; i < 3; i++) {
          if (!es[i].isOpen) es[i].open()
          await es[i].upsertNode(1, `r3e${i}c${cy}`)
          es[i].close()
        }
      }
      for (let i = 0; i < 3; i++) {
        es[i].open(); expect(es[i].scanAllNodes().length).toBe(3)
        es[i].close()
      }
    } finally { for (const e of es) cleanupE(e); for (const c of cfgs) cleanupC(c) }
  }, 30000)

  test('close engine mid batch other unaffected', async () => {
    const c1 = makeConfig('mwa'), c2 = makeConfig('mwb')
    const e1 = new GraphEngine(c1), e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      const wp = (async () => { for (let i = 0; i < 20; i++) await e1.upsertNode(1, `mw${i}`) })()
      await new Promise(r => setTimeout(r, 5))
      e1.close()
      try { await wp } catch {}
      await e2.upsertNode(1, 'mwe2')
      expect(e2.scanAllNodes().length).toBe(1)
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 15000)

  test.skip('leader sequential path isolation 4 engines', async () => {
    const cfgs = Array.from({length:4}, (_,i) => makeConfig(`s4${i}`))
    for (let i = 0; i < 4; i++) {
      const e = new GraphEngine(cfgs[i])
      try { e.open()
        for (let j = 0; j < 5; j++) await e.upsertNode(1, `s4e${i}${j}`)
        e.close()
      } finally { try { if (e.isOpen) e.close() } catch {} }
    }
    for (let i = 0; i < 4; i++) {
      const e = new GraphEngine(cfgs[i])
      try { e.open()
        expect(e.scanAllNodes().length).toBe(5)
        for (const n of e.scanAllNodes()) expect(n.name).toContain(`e${i}`)
      } finally { try { if (e.isOpen) e.close() } catch {} cleanupC(cfgs[i]) }
    }
  }, 30000)

  test('engine A many edges close B different edges', async () => {
    const c1 = makeConfig('mea'), c2 = makeConfig('meb')
    const e1 = new GraphEngine(c1), e2 = new GraphEngine(c2)
    try { e1.open(); e2.open()
      const a1 = await e1.upsertNode(1, 'ma1')
      const n1 = await Promise.all(Array.from({length:12}, (_,i) => e1.upsertNode(1, `mn1${i}`)))
      await Promise.all(n1.map(n => e1.upsertEdge(a1, n, 10)))
      e1.close()
      const a2 = await e2.upsertNode(1, 'ma2')
      const n2 = await Promise.all(Array.from({length:6}, (_,i) => e2.upsertNode(1, `mn2${i}`)))
      await Promise.all(n2.map(n => e2.upsertEdge(a2, n, 20)))
      expect(e2.neighbors(a2).edges.length).toBe(6)
      expect(e2.neighbors(a2).edges[0].type).toBe(20)
    } finally { cleanup2(e1, c1, e2, c2) }
  }, 30000)
})
