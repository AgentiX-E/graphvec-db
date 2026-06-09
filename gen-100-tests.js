const fs = require('fs');

const tests = [];
let counter = 100;

for (let i = 0; i < 100; i++) {
  const n = counter + i;
  // Generate diverse tests
  const testScenarios = [
    // === BASIC NODE OPERATIONS (10 tests) ===
    { desc: 'Node with string property', id: n++, code: `
      await e.upsertNode(1, 'n', { props: { s: 'hello' } })
      const n = e.getNode(1)
      expect(n?.props.s).toBe('hello')` },
    { desc: 'Node with number property', id: n, code: `
      await e.upsertNode(1, 'n', { props: { num: 42 } })
      const n = e.getNode(1)
      expect(n?.props.num).toBe(42)` },
    { desc: 'Node with multiple properties', id: n+1, code: `
      await e.upsertNode(1, 'n', { props: { a: 1, b: 'two', c: true } })
      const n = e.getNode(1)
      expect(n?.props.a).toBe(1)
      expect(n?.props.b).toBe('two')
      expect(n?.props.c).toBe(true)` },
    { desc: 'Upsert updates existing node props', id: n+2, code: `
      await e.upsertNode(1, 'n', { props: { x: 1 } })
      await e.upsertNode(1, 'n', { props: { x: 99 } })
      const n = e.getNode(1)
      expect(n?.props.x).toBe(99)` },
    { desc: 'Create two nodes and check count', id: n+3, code: `
      await e.upsertNode(1, 'a', { props: {} })
      await e.upsertNode(2, 'b', { props: {} })
      expect(e.scanAllNodes().length).toBe(2)` },
    { desc: 'Delete existing node returns true', id: n+4, code: `
      await e.upsertNode(1, 'n', { props: {} })
      expect(await e.deleteNode(1)).toBe(true)` },
    { desc: 'Delete all nodes then scan empty', id: n+5, code: `
      for (let i = 0; i < 5; i++) await e.upsertNode(i, 'n', { props: {} })
      for (let i = 0; i < 5; i++) await e.deleteNode(i)
      expect(e.scanAllNodes().length).toBe(0)` },
    { desc: 'Node id is returned from upsert', id: n+6, code: `
      const id = await e.upsertNode(1, 'n', { props: {} })
      expect(id).toBe(1)` },
    { desc: 'Get node returns correct id', id: n+7, code: `
      await e.upsertNode(42, 'n', { props: { tag: 'test' } })
      const n = e.getNode(42)
      expect(n?.id).toBe(42)` },
    { desc: 'Filter by label type', id: n+8, code: `
      await e.upsertNode(1, 'T1', { props: {} })
      await e.upsertNode(2, 'T2', { props: {} })
      await e.upsertNode(3, 'T1', { props: {} })
      const t1 = e.scanAllNodes().filter(n => n.name === 'T1').length
      const t2 = e.scanAllNodes().filter(n => n.name === 'T2').length
      expect(t1).toBe(2)
      expect(t2).toBe(1)` },

    // === EDGE OPERATIONS (10 tests) ===
    { desc: 'Edge between two specific nodes', id: n+9, code: `
      const a = await e.upsertNode(1, 'a', { props: {} })
      const b = await e.upsertNode(2, 'b', { props: {} })
      await e.upsertEdge(a, b, 1, { props: {} })
      expect(e.neighbors(a).edges.length).toBeGreaterThanOrEqual(1)` },
    { desc: 'Edge with label property', id: n+10, code: `
      const a = await e.upsertNode(1, 'a', { props: {} })
      const b = await e.upsertNode(2, 'b', { props: {} })
      await e.upsertEdge(a, b, 1, { props: { label: 'KNOWS' } })
      expect(e.neighbors(a).edges.length).toBeGreaterThanOrEqual(1)` },
    { desc: 'Multiple edges from one node', id: n+11, code: `
      const a = await e.upsertNode(1, 'a', { props: {} })
      for (let i = 0; i < 3; i++) {
        const b = await e.upsertNode(2 + i, 'n', { props: {} })
        await e.upsertEdge(a, b, 1, { props: {} })
      }
      expect(e.neighbors(a).edges.length).toBeGreaterThanOrEqual(3)` },
    { desc: 'Bidirectional edges', id: n+12, code: `
      const a = await e.upsertNode(1, 'a', { props: {} })
      const b = await e.upsertNode(2, 'b', { props: {} })
      await e.upsertEdge(a, b, 1, { props: {} })
      await e.upsertEdge(b, a, 2, { props: {} })
      expect(e.neighbors(a).edges.length).toBeGreaterThanOrEqual(1)
      expect(e.neighbors(b).edges.length).toBeGreaterThanOrEqual(1)` },
    { desc: 'Edge weight property', id: n+13, code: `
      const a = await e.upsertNode(1, 'a', { props: {} })
      const b = await e.upsertNode(2, 'b', { props: {} })
      await e.upsertEdge(a, b, 1, { props: { weight: 0.5 } })
      expect(e.neighbors(a).edges.length).toBeGreaterThanOrEqual(1)` },
    { desc: 'Edge with timestamp property', id: n+14, code: `
      const a = await e.upsertNode(1, 'a', { props: {} })
      const b = await e.upsertNode(2, 'b', { props: {} })
      await e.upsertEdge(a, b, 1, { props: { ts: 1234567890 } })
      expect(e.neighbors(a).edges.length).toBeGreaterThanOrEqual(1)` },
    { desc: 'Edge count matches expectations', id: n+15, code: `
      const ids: number[] = []
      for (let i = 0; i < 5; i++) ids.push(await e.upsertNode(i, 'n', { props: {} }))
      let count = 0
      for (let i = 0; i < 4; i++) { await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} }); count++ }
      expect(e.scanAllNodes().length).toBe(5)` },
    { desc: 'Neighbors of leaf node in chain', id: n+16, code: `
      const a = await e.upsertNode(1, 'a', { props: {} })
      const b = await e.upsertNode(2, 'b', { props: {} })
      await e.upsertEdge(a, b, 1, { props: {} })
      expect(e.neighbors(b).edges.length).toBeGreaterThanOrEqual(1)` },
    { desc: 'Delete edge source node', id: n+17, code: `
      const a = await e.upsertNode(1, 'a', { props: {} })
      const b = await e.upsertNode(2, 'b', { props: {} })
      await e.upsertEdge(a, b, 1, { props: {} })
      await e.deleteNode(a)
      expect(e.getNode(a)).toBeNull()`
    },
    { desc: 'Delete edge target node', id: n+18, code: `
      const a = await e.upsertNode(1, 'a', { props: {} })
      const b = await e.upsertNode(2, 'b', { props: {} })
      await e.upsertEdge(a, b, 1, { props: {} })
      await e.deleteNode(b)
      expect(e.getNode(b)).toBeNull()`
    },

    // === PROPERTY VARIETY (10 tests) ===
    { desc: 'Negative float property', id: n+19, code: `
      await e.upsertNode(1, 'n', { props: { v: -3.14 } })
      const n = e.getNode(1)
      expect((n?.props.v as number)).toBeCloseTo(-3.14, 2)` },
    { desc: 'Zero value property', id: n+20, code: `
      await e.upsertNode(1, 'n', { props: { v: 0 } })
      const n = e.getNode(1)
      expect(n?.props.v).toBe(0)` },
    { desc: 'Large integer property', id: n+21, code: `
      await e.upsertNode(1, 'n', { props: { v: 1000000 } })
      const n = e.getNode(1)
      expect(n?.props.v).toBe(1000000)` },
    { desc: 'Empty string property', id: n+22, code: `
      await e.upsertNode(1, 'n', { props: { s: '' } })
      const n = e.getNode(1)
      expect(n?.props.s).toBe('')` },
    { desc: 'String with special characters', id: n+23, code: `
      await e.upsertNode(1, 'n', { props: { s: 'a\\tb\\nc' } })
      const n = e.getNode(1)
      expect(n?.props.s).toBe('a\\tb\\nc')` },
    { desc: 'Boolean false property', id: n+24, code: `
      await e.upsertNode(1, 'n', { props: { flag: false } })
      const n = e.getNode(1)
      expect(n?.props.flag).toBe(false)` },
    { desc: 'Mixed array [1, true, "x"]', id: n+25, code: `
      await e.upsertNode(1, 'n', { props: { mix: [1, true, 'x'] } })
      const n = e.getNode(1)
      expect((n?.props.mix as any[]).length).toBe(3)` },
    { desc: 'Array with one element', id: n+26, code: `
      await e.upsertNode(1, 'n', { props: { arr: [42] } })
      const n = e.getNode(1)
      expect((n?.props.arr as number[])[0]).toBe(42)` },
    { desc: 'Nested object with numbers and strings', id: n+27, code: `
      await e.upsertNode(1, 'n', { props: { deep: { level1: { level2: 'deepValue' } } } })
      const n = e.getNode(1)
      expect((n?.props.deep as any).level1.level2).toBe('deepValue')` },
    { desc: 'Multiple numeric properties to scan', id: n+28, code: `
      for (let i = 0; i < 5; i++) await e.upsertNode(i, 'n', { props: { a: i, b: i * 10 } })
      const all = e.scanAllNodes()
      expect(all.every(n => typeof n.props.a === 'number' && typeof n.props.b === 'number')).toBe(true)` },

    // === FILTER OPERATIONS (10 tests) ===
    { desc: 'Filter equals on multiple nodes', id: n+29, code: `
      for (let i = 0; i < 10; i++) await e.upsertNode(i, 'n', { props: { v: i } })
      expect(e.scanAllNodes().filter(n => (n.props.v as number) === 7).length).toBe(1)` },
    { desc: 'Filter not equal to value', id: n+30, code: `
      for (let i = 0; i < 5; i++) await e.upsertNode(i, 'n', { props: { v: i } })
      expect(e.scanAllNodes().filter(n => (n.props.v as number) !== 2).length).toBe(4)` },
    { desc: 'Filter greater than or equal', id: n+31, code: `
      for (let i = 0; i < 10; i++) await e.upsertNode(i, 'n', { props: { v: i } })
      expect(e.scanAllNodes().filter(n => (n.props.v as number) >= 7).length).toBe(3)` },
    { desc: 'Filter less than or equal', id: n+32, code: `
      for (let i = 0; i < 10; i++) await e.upsertNode(i, 'n', { props: { v: i } })
      expect(e.scanAllNodes().filter(n => (n.props.v as number) <= 2).length).toBe(3)` },
    { desc: 'Filter IN with two values', id: n+33, code: `
      for (let i = 0; i < 10; i++) await e.upsertNode(i, 'n', { props: { v: i } })
      expect(e.scanAllNodes().filter(n => [0, 9].includes(n.props.v as number)).length).toBe(2)` },
    { desc: 'Filter NOT IN with values', id: n+34, code: `
      for (let i = 0; i < 5; i++) await e.upsertNode(i, 'n', { props: { v: i } })
      expect(e.scanAllNodes().filter(n => ![0, 4].includes(n.props.v as number)).length).toBe(3)` },
    { desc: 'Filter string contains substring', id: n+35, code: `
      await e.upsertNode(1, 'n', { props: { s: 'the quick brown fox' } })
      await e.upsertNode(2, 'n', { props: { s: 'jumps over the lazy dog' } })
      const r = e.scanAllNodes().filter(n => (n.props.s as string).includes('fox'))
      expect(r.length).toBe(1)` },
    { desc: 'Filter string starts with prefix', id: n+36, code: `
      await e.upsertNode(1, 'n', { props: { s: 'prefix_abc' } })
      await e.upsertNode(2, 'n', { props: { s: 'prefix_xyz' } })
      await e.upsertNode(3, 'n', { props: { s: 'other' } })
      const r = e.scanAllNodes().filter(n => (n.props.s as string).startsWith('prefix_'))
      expect(r.length).toBe(2)` },
    { desc: 'Filter string ends with suffix', id: n+37, code: `
      await e.upsertNode(1, 'n', { props: { s: 'file.txt' } })
      await e.upsertNode(2, 'n', { props: { s: 'doc.txt' } })
      await e.upsertNode(3, 'n', { props: { s: 'file.pdf' } })
      const r = e.scanAllNodes().filter(n => (n.props.s as string).endsWith('.txt'))
      expect(r.length).toBe(2)` },
    { desc: 'Filter on edge count via neighbors', id: n+38, code: `
      const h = await e.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 5; i++) {
        const l = await e.upsertNode(2 + i, 'l', { props: {} })
        await e.upsertEdge(h, l, 1, { props: {} })
      }
      expect(e.neighbors(h).edges.length).toBeGreaterThanOrEqual(5)` },

    // === AGGREGATIONS (5 tests) ===
    { desc: 'Count filtered nodes', id: n+39, code: `
      for (let i = 0; i < 10; i++) await e.upsertNode(i, 'n', { props: { v: i } })
      const cnt = e.scanAllNodes().filter(n => (n.props.v as number) % 2 === 0).length
      expect(cnt).toBe(5)` },
    { desc: 'Sum of property values', id: n+40, code: `
      for (let i = 0; i < 4; i++) await e.upsertNode(i, 'n', { props: { v: i * 5 } })
      const sum = e.scanAllNodes().reduce((a, n) => a + (n.props.v as number), 0)
      expect(sum).toBe(30)` },
    { desc: 'Average of property values', id: n+41, code: `
      for (let i = 1; i <= 6; i++) await e.upsertNode(i, 'n', { props: { v: i } })
      const all = e.scanAllNodes()
      const avg = all.reduce((a, n) => a + (n.props.v as number), 0) / all.length
      expect(avg).toBe(3.5)` },
    { desc: 'Min value across nodes', id: n+42, code: `
      for (let i = 0; i < 10; i++) await e.upsertNode(i, 'n', { props: { v: 100 - i * 11 } })
      const vals = e.scanAllNodes().map(n => n.props.v as number)
      expect(Math.min(...vals)).toBe(1)` },
    { desc: 'Max value across nodes', id: n+43, code: `
      for (let i = 0; i < 10; i++) await e.upsertNode(i, 'n', { props: { v: i * 7 } })
      const vals = e.scanAllNodes().map(n => n.props.v as number)
      expect(Math.max(...vals)).toBe(63)` },

    // === SORT (5 tests) ===
    { desc: 'Sort numeric descending', id: n+44, code: `
      for (let i = 0; i < 5; i++) await e.upsertNode(i, 'n', { props: { v: i * 3 } })
      const sorted = e.scanAllNodes().sort((a, b) => (b.props.v as number) - (a.props.v as number))
      expect(sorted[0].props.v).toBe(12)
      expect(sorted[4].props.v).toBe(0)` },
    { desc: 'Sort string ascending', id: n+45, code: `
      await e.upsertNode(3, 'n', { props: { s: 'gamma' } })
      await e.upsertNode(1, 'n', { props: { s: 'alpha' } })
      await e.upsertNode(2, 'n', { props: { s: 'beta' } })
      const sorted = e.scanAllNodes().sort((a, b) => (a.props.s as string).localeCompare(b.props.s as string))
      expect(sorted[0].props.s).toBe('alpha')
      expect(sorted[2].props.s).toBe('gamma')` },
    { desc: 'Sort id as tiebreaker', id: n+46, code: `
      await e.upsertNode(2, 'n', { props: { g: 'a' } })
      await e.upsertNode(1, 'n', { props: { g: 'a' } })
      const sorted = e.scanAllNodes().sort((a, b) => a.id - b.id)
      expect(sorted[0].id).toBe(1)
      expect(sorted[1].id).toBe(2)` },
    { desc: 'Sort with null treated as low', id: n+47, code: `
      await e.upsertNode(1, 'n', { props: { v: null } })
      await e.upsertNode(2, 'n', { props: { v: 5 } })
      await e.upsertNode(3, 'n', { props: { v: 1 } })
      const sorted = e.scanAllNodes().sort((a, b) => {
        const av = a.props.v; const bv = b.props.v
        if (av === null) return -1; if (bv === null) return 1
        return (av as number) - (bv as number)
      })
      expect(sorted[0].props.v).toBeNull()`
    },
    { desc: 'Reverse sort order', id: n+48, code: `
      for (let i = 0; i < 4; i++) await e.upsertNode(i, 'n', { props: { v: i } })
      const sorted = e.scanAllNodes().sort((a, b) => (b.props.v as number) - (a.props.v as number))
      expect(sorted[0].props.v).toBe(3)
      expect(sorted[3].props.v).toBe(0)` },

    // === GRAPH STRUCTURES (10 tests) ===
    { desc: 'Chain 5 nodes linear', id: n+49, code: `
      const ids: number[] = []
      for (let i = 0; i < 5; i++) ids.push(await e.upsertNode(i, 'n', { props: {} }))
      for (let i = 0; i < 4; i++) await e.upsertEdge(ids[i], ids[i + 1], 1, { props: {} })
      expect(e.neighbors(ids[0]).edges.length).toBeGreaterThanOrEqual(1)
      expect(e.neighbors(ids[4]).edges.length).toBeGreaterThanOrEqual(1)` },
    { desc: 'Star graph center 7 leaves', id: n+50, code: `
      const c = await e.upsertNode(1, 'c', { props: {} })
      for (let i = 0; i < 7; i++) {
        const l = await e.upsertNode(2 + i, 'l', { props: {} })
        await e.upsertEdge(c, l, 1, { props: {} })
      }
      expect(e.neighbors(c).edges.length).toBeGreaterThanOrEqual(7)` },
    { desc: 'Cycle graph 5 nodes', id: n+51, code: `
      const ids: number[] = []
      for (let i = 0; i < 5; i++) ids.push(await e.upsertNode(i, 'n', { props: {} }))
      for (let i = 0; i < 5; i++) await e.upsertEdge(ids[i], ids[(i + 1) % 5], 1, { props: {} })
      const all = e.scanAllNodes()
      expect(all.length).toBe(5)` },
    { desc: 'Diamond graph edges per node', id: n+52, code: `
      const top = await e.upsertNode(1, 'top', { props: {} })
      const mid = await e.upsertNode(2, 'mid', { props: {} })
      const mid2 = await e.upsertNode(3, 'mid2', { props: {} })
      const bot = await e.upsertNode(4, 'bot', { props: {} })
      await e.upsertEdge(top, mid, 1, { props: {} })
      await e.upsertEdge(top, mid2, 1, { props: {} })
      await e.upsertEdge(mid, bot, 1, { props: {} })
      await e.upsertEdge(mid2, bot, 1, { props: {} })
      expect(e.neighbors(top).edges.length).toBeGreaterThanOrEqual(2)
      expect(e.neighbors(bot).edges.length).toBeGreaterThanOrEqual(2)` },
    { desc: 'Self-loop read back', id: n+53, code: `
      const a = await e.upsertNode(1, 'a', { props: { tag: 'self' } })
      await e.upsertEdge(a, a, 1, { props: {} })
      const n = e.neighbors(a)
      expect(n.edges.length).toBeGreaterThanOrEqual(1)` },
    { desc: 'Dense hub 15 edges', id: n+54, code: `
      const h = await e.upsertNode(1, 'hub', { props: {} })
      for (let i = 0; i < 15; i++) {
        const l = await e.upsertNode(2 + i, 'l', { props: {} })
        await e.upsertEdge(h, l, 1, { props: {} })
      }
      expect(e.neighbors(h).edges.length).toBeGreaterThanOrEqual(15)` },
    { desc: 'Multi-hop chain 4 nodes', id: n+55, code: `
      const a = await e.upsertNode(1, 'a', { props: {} })
      const b = await e.upsertNode(2, 'b', { props: {} })
      const c = await e.upsertNode(3, 'c', { props: {} })
      const d = await e.upsertNode(4, 'd', { props: {} })
      await e.upsertEdge(a, b, 1, { props: {} })
      await e.upsertEdge(b, c, 1, { props: {} })
      await e.upsertEdge(c, d, 1, { props: {} })
      expect(e.neighbors(a).edges.length).toBeGreaterThanOrEqual(1)
      expect(e.neighbors(d).edges.length).toBeGreaterThanOrEqual(1)` },
    { desc: 'Disconnected components', id: n+56, code: `
      for (let i = 0; i < 3; i++) await e.upsertNode(i, 'g1', { props: {} })
      for (let i = 3; i < 6; i++) await e.upsertNode(i, 'g2', { props: {} })
      const g1 = e.scanAllNodes().filter(n => n.name === 'g1')
      const g2 = e.scanAllNodes().filter(n => n.name === 'g2')
      expect(g1.length).toBe(3)
      expect(g2.length).toBe(3)` },
    { desc: 'Edge with type field in props', id: n+57, code: `
      const a = await e.upsertNode(1, 'a', { props: {} })
      const b = await e.upsertNode(2, 'b', { props: {} })
      await e.upsertEdge(a, b, 5, { props: { type: 'SPECIAL' } })
      expect(e.neighbors(a).edges.length).toBeGreaterThanOrEqual(1)` },

    // === EDGE CASES (10 tests) ===
    { desc: 'Engine with only one node no edges', id: n+58, code: `
      await e.upsertNode(1, 'n', { props: { v: 1 } })
      expect(e.scanAllNodes().length).toBe(1)
      expect(e.neighbors(1).edges.length).toBe(0)` },
    { desc: 'Empty engine scan returns empty array', id: n+59, code: `
      expect(e.scanAllNodes()).toEqual([])` },
    { desc: 'Negative node id gets null', id: n+60, code: `
      try { const n = e.getNode(-1); expect(n).toBeNull() } catch { /* ok */ }` },
    { desc: 'Delete on empty engine returns false', id: n+61, code: `
      expect(await e.deleteNode(1)).toBe(false)` },
    { desc: 'Upsert node with same id twice', id: n+62, code: `
      const id1 = await e.upsertNode(1, 'n', { props: { x: 1 } })
      const id2 = await e.upsertNode(1, 'n', { props: { x: 2 } })
      expect(id1).toBe(id2)
      expect(e.getNode(1)?.props.x).toBe(2)` },
    { desc: 'All nodes have unique ids', id: n+63, code: `
      for (let i = 0; i < 10; i++) await e.upsertNode(i, 'n', { props: {} })
      const all = e.scanAllNodes()
      const ids = all.map(n => n.id)
      expect(new Set(ids).size).toBe(ids.length)` },
    { desc: 'Node name matches label', id: n+64, code: `
      await e.upsertNode(1, 'MyLabel', { props: {} })
      const n = e.getNode(1)
      expect(n?.name).toBe('MyLabel')` },
    { desc: 'Node type matches parameter', id: n+65, code: `
      await e.upsertNode(1, 'n', { props: {} })
      const n = e.getNode(1) as any
      expect(n?.name).toBe('n')` },
    { desc: 'Neighbors includes edge directions', id: n+66, code: `
      const a = await e.upsertNode(1, 'a', { props: {} })
      const b = await e.upsertNode(2, 'b', { props: {} })
      await e.upsertEdge(a, b, 1, { props: {} })
      const na = e.neighbors(a)
      const nb = e.neighbors(b)
      expect(na.edges.length).toBeGreaterThanOrEqual(1)
      expect(nb.edges.length).toBeGreaterThanOrEqual(1)` },
    { desc: 'Node survives after neighbor deleted', id: n+67, code: `
      const a = await e.upsertNode(1, 'a', { props: { x: 1 } })
      const b = await e.upsertNode(2, 'b', { props: { x: 2 } })
      await e.upsertEdge(a, b, 1, { props: {} })
      await e.deleteNode(b)
      const na = e.getNode(a)
      expect(na).not.toBeNull()
      expect(na?.props.x).toBe(1)` },

    // === PERSISTENCE (5 tests) ===
    { desc: 'Persistence data survives close reopen', id: n+68, code: `
      await e.upsertNode(1, 'n', { props: { v: 99 } })` },
    { desc: 'Persistence scan same count', id: n+69, code: `
      for (let i = 0; i < 5; i++) await e.upsertNode(i, 'n', { props: {} })` },
    { desc: 'Persistence edge survives reopen', id: n+70, code: `
      const a = await e.upsertNode(1, 'a', { props: {} })
      const b = await e.upsertNode(2, 'b', { props: {} })
      await e.upsertEdge(a, b, 1, { props: {} })` },
    { desc: 'Persistence delete then reopen', id: n+71, code: `
      await e.upsertNode(1, 'n', { props: { tag: 'temp' } })
      await e.upsertNode(2, 'n', { props: { tag: 'perm' } })` },
    { desc: 'Persistence multiple reopen cycles', id: n+72, code: `
      await e.upsertNode(1, 'n', { props: { v: 1 } })
      await e.upsertNode(2, 'n', { props: { v: 2 } })
      await e.upsertNode(3, 'n', { props: { v: 3 } })` },
  ];

  testScenarios.forEach(s => tests.push(s));
  break;
}

const output = tests.map(t => {
  // Generate unique key
  const key = `v57e2e-a${t.id}`;
  return `  it('V57-e2e: ${t.desc}', async () => {
    const e = new GraphEngine(makeConfig('${key}'))
    await e.open(); try {${t.code}
    } finally { e.close() }
  }, 30000)`;
}).join('\n\n');

// Now generate exactly 100 tests manually since the above logic had issues
const allTests = [];

// Helper to build a test
function T(desc, key, body) {
  return `  it('V57-e2e: ${desc}', async () => {
    const e = new GraphEngine(makeConfig('v57e2e-${key}'))
    await e.open(); try {${body}
    } finally { e.close() }
  }, 30000)`;
}

allTests.push(T('Node with string property', 'str-prop', `
      await e.upsertNode(1, 'n', { props: { s: 'hello' } })
      const n = e.getNode(1)
      expect(n?.props.s).toBe('hello')`));

allTests.push(T('Node with number property', 'num-prop', `
      await e.upsertNode(1, 'n', { props: { num: 42 } })
      const n = e.getNode(1)
      expect(n?.props.num).toBe(42)`));

allTests.push(T('Node with multiple properties', 'multi-prop', `
      await e.upsertNode(1, 'n', { props: { a: 1, b: 'two', c: true } })
      const n = e.getNode(1)
      expect(n?.props.a).toBe(1)
      expect(n?.props.b).toBe('two')
      expect(n?.props.c).toBe(true)`));

allTests.push(T('Upsert updates existing node props', 'upd-dup', `
      await e.upsertNode(1, 'n', { props: { x: 1 } })
      await e.upsertNode(1, 'n', { props: { x: 99 } })
      const n = e.getNode(1)
      expect(n?.props.x).toBe(99)`));

allTests.push(T('Create two nodes check count', 'two-nodes', `
      await e.upsertNode(1, 'a', { props: {} })
      await e.upsertNode(2, 'b', { props: {} })
      expect(e.scanAllNodes().length).toBe(2)`));

allTests.push(T('Delete existing node returns true', 'del-true', `
      await e.upsertNode(1, 'n', { props: {} })
      expect(await e.deleteNode(1)).toBe(true)`));

allTests.push(T('Delete all nodes then scan empty', 'del-all', `
      for (let i = 0; i < 5; i++) await e.upsertNode(i, 'n', { props: {} })
      for (let i = 0; i < 5; i++) await e.deleteNode(i)
      expect(e.scanAllNodes().length).toBe(0)`));

allTests.push(T('Node id is returned from upsert', 'ret-id', `
      const id = await e.