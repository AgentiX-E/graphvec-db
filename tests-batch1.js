
  // ═══════════════════════════════════════════════════════════════
  // V57-E2E CATEGORY 1 — Negative / Error Handling (20 tests)
  // ═══════════════════════════════════════════════════════════════
  it('V57-e2e: deleteNode after already deleted', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-del-twice'))
    await e.open(); try {
      const id = await e.upsertNode(1, 'n', { props: {} })
      e.deleteNode(id)
      const result = e.deleteNode(id)
      expect(result).toBe(false)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: getNode with invalid/non-existent id', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-get-inv'))
    await e.open(); try {
      const result = e.getNode(999999)
      expect(result).toBeNull()
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: neighbors on empty graph', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-nbr-empty'))
    await e.open(); try {
      expect(e.neighbors(1).edges.length).toBe(0)
      expect(e.neighbors(1).nodes.length).toBe(0)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: upsertEdge with same source+target no duplicate', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-edge-dup'))
    await e.open(); try {
      const a = await e.upsertNode(1, 'a', { props: {} })
      const b = await e.upsertNode(2, 'b', { props: {} })
      await e.upsertEdge(a, b, 1, { props: {} })
      await e.upsertEdge(a, b, 1, { props: {} })
      const nr = e.neighbors(a)
      expect(nr.edges.length).toBe(1)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: scanAllNodes after delete all', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-scan-del'))
    await e.open(); try {
      const ids = []
      for (let i = 0; i < 10; i++) ids.push(await e.upsertNode(1, 'n'+i, { props: {} }))
      for (const id of ids) e.deleteNode(id)
      expect(e.scanAllNodes().length).toBe(0)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: upsertNode with empty string name', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-name-em'))
    await e.open(); try {
      const id = await e.upsertNode(1, '', { props: {} })
      const n = e.getNode(id)
      expect(n).not.toBeNull()
      expect(n.name).toBe('')
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: upsertNode with very long name 1000 chars', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-name-lg'))
    await e.open(); try {
      const longName = new Array(1001).join('x')
      const id = await e.upsertNode(1, longName, { props: {} })
      const n = e.getNode(id)
      expect(n).not.toBeNull()
      expect(n.name.length).toBe(1000)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: getNodeByLabel that does not exist', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-lbl-none'))
    await e.open(); try {
      const result = e.getNodeByLabel(999, 'nonexistent')
      expect(result).toBeNull()
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: chain delete all then try neighbor', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-del-nbr'))
    await e.open(); try {
      const ids = []
      for (let i = 0; i < 5; i++) ids.push(await e.upsertNode(1, 'n'+i, { props: {} }))
      for (let i = 0; i < 4; i++) await e.upsertEdge(ids[i], ids[i+1], 1, { props: {} })
      for (const id of ids) e.deleteNode(id)
      const nr = e.neighbors(ids[0])
      expect(nr.edges.length).toBe(0)
      expect(nr.nodes.length).toBe(0)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: delete non-existent node multiple times', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-del-miss'))
    await e.open(); try {
      expect(e.deleteNode(12345)).toBe(false)
      expect(e.deleteNode(12345)).toBe(false)
      expect(e.deleteNode(12345)).toBe(false)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: getNode with negative id', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-neg-id'))
    await e.open(); try {
      const n = e.getNode(-1)
      expect(n).toBeNull()
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: upsertNode then delete then upsert same name', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-reuse-name'))
    await e.open(); try {
      const id1 = await e.upsertNode(1, 'same', { props: {} })
      e.deleteNode(id1)
      const id2 = await e.upsertNode(1, 'same', { props: {} })
      expect(id2).not.toBe(id1)
      expect(e.getNode(id2)).not.toBeNull()
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: deleteNode on already open file after reopen', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-del-reopen'))
    await e.open(); try {
      const id = await e.upsertNode(1, 'n', { props: {} })
      e.close()
      e.open()
      expect(e.deleteNode(id)).toBe(false)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: upsertNode with null name does not crash', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-null-name'))
    await e.open(); try {
      const id = await e.upsertNode(1, 'nulltest', { props: { name: null } })
      expect(e.getNode(id)).not.toBeNull()
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: neighbors of deleted node returns empty', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-nbr-del'))
    await e.open(); try {
      const id = await e.upsertNode(1, 'n', { props: {} })
      e.deleteNode(id)
      const nr = e.neighbors(id)
      expect(nr.edges.length).toBe(0)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: upsertEdge with both ends same node', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-self-loop'))
    await e.open(); try {
      const id = await e.upsertNode(1, 'self', { props: {} })
      await e.upsertEdge(id, id, 1, { props: {} })
      const nr = e.neighbors(id)
      expect(nr.edges.length).toBe(1)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: deleteNode on id 0 does not crash', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-zero-del'))
    await e.open(); try {
      const result = e.deleteNode(0)
      expect(result).toBe(false)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: getNodeByLabel with empty name returns null', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-lbl-em'))
    await e.open(); try {
      const n = e.getNodeByLabel(1, '')
      expect(n).toBeNull()
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: scanAllNodes after empty engine', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-scan0'))
    await e.open(); try {
      expect(e.scanAllNodes().length).toBe(0)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: deleteNode twice cascade does not explode', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-del-cas'))
    await e.open(); try {
      const id = await e.upsertNode(1, 'n', { props: {} })
      e.deleteNode(id, false, true)
      expect(e.deleteNode(id, false, true)).toBe(false)
    } finally { e.close() }
  }, 30000)
  // ═══════════════════════════════════════════════════════════════
  // V57-E2E CATEGORY 2 — Property Coercion / Edge Cases (15 tests)
  // ═══════════════════════════════════════════════════════════════
  it('V57-e2e: string prop with emoji and unicode', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-pr-emoji'))
    await e.open(); try {
      const id = await e.upsertNode(1, 'emoji', { props: { msg: '\u{1F525}\u{1F680}\u4F60\u597D\u4E16\u754C\u{1F60A}\u{1F31F}' } })
      const n = e.getNode(id)
      expect(n.props.msg).toBe('\u{1F525}\u{1F680}\u4F60\u597D\u4E16\u754C\u{1F60A}\u{1F31F}')
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: prop key with Unicode characters', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-pr-ukey'))
    await e.open(); try {
      const id = await e.upsertNode(1, 'uni', { props: { '\u5C5E\u6027\u540D': 42, '\u043A\u043B\u044E\u0447': 'value', '\u30AD\u30FC': 7 } })
      const n = e.getNode(id)
      expect(n.props['\u5C5E\u6027\u540D']).toBe(42)
      expect(n.props['\u043A\u043B\u044E\u0447']).toBe('value')
      expect(n.props['\u30AD\u30FC']).toBe(7)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: boolean only in props', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-pr-bool'))
    await e.open(); try {
      const id = await e.upsertNode(1, 'bools', { props: { a: true, b: false } })
      const n = e.getNode(id)
      expect(n.props.a).toBe(true)
      expect(n.props.b).toBe(false)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: nested mixed types object inside array inside object', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-pr-nest'))
    await e.open(); try {
      const id = await e.upsertNode(1, 'nested', { props: { outer: { inner: [1, 'two', { deep: true, vals: [3.14, null] }] }, flag: false } })
      const n = e.getNode(id)
      expect(n.props.outer.inner[2].deep).toBe(true)
      expect(n.props.outer.inner[2].vals[0]).toBe(3.14)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: prop value looks like JS prototype keys', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-pr-proto'))
    await e.open(); try {
      const id = await e.upsertNode(1, 'proto', { props: { __proto__: 'x', toString: 'y', constructor: 'z' } })
      const n = e.getNode(id)
      expect(n.props.__proto__).toBe('x')
      expect(n.props.toString).toBe('y')
      expect(n.props.constructor).toBe('z')
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: Date-like strings in props', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-pr-date'))
    await e.open(); try {
      const id = await e.upsertNode(1, 'dates', { props: { created: '2024-01-15T10:30:00Z', updated: '2024/12/31', ts: 'Jan 1, 2025' } })
      const n = e.getNode(id)
      expect(n.props.created).toBe('2024-01-15T10:30:00Z')
      expect(n.props.updated).toBe('2024/12/31')
      expect(n.props.ts).toBe('Jan 1, 2025')
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: large nested object deep path', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-pr-deep'))
    await e.open(); try {
      let deep = { val: 'root' }
      let cur = deep
      for (let i = 0; i < 100; i++) { cur.next = { val: 'l'+i, child: {} }; cur = cur.next }
      const id = await e.upsertNode(1, 'deep', { props: deep })
      const n = e.getNode(id)
      expect(n.props.val).toBe('root')
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: numeric props zero and negative', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-pr-num'))
    await e.open(); try {
      const id = await e.upsertNode(1, 'nums', { props: { zero: 0, neg: -1, float: -3.14, large: 1e15 } })
      const n = e.getNode(id)
      expect(n.props.zero).toBe(0)
      expect(n.props.neg).toBe(-1)
      expect(n.props.float).toBe(-3.14)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: array props with mixed types', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-pr-arr'))
    await e.open(); try {
      const id = await e.upsertNode(1, 'arr', { props: { list: [1, 'two', true, null, { x: 1 }, [2, 3]] } })
      const n = e.getNode(id)
      expect(Array.isArray(n.props.list)).toBe(true)
      expect(n.props.list[0]).toBe(1)
      expect(n.props.list[1]).toBe('two')
      expect(n.props.list[2]).toBe(true)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: null and undefined in props', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-pr-null'))
    await e.open(); try {
      const id = await e.upsertNode(1, 'nulls', { props: { a: null } })
      const n = e.getNode(id)
      expect('a' in n.props).toBe(true)
      expect(n.props.a).toBeNull()
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: empty object in props', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-pr-eo'))
    await e.open(); try {
      const id = await e.upsertNode(1, 'empty', { props: { data: {} } })
      const n = e.getNode(id)
      expect(typeof n.props.data).toBe('object')
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: empty array in props', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-pr-ea'))
    await e.open(); try {
      const id = await e.upsertNode(1, 'emptya', { props: { list: [] } })
      const n = e.getNode(id)
      expect(Array.isArray(n.props.list)).toBe(true)
      expect(n.props.list.length).toBe(0)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: prop key with special regex chars', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-pr-regex'))
    await e.open(); try {
      const id = await e.upsertNode(1, 'regexp', { props: { 'a.b': 1, 'c*d': 2, 'e[f]': 3, 'g^h': 4 } })
      const n = e.getNode(id)
      expect(n.props['a.b']).toBe(1)
      expect(n.props['c*d']).toBe(2)
      expect(n.props['e[f]']).toBe(3)
      expect(n.props['g^h']).toBe(4)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: very long string prop value', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-pr-long'))
    await e.open(); try {
      const longVal = new Array(5001).join('\u3042')
      const id = await e.upsertNode(1, 'long', { props: { text: longVal } })
      const n = e.getNode(id)
      expect(n.props.text.length).toBe(5000)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: prop value Infinity', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-pr-inf'))
    await e.open(); try {
      const id = await e.upsertNode(1, 'inf', { props: { v: Infinity, nv: -Infinity } })
      const n = e.getNode(id)
      expect(n.props.v).toBe(Infinity)
      expect(n.props.nv).toBe(-Infinity)
    } finally { e.close() }
  }, 30000)
  // ═══════════════════════════════════════════════════════════════
  // V57-E2E CATEGORY 3 — Complex Graph Patterns (15 tests)
  // ═══════════════════════════════════════════════════════════════
  it('V57-e2e: bidirectional edges between same pair', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-bi-edge'))
    await e.open(); try {
      const a = await e.upsertNode(1, 'a', { props: {} })
      const b = await e.upsertNode(2, 'b', { props: {} })
      await e.upsertEdge(a, b, 1, { props: { label: 'a->b' } })
      await e.upsertEdge(b, a, 2, { props: { label: 'b->a' } })
      expect(e.neighbors(a).edges.length).toBe(1)
      expect(e.neighbors(b).edges.length).toBe(1)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: triangle count verification', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-tri'))
    await e.open(); try {
      const ids = []
      for (let i = 0; i < 3; i++) ids.push(await e.upsertNode(1, 'v'+i, { props: {} }))
      for (let i = 0; i < 3; i++) for (let j = i+1; j < 3; j++) await e.upsertEdge(ids[i], ids[j], 1, { props: {} })
      expect(e.neighbors(ids[0]).edges.length).toBe(2)
      expect(e.neighbors(ids[1]).edges.length).toBe(2)
      expect(e.neighbors(ids[2]).edges.length).toBe(2)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: 2 separate components each with star', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-2star'))
    await e.open(); try {
      const centers = []
      for (let c = 0; c < 2; c++) {
        const center = await e.upsertNode(1, 'center'+c, { props: {} })
        centers.push(center)
        for (let l = 0; l < 5; l++) {
          const leaf = await e.upsertNode(2, 'leaf'+c+'-'+l, { props: {} })
          await e.upsertEdge(center, leaf, 1, { props: {} })
        }
      }
      expect(e.neighbors(centers[0]).edges.length).toBe(5)
      expect(e.neighbors(centers[1]).edges.length).toBe(5)
      expect(e.scanAllNodes().length).toBe(12)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: chain with branches tree topology', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-tree'))
    await e.open(); try {
      const root = await e.upsertNode(1, 'root', { props: {} })
      const children = []
      for (let i = 0; i < 3; i++) {
        const child = await e.upsertNode(2, 'child'+i, { props: {} })
        children.push(child)
        await e.upsertEdge(root, child, 1, { props: {} })
        for (let j = 0; j < 2; j++) {
          const leaf = await e.upsertNode(3, 'leaf'+i+'-'+j, { props: {} })
          await e.upsertEdge(child, leaf, 1, { props: {} })
        }
      }
      expect(e.neighbors(root).edges.length).toBe(3)
      for (const child of children) expect(e.neighbors(child).edges.length).toBe(2)
      expect(e.scanAllNodes().length).toBe(10)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: fully connected 5 nodes', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-k5'))
    await e.open(); try {
      const ids = []
      for (let i = 0; i < 5; i++) ids.push(await e.upsertNode(1, 'k'+i, { props: {} }))
      for (let i = 0; i < 5; i++) for (let j = i+1; j < 5; j++) await e.upsertEdge(ids[i], ids[j], 1, { props: {} })
      for (const id of ids) expect(e.neighbors(id).edges.length).toBe(4)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: bipartite graph verification', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-bip'))
    await e.open(); try {
      const left = [], right = []
      for (let i = 0; i < 3; i++) left.push(await e.upsertNode(1, 'l'+i, { props: {} }))
      for (let i = 0; i < 4; i++) right.push(await e.upsertNode(2, 'r'+i, { props: {} }))
      for (const l of left) for (const r of right) await e.upsertEdge(l, r, 1, { props: {} })
      for (const l of left) expect(e.neighbors(l).edges.length).toBe(4)
      for (const r of right) expect(e.neighbors(r).edges.length).toBe(3)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: node connected to everything in its type', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-all-con'))
    await e.open(); try {
      const hub = await e.upsertNode(1, 'hub', { props: {} })
      const others = []
      for (let i = 0; i < 7; i++) others.push(await e.upsertNode(1, 'n'+i, { props: {} }))
      for (const o of others) await e.upsertEdge(hub, o, 1, { props: {} })
      expect(e.neighbors(hub).edges.length).toBe(7)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: chain 50 long path verify end to end', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-chain50'))
    await e.open(); try {
      const ids = []
      for (let i = 0; i < 50; i++) ids.push(await e.upsertNode(1, 'n'+i, { props: {} }))
      for (let i = 0; i < 49; i++) await e.upsertEdge(ids[i], ids[i+1], 1, { props: {} })
      expect(e.neighbors(ids[0]).edges.length).toBe(1)
      expect(e.neighbors(ids[25]).edges.length).toBe(2)
      expect(e.neighbors(ids[49]).edges.length).toBe(1)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: star with 20 leaves neighbor count', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-star20'))
    await e.open(); try {
      const center = await e.upsertNode(1, 'center', { props: {} })
      for (let i = 0; i < 20; i++) {
        const leaf = await e.upsertNode(2, 'l'+i, { props: {} })
        await e.upsertEdge(center, leaf, 1, { props: {} })
      }
      expect(e.neighbors(center).edges.length).toBe(20)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: grid 4x4 mesh neighbor count', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-grid'))
    await e.open(); try {
      const grid = []
      for (let r = 0; r < 4; r++) {
        grid[r] = []
        for (let c = 0; c < 4; c++) grid[r][c] = await e.upsertNode(1, 'g'+r+'-'+c, { props: {} })
      }
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
        if (r+1 < 4) await e.upsertEdge(grid[r][c], grid[r+1][c], 1, { props: {} })
        if (c+1 < 4) await e.upsertEdge(grid[r][c], grid[r][c+1], 1, { props: {} })
      }
      expect(e.neighbors(grid[0][0]).edges.length).toBe(2)
      expect(e.neighbors(grid[1][1]).edges.length).toBe(4)
      expect(e.neighbors(grid[3][3]).edges.length).toBe(2)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: diamond graph pattern', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-diamond'))
    await e.open(); try {
      const a = await e.upsertNode(1, 'a', { props: {} })
      const b = await e.upsertNode(2, 'b', { props: {} })
      const c = await e.upsertNode(2, 'c', { props: {} })
      const d = await e.upsertNode(3, 'd', { props: {} })
      await e.upsertEdge(a, b, 1, { props: {} })
      await e.upsertEdge(a, c, 1, { props: {} })
      await e.upsertEdge(b, d, 1, { props: {} })
      await e.upsertEdge(c, d, 1, { props: {} })
      expect(e.neighbors(a).edges.length).toBe(2)
      expect(e.neighbors(b).edges.length).toBe(1)
      expect(e.neighbors(d).edges.length).toBe(2)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: 3-node line edges', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-line3'))
    await e.open(); try {
      const a = await e.upsertNode(1, 'a', { props: {} })
      const b = await e.upsertNode(1, 'b', { props: {} })
      const c = await e.upsertNode(1, 'c', { props: {} })
      await e.upsertEdge(a, b, 1, { props: {} })
      await e.upsertEdge(b, c, 1, { props: {} })
      expect(e.neighbors(a).edges.length).toBe(1)
      expect(e.neighbors(b).edges.length).toBe(2)
      expect(e.neighbors(c).edges.length).toBe(1)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: multi-edge multi-type star', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-multistar'))
    await e.open(); try {
      const center = await e.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 4; i++) {
        const leaf = await e.upsertNode(2, 'l'+i, { props: {} })
        await e.upsertEdge(center, leaf, i+1, { props: { t: i } })
      }
      expect(e.neighbors(center).edges.length).toBe(4)
    } finally { e.close() }
  }, 30000)
  // ═══════════════════════════════════════════════════════════════
  // V57-E2E CATEGORY 4 — Multi-type / Type-safe (15 tests)
  // ═══════════════════════════════════════════════════════════════
  it('V57-e2e: 50 types each 1 node scan all', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-50t1'))
    await e.open(); try {
      for (let t = 1; t <= 50; t++) await e.upsertNode(t, 'nt'+t, { props: {} })
      expect(e.scanAllNodes().length).toBe(50)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: same name 50 types verify getNode returns correct type', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-50t-sn'))
    await e.open(); try {
      for (let t = 1; t <= 50; t++) await e.upsertNode(t, 'sameName', { props: { typeId: t } })
      for (let t = 1; t <= 50; t++) {
        const n = e.getNodeByLabel(t, 'sameName')
        expect(n).not.toBeNull()
        expect(n.typeId).toBe(t)
      }
    } finally { e.close() }
  }, 60000)
  it('V57-e2e: edge between nodes of same type only', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-same-t'))
    await e.open(); try {
      const ids = []
      for (let i = 0; i < 6; i++) ids.push(await e.upsertNode(1, 's'+i, { props: {} }))
      for (let i = 0; i < 5; i++) await e.upsertEdge(ids[i], ids[i+1], 1, { props: {} })
      expect(e.scanAllNodes().length).toBe(6)
      expect(e.neighbors(ids[0]).edges.length).toBe(1)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: filter by type range > 10', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-t-range'))
    await e.open(); try {
      for (let t = 1; t <= 20; t++) await e.upsertNode(t, 'nt'+t, { props: { t } })
      for (let t = 11; t <= 20; t++) {
        const n = e.getNodeByLabel(t, 'nt'+t)
        expect(n).not.toBeNull()
        expect(n.typeId).toBeGreaterThan(10)
      }
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: update props on node preserves type', async () => {
    const e = new GraphEngine(makeConfig('v57-e2e-upd-t'))
    await e.open(); try {
      const id = await e.upsertNode(7, 'typed', { props: { old: 1 } })
      const n1 = e.getNode(id)
      expect(n1.typeId).toBe(7)
      await e.upsertNode(7, 'typed', { props: { old: 1, new: 2 } })
      const n2 = e.getNode(id)
      expect(n2.typeId).toBe(7)
      expect(n2.props.new).toBe(2)
    } finally { e.close() }
  }, 30000)
  it('V57-e2e: node with type Number MAX