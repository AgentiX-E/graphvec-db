// This file is NOT a test file. It contains code to be appended to each benchmark spec.
// Execute: python3 append-bench.py

// ====== throughput.spec.ts 追加内容（加到 describe 闭合 })} 之前） ======

  it('should measure upsertNode throughput x10', async () => {
    const engine = makeEngine('bench-tp1')
    try {
      const start = performance.now()
      for (let i = 0; i < 10; i++) {
        await engine.upsertNode(1, `tp-bulk-${i}`, { props: { seq: i } })
      }
      const elapsed = performance.now() - start
      console.log(`[BENCH][throughput] upsertNode x10: ${elapsed.toFixed(2)} ms total, ${(elapsed/10).toFixed(3)} ms/op`)
      expect(elapsed).toBeGreaterThan(0)
    } finally { engine.close() }
  }, 30000)

  it('should measure upsertNode throughput x50', async () => {
    const engine = makeEngine('bench-tp2')
    try {
      const start = performance.now()
      for (let i = 0; i < 50; i++) {
        await engine.upsertNode(1, `tp-bulk-${i}`, { props: { seq: i } })
      }
      const elapsed = performance.now() - start
      console.log(`[BENCH][throughput] upsertNode x50: ${elapsed.toFixed(2)} ms total, ${(elapsed/50).toFixed(3)} ms/op`)
      expect(elapsed).toBeGreaterThan(0)
    } finally { engine.close() }
  }, 30000)

  it('should measure upsertNode throughput x100', async () => {
    const engine = makeEngine('bench-tp3')
    try {
      const start = performance.now()
      for (let i = 0; i < 100; i++) {
        await engine.upsertNode(1, `tp-bulk-${i}`, { props: { seq: i } })
      }
      const elapsed = performance.now() - start
      console.log(`[BENCH][throughput] upsertNode x100: ${elapsed.toFixed(2)} ms total, ${(elapsed/100).toFixed(3)} ms/op`)
      expect(elapsed).toBeGreaterThan(0)
    } finally { engine.close() }
  }, 30000)

  it('should measure upsertEdge throughput x30', async () => {
    const engine = makeEngine('bench-tp4')
    try {
      const src = await engine.upsertNode(1, 'edge-src', { props: {} })
      const dst = await engine.upsertNode(1, 'edge-dst', { props: {} })
      const start = performance.now()
      for (let i = 0; i < 30; i++) {
        await engine.upsertEdge(src, dst, i, { props: {} })
      }
      const elapsed = performance.now() - start
      console.log(`[BENCH][throughput] upsertEdge x30: ${elapsed.toFixed(2)} ms total, ${(elapsed/30).toFixed(3)} ms/op`)
      expect(elapsed).toBeGreaterThan(0)
    } finally { engine.close() }
  }, 30000)

  it('should measure getNode throughput x100', async () => {
    const engine = makeEngine('bench-tp5')
    try {
      const ids: number[] = []
      for (let i = 0; i < 10; i++) {
        ids.push(await engine.upsertNode(1, `tp-get-${i}`, { props: {} }))
      }
      const start = performance.now()
      for (let i = 0; i < 100; i++) {
        engine.getNode(ids[i % ids.length])
      }
      const elapsed = performance.now() - start
      console.log(`[BENCH][throughput] getNode x100: ${elapsed.toFixed(2)} ms total, ${(elapsed/100).toFixed(3)} ms/op`)
      expect(elapsed).toBeGreaterThan(0)
    } finally { engine.close() }
  }, 30000)

  it('should measure scanAllNodes throughput with 100 nodes', async () => {
    const engine = makeEngine('bench-tp6')
    try {
      for (let i = 0; i < 100; i++) {
        await engine.upsertNode(1, `tp-scan-${i}`, { props: { seq: i } })
      }
      const start = performance.now()
      const nodes = engine.scanAllNodes()
      const elapsed = performance.now() - start
      console.log(`[BENCH][throughput] scanAllNodes 100 nodes: ${elapsed.toFixed(2)} ms, count=${nodes.length}`)
      expect(nodes.length).toBe(100)
    } finally { engine.close() }
  }, 30000)

  it('should measure neighbors throughput with 50 edges', async () => {
    const engine = makeEngine('bench-tp7')
    try {
      const src = await engine.upsertNode(1, 'nb-src', { props: {} })
      for (let i = 0; i < 50; i++) {
        const dst = await engine.upsertNode(1, `nb-dst-${i}`, { props: {} })
        await engine.upsertEdge(src, dst, 1, { props: {} })
      }
      const start = performance.now()
      const nbs = engine.neighbors(src)
      const elapsed = performance.now() - start
      console.log(`[BENCH][throughput] neighbors 50 edges: ${elapsed.toFixed(2)} ms, count=${nbs.length}`)
      expect(nbs.length).toBe(50)
    } finally { engine.close() }
  }, 30000)

  it('should measure deleteNode throughput x50', async () => {
    const engine = makeEngine('bench-tp8')
    try {
      const ids: number[] = []
      for (let i = 0; i < 50; i++) {
        ids.push(await engine.upsertNode(1, `tp-del-${i}`, { props: {} }))
      }
      const start = performance.now()
      for (const id of ids) {
        engine.deleteNode(id)
      }
      const elapsed = performance.now() - start
      console.log(`[BENCH][throughput] deleteNode x50: ${elapsed.toFixed(2)} ms total, ${(elapsed/50).toFixed(3)} ms/op`)
      expect(elapsed).toBeGreaterThan(0)
    } finally { engine.close() }
  }, 30000)

// ====== latency.spec.ts 追加内容 ======

  it('should measure upsertNode single latency (10 runs)', async () => {
    const engine = makeEngine('bench-lt1')
    try {
      const timings: number[] = []
      for (let r = 0; r < 10; r++) {
        const t0 = performance.now()
        await engine.upsertNode(1, `lt-${r}`, { props: { seq: r } })
        timings.push(performance.now() - t0)
      }
      timings.sort((a, b) => a - b)
      const median = timings[4]
      console.log(`[BENCH][latency] upsertNode single (10 runs): min=${timings[0].toFixed(3)} median=${median.toFixed(3)} max=${timings[9].toFixed(3)} ms`)
      expect(median).toBeGreaterThan(0)
    } finally { engine.close() }
  }, 30000)

  it('should measure upsertEdge single latency (10 runs)', async () => {
    const engine = makeEngine('bench-lt2')
    try {
      const src = await engine.upsertNode(1, 'lt-src', { props: {} })
      const dst = await engine.upsertNode(1, 'lt-dst', { props: {} })
      const timings: number[] = []
      for (let r = 0; r < 10; r++) {
        const t0 = performance.now()
        await engine.upsertEdge(src, dst, r % 2, { props: {} })
        timings.push(performance.now() - t0)
      }
      timings.sort((a, b) => a - b)
      console.log(`[BENCH][latency] upsertEdge single: median=${timings[4].toFixed(3)} ms`)
      expect(timings[4]).toBeGreaterThan(0)
    } finally { engine.close() }
  }, 30000)

  it('should measure getNode single latency (20 runs)', async () => {
    const engine = makeEngine('bench-lt3')
    try {
      const id = await engine.upsertNode(1, 'lt-get', { props: { val: 42 } })
      const timings: number[] = []
      for (let r = 0; r < 20; r++) {
        const t0 = performance.now()
        engine.getNode(id)
        timings.push(performance.now() - t0)
      }
      timings.sort((a, b) => a - b)
      console.log(`[BENCH][latency] getNode single (20 runs): min=${timings[0].toFixed(3)} median=${timings[9].toFixed(3)} max=${timings[19].toFixed(3)} ms`)
      expect(timings[0]).toBeGreaterThanOrEqual(0)
    } finally { engine.close() }
  }, 30000)

  it('should measure scanAllNodes latency at different sizes', async () => {
    const engine = makeEngine('bench-lt4')
    try {
      // Small
      for (let i = 0; i < 10; i++) await engine.upsertNode(1, `lt-scan-${i}`, { props: {} })
      let t0 = performance.now()
      let r1 = engine.scanAllNodes().length
      let t1 = performance.now() - t0

      // Medium
      for (let i = 10; i < 60; i++) await engine.upsertNode(1, `lt-scan-${i}`, { props: {} })
      t0 = performance.now()
      let r2 = engine.scanAllNodes().length
      let t2 = performance.now() - t0

      console.log(`[BENCH][latency] scanAllNodes: 10nodes=${t1.toFixed(3)}ms count=${r1}, 60nodes=${t2.toFixed(3)}ms count=${r2}`)
      expect(r1).toBe(10)
      expect(r2).toBe(60)
    } finally { engine.close() }
  }, 30000)

  it('should measure neighbors latency at 20 edges', async () => {
    const engine = makeEngine('bench-lt5')
    try {
      const src = await engine.upsertNode(1, 'lt-nb-src', { props: {} })
      for (let i = 0; i < 20; i++) {
        const dst = await engine.upsertNode(1, `lt-nb-${i}`, { props: {} })
        await engine.upsertEdge(src, dst, 1, { props: {} })
      }
      const timings: number[] = []
      for (let r = 0; r < 5; r++) {
        const t0 = performance.now()
        engine.neighbors(src)
        timings.push(performance.now() - t0)
      }
      timings.sort((a, b) => a - b)
      console.log(`[BENCH][latency] neighbors (20 edges, 5 runs): median=${timings[2].toFixed(3)} ms`)
      expect(timings[0]).toBeGreaterThanOrEqual(0)
    } finally { engine.close() }
  }, 30000)

// ====== scalability.spec.ts 追加内容 ======

  it('should scale getNode latency at 10/50/100/200 nodes', async () => {
    const engine = makeEngine('bench-sc1')
    try {
      const sizes = [10, 50, 100, 200]
      for (const n of sizes) {
        // Seed n nodes
        for (let i = 0; i < n; i++) {
          await engine.upsertNode(1, `sc-${n}-${i}`, { props: { seq: i } })
        }
        const nodes = engine.scanAllNodes()
        const t0 = performance.now()
        engine.getNode(nodes[0])
        const elapsed = performance.now() - t0
        console.log(`[BENCH][scalability] getNode at ${n} nodes: ${elapsed.toFixed(3)} ms`)
        expect(elapsed).toBeGreaterThanOrEqual(0)
      }
    } finally { engine.close() }
  }, 30000)

  it('should scale scanAllNodes latency with node count', async () => {
    const engine = makeEngine('bench-sc2')
    try {
      const sizes = [10, 50, 100]
      for (const n of sizes) {
        for (let i = 0; i < n; i++) {
          await engine.upsertNode(1, `sc-scan-${n}-${i}`, { props: {} })
        }
        const t0 = performance.now()
        const count = engine.scanAllNodes().length
        const elapsed = performance.now() - t0
        console.log(`[BENCH][scalability] scanAllNodes at ${n}: ${elapsed.toFixed(3)} ms, count=${count}`)
        expect(count).toBe(n)
      }
    } finally { engine.close() }
  }, 30000)

  it('should scale neighbors with varying edge density', async () => {
    const engine = makeEngine('bench-sc3')
    try {
      const densities = [5, 10, 20]
      for (const d of densities) {
        const src = await engine.upsertNode(1, `sc-dense-${d}`, { props: {} })
        for (let i = 0; i < d; i++) {
          const dst = await engine.upsertNode(1, `sc-dst-${d}-${i}`, { props: {} })
          await engine.upsertEdge(src, dst, 1, { props: {} })
        }
        const t0 = performance.now()
        const nbs = engine.neighbors(src)
        const elapsed = performance.now() - t0
        console.log(`[BENCH][scalability] neighbors ${d} edges: ${elapsed.toFixed(3)} ms`)
        expect(nbs.length).toBe(d)
      }
    } finally { engine.close() }
  }, 30000)

  it('should scale upsertNode with different typeId counts', async () => {
    const engine = makeEngine('bench-sc4')
    try {
      const typeCounts = [1, 3, 5]
      for (const tc of typeCounts) {
        const t0 = performance.now()
        for (let i = 0; i < 10; i++) {
          await engine.upsertNode((i % tc) + 1, `sc-type-${tc}-${i}`, { props: {} })
        }
        const elapsed = performance.now() - t0
        console.log(`[BENCH][scalability] upsertNode 10 nodes with ${tc} types: ${elapsed.toFixed(3)} ms`)
        expect(elapsed).toBeGreaterThan(0)
      }
    } finally { engine.close() }
  }, 30000)

