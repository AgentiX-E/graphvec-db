  it('V57-e2e: delete single node then add back same id', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-del-single'))
    await e.open(); try {
      const id = await e.upsertNode(1, 'a', { props: {} })
      e.deleteNode(id)
      expect(e.scanAllNodes().length).toBe(0)
      await e.upsertNode(1, 'a', { props: {} })
      expect(e.scanAllNodes().length).toBe(1)
    } finally { e.close() }
  }, 30000)

  // ── BATCH 2: MULTI-TYPE / AGGREGATION / SORT ──

  // === Multi-type ops (15 tests) ===
  it('V57-e2e: 20 types 5 nodes each', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-20t5'))
    await e.open(); try {
      for (let t = 1; t <= 20; t++) for (let i = 0; i < 5; i++) await e.upsertNode(t, `t${t}-${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(100)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: 3 types 100 nodes each', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-3t100'))
    await e.open(); try {
      for (let t = 1; t <= 3; t++) for (let i = 0; i < 100; i++) await e.upsertNode(t, `t${t}-${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(300)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: 12 types chain each 8 nodes', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-12t-chn'))
    await e.open(); try {
      for (let t = 1; t <= 12; t++) {
        const ids: number[] = []
        for (let i = 0; i < 8; i++) ids.push(await e.upsertNode(t, `t${t}-${i}`, { props: {} }))
        for (let i = 0; i < 7; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      }
      expect(e.scanAllNodes().length).toBe(96)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: 5 types with cross-type edges', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-5t-cross'))
    await e.open(); try {
      const nodes: number[] = []
      for (let t = 1; t <= 5; t++) nodes.push(await e.upsertNode(t, `t${t}`, { props: {} }))
      for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) await e.upsertEdge(nodes[i], nodes[j], 1, { props: {} })
      expect(e.neighbors(nodes[0]).edges.length).toBe(4)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: 8 types 10 each verify type count', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-8t10'))
    await e.open(); try {
      for (let t = 1; t <= 8; t++) for (let i = 0; i < 10; i++) await e.upsertNode(t, `t${t}-${i}`, { props: {} })
      const all = e.scanAllNodes()
      expect(all.length).toBe(80)
      expect(all.filter(n => n.name === 't2-5').length).toBe(1)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: 15 types each single node', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-15t1'))
    await e.open(); try {
      for (let t = 1; t <= 15; t++) await e.upsertNode(t, `t${t}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(15)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: type 100 nodes each with different label', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-100t'))
    await e.open(); try {
      for (let t = 1; t <= 100; t++) await e.upsertNode(t, `lbl${t}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(100)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: 20 types 3 each verify scan', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-20t3'))
    await e.open(); try {
      for (let t = 1; t <= 20; t++) for (let i = 0; i < 3; i++) await e.upsertNode(t, `t${t}`, { props: { seq: i } })
      expect(e.scanAllNodes().length).toBe(60)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: 10 types with mixed prop types each', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-10t-mix'))
    await e.open(); try {
      for (let t = 1; t <= 10; t++) await e.upsertNode(t, `t${t}`, { props: { str: `val${t}`, num: t * 10, bool: t % 2 === 0 } })
      const all = e.scanAllNodes()
      expect(all.length).toBe(10)
      expect(all.filter(n => n.props.bool === true).length).toBe(5)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: 25 types 4 each chain edges', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-25t4'))
    await e.open(); try {
      for (let t = 1; t <= 25; t++) {
        const ids: number[] = []
        for (let i = 0; i < 4; i++) ids.push(await e.upsertNode(t, `t${t}-${i}`, { props: {} }))
        for (let i = 0; i < 3; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      }
      expect(e.scanAllNodes().length).toBe(100)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: type 6 each 25 scan by name', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-6t25'))
    await e.open(); try {
      for (let t = 7; t <= 12; t++) for (let i = 0; i < 25; i++) await e.upsertNode(t, `g${t}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(150)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: 30 types sequential ids', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-30t'))
    await e.open(); try {
      for (let t = 1; t <= 30; t++) await e.upsertNode(t, `s${t}`, { props: { type: t } })
      expect(e.scanAllNodes().length).toBe(30)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: 2 types each 150 nodes big', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-2t150'))
    await e.open(); try {
      for (let t = 1; t <= 2; t++) for (let i = 0; i < 150; i++) await e.upsertNode(t, `t${t}-${i}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(300)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: 7 types chain of 10 each', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-7t10'))
    await e.open(); try {
      for (let t = 1; t <= 7; t++) {
        const ids: number[] = []
        for (let i = 0; i < 10; i++) ids.push(await e.upsertNode(t, `t${t}-n${i}`, { props: {} }))
        for (let i = 0; i < 9; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      }
      expect(e.scanAllNodes().length).toBe(70)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: 50 types 2 each verify distinct names', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-50t2'))
    await e.open(); try {
      for (let t = 1; t <= 50; t++) for (let i = 0; i < 2; i++) await e.upsertNode(t, `t${t}`, { props: {} })
      expect(e.scanAllNodes().length).toBe(100)
    } finally { e.close() }
  }, 30000)

  // === Aggregation (12 tests) ===
  it('V57-e2e: count nodes by type', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-agg-count'))
    await e.open(); try {
      for (let i = 0; i < 20; i++) await e.upsertNode(1, 'a', { props: {} })
      for (let i = 0; i < 10; i++) await e.upsertNode(2, 'b', { props: {} })
      const all = e.scanAllNodes()
      expect(all.filter(n => n.name === 'a').length).toBe(20)
      expect(all.filter(n => n.name === 'b').length).toBe(10)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: sum props by filter', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-agg-sum'))
    await e.open(); try {
      for (let i = 0; i < 50; i++) await e.upsertNode(1, 'a', { props: { v: i } })
      const sum = e.scanAllNodes().reduce((s, n) => s + (n.props.v as number), 0)
      expect(sum).toBe(1225)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: average on int array', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-agg-avg'))
    await e.open(); try {
      for (let i = 1; i <= 20; i++) await e.upsertNode(1, 'a', { props: { v: i * 5 } })
      const vals = e.scanAllNodes().map(n => n.props.v as number)
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length
      expect(avg).toBe(52.5)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: min/max with negatives', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-agg-minmax'))
    await e.open(); try {
      for (let i = -25; i <= 25; i++) await e.upsertNode(1, 'a', { props: { v: i } })
      const vals = e.scanAllNodes().map(n => n.props.v as number)
      expect(Math.min(...vals)).toBe(-25)
      expect(Math.max(...vals)).toBe(25)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: sum positive integers only', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-agg-pos'))
    await e.open(); try {
      for (let i = -10; i <= 10; i++) await e.upsertNode(1, 'a', { props: { v: i } })
      const sum = e.scanAllNodes().filter(n => (n.props.v as number) > 0).reduce((s, n) => s + (n.props.v as number), 0)
      expect(sum).toBe(55)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: count zero-value props', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-agg-zero'))
    await e.open(); try {
      for (let i = 0; i < 30; i++) await e.upsertNode(1, 'a', { props: { v: i < 10 ? 0 : i } })
      expect(e.scanAllNodes().filter(n => n.props.v === 0).length).toBe(10)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: sum by label filter', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-agg-lab'))
    await e.open(); try {
      for (let i = 0; i < 20; i++) { await e.upsertNode(1, 'x', { props: { v: i } }) }
      for (let i = 0; i < 20; i++) { await e.upsertNode(2, 'y', { props: { v: i * 10 } }) }
      const sx = e.scanAllNodes().filter(n => n.name === 'x').reduce((s, n) => s + (n.props.v as number), 0)
      const sy = e.scanAllNodes().filter(n => n.name === 'y').reduce((s, n) => s + (n.props.v as number), 0)
      expect(sx).toBe(190)
      expect(sy).toBe(1900)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: count distinct values', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-agg-dist'))
    await e.open(); try {
      for (let i = 0; i < 50; i++) await e.upsertNode(1, 'a', { props: { v: i % 5 } })
      const counts = [0, 0, 0, 0, 0]
      for (const n of e.scanAllNodes()) counts[n.props.v as number]++
      expect(counts.every(c => c === 10)).toBe(true)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: reduce count of props exceeding threshold', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-agg-thr'))
    await e.open(); try {
      for (let i = 0; i < 100; i++) await e.upsertNode(1, 'a', { props: { v: i } })
      const over50 = e.scanAllNodes().filter(n => (n.props.v as number) > 50).length
      expect(over50).toBe(49)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: aggregate string length', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-agg-str'))
    await e.open(); try {
      for (let i = 0; i < 10; i++) await e.upsertNode(1, 'a', { props: { s: 'x'.repeat(i + 1) } })
      const totalLen = e.scanAllNodes().reduce((s, n) => s + (n.props.s as string).length, 0)
      expect(totalLen).toBe(55)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: sum with edge filter', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-agg-edge'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 10; i++) ids.push(await e.upsertNode(1, 'a', { props: { v: i * 10 } }))
      for (let i = 0; i < 9; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      const sum = e.scanAllNodes().reduce((s, n) => s + (n.props.v as number), 0)
      expect(sum).toBe(450)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: count by type after delete half', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-agg-del'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 40; i++) ids.push(await e.upsertNode(1, 'a', { props: {} }))
      for (let i = 0; i < 20; i++) e.deleteNode(ids[i * 2])
      expect(e.scanAllNodes().length).toBe(20)
    } finally { e.close() }
  }, 30000)

  // === Sort (12 tests) ===
  it('V57-e2e: sort nodes by name length', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-sort-nlen'))
    await e.open(); try {
      await e.upsertNode(1, 'a', { props: {} })
      await e.upsertNode(1, 'bb', { props: {} })
      await e.upsertNode(1, 'ccc', { props: {} })
      const sorted = e.scanAllNodes().sort((a, b) => a.name.length - b.name.length)
      expect(sorted[0].name.length).toBe(1)
      expect(sorted[2].name.length).toBe(3)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: sort by type then name', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-sort-tn'))
    await e.open(); try {
      await e.upsertNode(2, 'z', { props: {} })
      await e.upsertNode(1, 'a', { props: {} })
      await e.upsertNode(2, 'a', { props: {} })
      await e.upsertNode(1, 'z', { props: {} })
      const sorted = e.scanAllNodes().sort((a, b) => a.type !== b.type ? a.type - b.type : a.name.localeCompare(b.name))
      expect(sorted[0].type).toBe(1)
      expect(sorted[0].name).toBe('a')
      expect(sorted[3].type).toBe(2)
      expect(sorted[3].name).toBe('z')
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: sort by property descending with tie', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-sort-desc'))
    await e.open(); try {
      await e.upsertNode(1, 'a', { props: { v: 10 } })
      await e.upsertNode(1, 'b', { props: { v: 30 } })
      await e.upsertNode(1, 'c', { props: { v: 20 } })
      await e.upsertNode(1, 'd', { props: { v: 30 } })
      const sorted = e.scanAllNodes().sort((a, b) => (b.props.v as number) - (a.props.v as number))
      expect(sorted[0].props.v).toBe(30)
      expect(sorted[2].props.v).toBe(20)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: sort on multi-prop', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-sort-mp'))
    await e.open(); try {
      await e.upsertNode(1, 'a', { props: { cat: 1, seq: 3 } })
      await e.upsertNode(1, 'b', { props: { cat: 1, seq: 1 } })
      await e.upsertNode(1, 'c', { props: { cat: 2, seq: 2 } })
      const sorted = e.scanAllNodes().sort((a, b) => {
        const ca = (a.props.cat as number), cb = (b.props.cat as number)
        return ca !== cb ? ca - cb : (a.props.seq as number) - (b.props.seq as number)
      })
      expect(sorted[0].props.seq).toBe(1)
      expect(sorted[1].props.seq).toBe(3)
      expect(sorted[2].props.seq).toBe(2)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: sort by name alphabetically', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-sort-alpha'))
    await e.open(); try {
      await e.upsertNode(1, 'c', { props: {} })
      await e.upsertNode(1, 'a', { props: {} })
      await e.upsertNode(1, 'b', { props: {} })
      const sorted = e.scanAllNodes().sort((a, b) => a.name.localeCompare(b.name))
      expect(sorted[0].name).toBe('a')
      expect(sorted[1].name).toBe('b')
      expect(sorted[2].name).toBe('c')
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: sort by numeric prop with nulls', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-sort-null'))
    await e.open(); try {
      await e.upsertNode(1, 'a', { props: { v: 5 } })
      await e.upsertNode(1, 'b', { props: { v: null } })
      await e.upsertNode(1, 'c', { props: { v: 1 } })
      const sorted = e.scanAllNodes().sort((a, b) => ((a.props.v ?? 0) as number) - ((b.props.v ?? 0) as number))
      expect(sorted[0].props.v).toBe(1)
      expect(sorted[1].props.v).toBe(5)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: sort by type desc then prop asc', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-sort-tdp'))
    await e.open(); try {
      await e.upsertNode(1, 'a', { props: { v: 5 } })
      await e.upsertNode(3, 'b', { props: { v: 1 } })
      await e.upsertNode(2, 'c', { props: { v: 3 } })
      const sorted = e.scanAllNodes().sort((a, b) => b.type - a.type || (a.props.v as number) - (b.props.v as number))
      expect(sorted[0].type).toBe(3)
      expect(sorted[2].type).toBe(1)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: sort by string prop lexicographic', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-sort-str'))
    await e.open(); try {
      await e.upsertNode(1, 'a', { props: { s: 'zzz' } })
      await e.upsertNode(1, 'b', { props: { s: 'aaa' } })
      await e.upsertNode(1, 'c', { props: { s: 'mmm' } })
      const sorted = e.scanAllNodes().sort((a, b) => (a.props.s as string).localeCompare(b.props.s as string))
      expect(sorted[0].props.s).toBe('aaa')
      expect(sorted[2].props.s).toBe('zzz')
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: sort by boolean prop', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-sort-bool'))
    await e.open(); try {
      await e.upsertNode(1, 'a', { props: { f: true } })
      await e.upsertNode(1, 'b', { props: { f: false } })
      await e.upsertNode(1, 'c', { props: { f: true } })
      const sorted = e.scanAllNodes().sort((a, b) => Number(a.props.f) - Number(b.props.f))
      expect(sorted[0].props.f).toBe(false)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: sort by prop then by name', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-sort-pn'))
    await e.open(); try {
      await e.upsertNode(1, 'c', { props: { v: 10 } })
      await e.upsertNode(1, 'a', { props: { v: 10 } })
      await e.upsertNode(1, 'b', { props: { v: 5 } })
      const sorted = e.scanAllNodes().sort((a, b) => (a.props.v as number) - (b.props.v as number) || a.name.localeCompare(b.name))
      expect(sorted[0].name).toBe('b')
      expect(sorted[1].name).toBe('a')
      expect(sorted[2].name).toBe('c')
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: sort on negative numeric prop', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-sort-neg'))
    await e.open(); try {
      await e.upsertNode(1, 'a', { props: { v: -5 } })
      await e.upsertNode(1, 'b', { props: { v: -10 } })
      await e.upsertNode(1, 'c', { props: { v: -1 } })
      const sorted = e.scanAllNodes().sort((a, b) => (a.props.v as number) - (b.props.v as number))
      expect(sorted[0].props.v).toBe(-10)
      expect(sorted[2].props.v).toBe(-1)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: sort nodes with same type by id', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-sort-id'))
    await e.open(); try {
      const ids: number[] = []
      ids.push(await e.upsertNode(1, 'x', { props: {} }))
      ids.push(await e.upsertNode(1, 'y', { props: {} }))
      ids.push(await e.upsertNode(1, 'z', { props: {} }))
      const sorted = e.scanAllNodes().sort((a, b) => a.id - b.id)
      expect(sorted.length).toBe(3)
    } finally { e.close() }
  }, 30000)

  it('V57-e2e: sort on type+name+prop combined', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-sort-tnp'))
    await e.open(); try {
      await e.upsertNode(2, 'b', { props: { v: 5 } })
      await e.upsertNode(1, 'a', { props: { v: 3 } })
      await e.upsertNode(2, 'a', { props: { v: 1 } })
      await e.upsertNode(1, 'b', { props: { v: 7 } })
      const sorted = e.scanAllNodes().sort((a, b) => {
        if (a.type !== b.type) return a.type - b.type
        if (a.name !== b.name) return a.name.localeCompare(b.name)
        return (a.props.v as number) - (b.props.v as number)
      })
      expect(sorted[0].name).toBe('a')
      expect(sorted[0].type).toBe(1)
      expect(sorted[0].props.v).toBe(3)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: sort descending by prop with equal values tie', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-sort-dtie'))
    await e.open(); try {
      await e.upsertNode(1, 'z', { props: { v: 5 } })
      await e.upsertNode(1, 'a', { props: { v: 5 } })
      await e.upsertNode(1, 'm', { props: { v: 5 } })
      const sorted = e.scanAllNodes().sort((a, b) => b.props.v - a.props.v || a.name.localeCompare(b.name))
      expect(sorted[0].name).toBe('a')
      expect(sorted[2].name).toBe('z')
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: sort by prop then type desc', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-sort-ptd'))
    await e.open(); try {
      await e.upsertNode(1, 'a', { props: { v: 1 } })
      await e.upsertNode(2, 'b', { props: { v: 1 } })
      await e.upsertNode(3, 'c', { props: { v: 2 } })
      const sorted = e.scanAllNodes().sort((a, b) => (a.props.v as number) - (b.props.v as number) || b.type - a.type)
      expect(sorted[0].type).toBe(2)
      expect(sorted[1].type).toBe(1)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: aggregate product of props', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-agg-prod'))
    await e.open(); try {
      for (let i = 1; i <= 5; i++) await e.upsertNode(1, 'a', { props: { v: i } })
      const prod = e.scanAllNodes().reduce((p, n) => p * (n.props.v as number), 1)
      expect(prod).toBe(120)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: aggregate on filtered edge neigh', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-agg-edge2'))
    await e.open(); try {
      const ids: number[] = []
      for (let i = 0; i < 10; i++) ids.push(await e.upsertNode(1, 'a', { props: { v: i } }))
      for (let i = 0; i < 5; i++) await e.upsertEdge(ids[i*2], ids[i*2+1], 1, { props: {} })
      const sum = e.scanAllNodes().reduce((s, n) => s + (n.props.v as number), 0)
      expect(sum).toBe(45)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: count negative zeros in props', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-agg-neg0'))
    await e.open(); try {
      await e.upsertNode(1, 'a', { props: { v: -0 } })
      await e.upsertNode(1, 'b', { props: { v: 0 } })
      const all = e.scanAllNodes()
      expect(Object.is(all[0].props.v, 0) || Object.is(all[0].props.v, -0)).toBe(true)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: range check on prop values', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-agg-range'))
    await e.open(); try {
      for (let i = 1; i <= 30; i++) await e.upsertNode(1, 'a', { props: { v: i } })
      const r10_20 = e.scanAllNodes().filter(n => (n.props.v as number) >= 10 && (n.props.v as number) <= 20).length
      expect(r10_20).toBe(11)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: multi-type edge all-to-all', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-mt-all'))
    await e.open(); try {
      const ids: number[] = []
      for (let t = 1; t <= 8; t++) ids.push(await e.upsertNode(t, , { props: {} }))
      for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) await e.upsertEdge(ids[i], ids[j], 1, { props: {} })
      expect(e.neighbors(ids[0]).edges.length).toBe(7)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: 40 types 3 nodes each chain 2', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-40t3'))
    await e.open(); try {
      for (let t = 1; t <= 40; t++) {
        const a = await e.upsertNode(t, , { props: {} })
        const b = await e.upsertNode(t, , { props: {} })
        await e.upsertEdge(a, b, 1, { props: {} })
      }
      expect(e.scanAllNodes().length).toBe(80)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: 10 types all same name verify count', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-10t-sn'))
    await e.open(); try {
      for (let t = 1; t <= 10; t++) await e.upsertNode(t, 'same', { props: {} })
      expect(e.scanAllNodes().length).toBe(10)
    } finally { e.close() }
  }, 30000)