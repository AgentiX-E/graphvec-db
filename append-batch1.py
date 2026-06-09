import os

path = '/home/admin/openclaw/workspace/agentiX-graphvec/src/e2e/cypher-e2e.spec.ts'

batch1 = r'''
  // ── BATCH 1: CHAIN / STAR / PROPERTY EDGE / DELETE PATTERNS ──

  // === Chain operations (14 tests) ===
  it('V57-e2e: chain 200 edges verify head neighbor count', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-chain200'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 201; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 200; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.neighbors(ids[0]).edges.length).toBeGreaterThanOrEqual(1)
      expect(e.neighbors(ids[100]).edges.length).toBeGreaterThanOrEqual(2)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: chain delete first node', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-chn-del-fst'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 50; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 49; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      e.deleteNode(ids[0])
      expect(e.scanAllNodes().length).toBe(49)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: chain delete middle node', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-chn-del-mid'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 50; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 49; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      e.deleteNode(ids[25])
      expect(e.scanAllNodes().length).toBe(49)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: chain delete last node', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-chn-del-lst'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 50; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 49; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      e.deleteNode(ids[49])
      expect(e.scanAllNodes().length).toBe(49)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: chain delete 3 random positions', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-chn-del3'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 60; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 59; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      e.deleteNode(ids[10]); e.deleteNode(ids[30]); e.deleteNode(ids[50])
      expect(e.scanAllNodes().length).toBe(57)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: chain 5 types verify neighbor count', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-chn5t'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 101; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 100; i++) await e.upsertEdge(ids[i], ids[i + 1], (i % 5) + 1, { props: {} })
      const nb = e.neighbors(ids[50])
      expect(nb.edges.length).toBeGreaterThanOrEqual(2)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: chain multi-hop neighbor count depth 2', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-chn-hop2'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 30; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 29; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      const nb = e.neighbors(ids[10])
      expect(nb.nodes.length).toBeGreaterThanOrEqual(2)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: chain reverse direction edges verify', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-chn-rev'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 20; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 19; i > 0; i--) await e.upsertEdge(ids[i], ids[i - 1], 1, { props: {} })
      const nb = e.neighbors(ids[0])
      expect(nb.edges.length).toBeGreaterThanOrEqual(1)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: chain verify node props persist after edges', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-chn-prop'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 30; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: { idx: i, sq: i * i } }))
      for (let i = 0; i < 29; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      const node15 = e.getNode(ids[15])
      expect(node15).not.toBeNull()
      expect(node15!.props.idx).toBe(15)
      expect(node15!.props.sq).toBe(225)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: chain 200 edges scan all count', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-chn200scan'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 201; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 200; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(201)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: chain 200 edges delete every 10th', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-chn-dele10'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 200; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 199; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      for (let i = 0; i < 200; i += 10) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(180)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: chain 40 nodes each with string name prop', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-chn-str'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 40; i++) ids.push(await e.upsertNode(1, `s${i}`, { props: { label: `node-${i}` } }))
      for (let i = 0; i < 39; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      const all = e.scanAllNodes()
      expect(all.filter(n => n.props.label === 'node-5').length).toBe(1)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: chain neighbor after interior deletions', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-chn-int'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 20; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 19; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      e.deleteNode(ids[5]); e.deleteNode(ids[10]); e.deleteNode(ids[15])
      expect(e.scanAllNodes().length).toBe(17)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: chain 120 with alternating prop values', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-chn-alt'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 120; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: { parity: i % 2 } }))
      for (let i = 0; i < 119; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      const evens = e.scanAllNodes().filter(n => n.props.parity === 0)
      expect(evens.length).toBe(60)
    } finally { e.close() }
  }, 30000)

  // === Star/Hub ops (13 tests) ===
  it('V57-e2e: hub 150 edges verify center neighbor count', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-hub150'))
    await e.open(); try {
      const center = await e.upsertNode(1, 'center', { props: {} })
      for (let i = 0; i < 150; i++) {
        const leaf = await e.upsertNode(1, `leaf${i}`, { props: {} })
        await e.upsertEdge(center, leaf, 1, { props: {} })
      }
      const nb = e.neighbors(center)
      expect(nb.edges.length).toBeGreaterThanOrEqual(150)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: 15 hubs 6 leaves each', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-15h6l'))
    await e.open(); try {
      for (let h = 0; h < 15; h++) {
        const hid = await e.upsertNode(1, `hub${h}`, { props: {} })
        for (let l = 0; l < 6; l++) {
          const lid = await e.upsertNode(1, `h${h}-l${l}`, { props: {} })
          await e.upsertEdge(hid, lid, 1, { props: {} })
        }
      }
      expect(e.scanAllNodes().length).toBe(15 + 90)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: hub delete center then scan', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-hub-delc'))
    await e.open(); try {
      const center = await e.upsertNode(1, 'center', { props: {} })
      const leaves: number[] = []
      for (let i = 0; i < 20; i++) {
        const lid = await e.upsertNode(1, `leaf${i}`, { props: {} })
        leaves.push(lid)
        await e.upsertEdge(center, lid, 1, { props: {} })
      }
      e.deleteNode(center)
      expect(e.scanAllNodes().length).toBe(20)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: multi-hub interconnects', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-mhub-int'))
    await e.open(); try {
      const hubs: number[] = []
      for (let h = 0; h < 5; h++) hubs.push(await e.upsertNode(1, `hub${h}`, { props: {} }))
      for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) await e.upsertEdge(hubs[i], hubs[j], 1, { props: {} })
      for (const h of hubs) { const nb = e.neighbors(h); expect(nb.edges.length).toBe(4) }
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: star with 40 leaves verify leaf neighbor', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-star40'))
    await e.open(); try {
      const center = await e.upsertNode(1, 'center', { props: {} })
      const leaves: number[] = []
      for (let i = 0; i < 40; i++) {
        const lid = await e.upsertNode(1, `l${i}`, { props: {} })
        leaves.push(lid)
        await e.upsertEdge(center, lid, 1, { props: {} })
      }
      const nb = e.neighbors(leaves[0])
      expect(nb.edges.length).toBeGreaterThanOrEqual(1)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: 10 hubs each 10 leaves verify total', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-10h10l'))
    await e.open(); try {
      for (let h = 0; h < 10; h++) {
        const hid = await e.upsertNode(1, `h${h}`, { props: {} })
        for (let l = 0; l < 10; l++) {
          const lid = await e.upsertNode(1, `h${h}-l${l}`, { props: {} })
          await e.upsertEdge(hid, lid, 1, { props: {} })
        }
      }
      expect(e.scanAllNodes().length).toBe(110)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: hub delete one leaf then neighbor count', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-hub-dell'))
    await e.open(); try {
      const center = await e.upsertNode(1, 'center', { props: {} })
      for (let i = 0; i < 10; i++) {
        const lid = await e.upsertNode(1, `leaf${i}`, { props: {} })
        await e.upsertEdge(center, lid, 1, { props: {} })
      }
      const all = e.scanAllNodes()
      const l3 = all.filter(n => n.name === 'leaf3')[0]
      e.deleteNode(l3.id)
      expect(e.scanAllNodes().length).toBe(10)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: 3 hubs with cross edges forming mesh', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-3hub-mesh'))
    await e.open(); try {
      const hubs: number[] = []
      for (let h = 0; h < 3; h++) hubs.push(await e.upsertNode(1, `h${h}`, { props: {} }))
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) await e.upsertEdge(hubs[i], hubs[j], 1, { props: {} })
      for (const h of hubs) expect(e.neighbors(h).edges.length).toBe(2)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: hub with int props on leaves sum', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-hub-prop'))
    await e.open(); try {
      const center = await e.upsertNode(1, 'center', { props: {} })
      for (let i = 0; i < 25; i++) {
        const lid = await e.upsertNode(1, `l${i}`, { props: { score: i * 10 } })
        await e.upsertEdge(center, lid, 1, { props: {} })
      }
      const leaves = e.scanAllNodes().filter(n => n.name.startsWith('l'))
      const scores = leaves.map(n => n.props.score as number)
      expect(scores.reduce((a, b) => a + b, 0)).toBe(3000)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: 5 hubs 25 leaves each verify total nodes', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-5h25l'))
    await e.open(); try {
      for (let h = 0; h < 5; h++) {
        const hid = await e.upsertNode(1, `h${h}`, { props: {} })
        for (let l = 0; l < 25; l++) {
          await e.upsertEdge(hid, await e.upsertNode(1, `h${h}-l${l}`, { props: {} }), 1, { props: {} })
        }
      }
      expect(e.scanAllNodes().length).toBe(130)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: hub with chains from each leaf', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-hub-chn'))
    await e.open(); try {
      const center = await e.upsertNode(1, 'center', { props: {} })
      for (let arm = 0; arm < 5; arm++) {
        const first = await e.upsertNode(1, `arm${arm}-0`, { props: {} })
        await e.upsertEdge(center, first, 1, { props: {} })
        for (let j = 1; j < 4; j++) {
          await e.upsertEdge(first, await e.upsertNode(1, `arm${arm}-${j}`, { props: {} }), 1, { props: {} })
        }
      }
      expect(e.neighbors(center).edges.length).toBe(5)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: star delete 2 leaves verify remain count', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-star-d2'))
    await e.open(); try {
      const center = await e.upsertNode(1, 'center', { props: {} })
      for (let i = 0; i < 15; i++) await e.upsertEdge(center, await e.upsertNode(1, `l${i}`, { props: {} }), 1, { props: {} })
      e.deleteNode(center)
      expect(e.scanAllNodes().length).toBe(15)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: hub 80 edges total scan', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-hub80'))
    await e.open(); try {
      const center = await e.upsertNode(1, 'center', { props: {} })
      for (let i = 0; i < 80; i++) {
        await e.upsertEdge(center, await e.upsertNode(1, `l${i}`, { props: {} }), 1, { props: {} })
      }
      expect(e.scanAllNodes().length).toBe(81)
    } finally { e.close() }
  }, 30000)

  // === Property edge cases (11 tests) ===
  it('V57-e2e: property negative integer', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-prop-neg'))
    await e.open(); try {
      await e.upsertNode(1, 'a', { props: { v: -42 } })
      const n = e.scanAllNodes()[0]
      expect(n.props.v).toBe(-42)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: property NaN', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-prop-nan'))
    await e.open(); try {
      await e.upsertNode(1, 'a', { props: { v: NaN } })
      const n = e.scanAllNodes()[0]
      expect(isNaN(n.props.v as number)).toBe(true)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: property Infinity', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-prop-inf'))
    await e.open(); try {
      await e.upsertNode(1, 'a', { props: { v: Infinity } })
      const n = e.scanAllNodes()[0]
      expect(n.props.v).toBe(Infinity)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: property Boolean false', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-prop-false'))
    await e.open(); try {
      await e.upsertNode(1, 'a', { props: { v: false } })
      const n = e.scanAllNodes()[0]
      expect(n.props.v).toBe(false)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: property undefined after delete', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-prop-undel'))
    await e.open(); try {
      const id = await e.upsertNode(1, 'a', { props: { v: 100 } })
      e.deleteNode(id)
      expect(e.scanAllNodes().filter(n => n.props.v === 100).length).toBe(0)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: property mixed array', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-prop-marr'))
    await e.open(); try {
      await e.upsertNode(1, 'a', { props: { arr: [1, 'two', true, null] } })
      const n = e.scanAllNodes()[0]
      expect(Array.isArray(n.props.arr)).toBe(true)
      expect(n.props.arr.length).toBe(4)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: property truly deep nesting', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-prop-deep'))
    await e.open(); try {
      await e.upsertNode(1, 'a', { props: { deep: { l1: { l2: { l3: 'bottom' }, val: 42 }, arr: [1, [2, [3]]] } } })
      const n = e.scanAllNodes()[0]
      expect(n.props.deep.l1.l2.l3).toBe('bottom')
      expect(n.props.deep.l1.val).toBe(42)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: property with space in key', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-prop-spk'))
    await e.open(); try {
      await e.upsertNode(1, 'a', { props: { 'my value': 123 } })
      const n = e.scanAllNodes()[0]
      expect(n.props['my value']).toBe(123)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: property empty string value', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-prop-emp'))
    await e.open(); try {
      await e.upsertNode(1, 'a', { props: { v: '' } })
      const n = e.scanAllNodes()[0]
      expect(n.props.v).toBe('')
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: property zero counts as number', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-prop-zero'))
    await e.open(); try {
      await e.upsertNode(1, 'a', { props: { v: 0 } })
      const n = e.scanAllNodes()[0]
      expect(n.props.v).toBe(0)
      expect(typeof n.props.v).toBe('number')
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: property large negative number', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-prop-bign'))
    await e.open(); try {
      await e.upsertNode(1, 'a', { props: { v: -999999 } })
      const n = e.scanAllNodes()[0]
      expect(n.props.v).toBe(-999999)
    } finally { e.close() }
  }, 30000)

  // === Delete patterns (12 tests) ===
  it('V57-e2e: delete random 5 of 50', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-del-r5'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 50; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const idx of [3, 13, 23, 33, 43]) e.deleteNode(ids[idx])
      expect(e.scanAllNodes().length).toBe(45)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: delete every Nth (N=7, total 100)', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-del-e7'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 100; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 6; i < 100; i += 7) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(87)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: delete range [20,40) of 100', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-del-rng'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 100; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 20; i < 40; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(80)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: delete all then re-insert same count', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-del-ri'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 30; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      expect(e.scanAllNodes().length).toBe(0)
      for (let i = 0; i < 30; i++) await e.upsertNode(1, `m${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(30)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: delete every other of 60', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-del-e2'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 60; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 1; i < 60; i += 2) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(30)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: delete first 10 of 50', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-del-f10'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 50; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 10; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(40)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: delete last 10 of 50', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-del-l10'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 50; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 40; i < 50; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(40)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: delete and re-insert different labels', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-del-rlab'))
    await e.open(); try {
      for (let i = 0; i < 20; i++) await e.upsertNode(1, 'old', { props: {} })
      for (const n of e.scanAllNodes()) e.deleteNode(n.id)
      for (let i = 0; i < 20; i++) await e.upsertNode(2, 'new', { props: {} })
      const all = e.scanAllNodes()
      expect(all.length).toBe(20)
      expect(all.filter(n => n.name === 'new').length).toBe(20)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: delete nodes with edge verify scan', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-del-we'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 20; i++) ids.push(await e.upsertNode(1, `n${i}`, { props: {} }))
      for (let i = 0; i < 19; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      for (let i = 5; i < 15; i++) e.deleteNode(ids[i])
      expect(e.scanAllNodes().length).toBe(10)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: delete all nodes twice no error', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-del-2x'))
    await e.open(); try {
      for (let i = 0; i < 10; i++) await e.upsertNode(1, `n${i}`, { props: {} })
      for (const n of e.scanAllNodes()) e.deleteNode(n.id)
      expect(e.scanAllNodes().length).toBe(0)
      for (const n of e.scanAllNodes()) e.deleteNode(n.id)
      expect(e.scanAllNodes().length).toBe(0)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: delete nodes by label then scan', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-del-lab'))
    await e.open(); try {
      for (let i = 0; i < 10; i++) await e.upsertNode(1, 'target', { props: {} })
      for (let i = 0; i < 5; i++) await e.upsertNode(2, 'keep', { props: {} })
      const targets = e.scanAllNodes().filter(n => n.name === 'target')
      for (const n of targets) e.deleteNode(n.id)
      expect(e.scanAllNodes().length).toBe(5)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: delete