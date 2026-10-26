import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/test-utils/**',
        'src/security/__mocks__/**',
        'src/**/*.d.ts',
        // Benchmark harness code (runner/reporter/gate/ldbc-snb loaders) is
        // test infrastructure, not product functionality. It is exercised only
        // when the benchmark suites are run explicitly and has no meaningful
        // functional coverage target. Compare `src/test-utils/**` above.
        'src/benchmark/**',
      ],
      reporter: ['text', 'text-summary', 'json'],
      reportsDirectory: './coverage',
    },
    environment: 'node',
    // Only `*.spec.ts` files are functional regression tests. `*.bench.ts`
    // files are wall-clock performance benchmarks (e.g. `graph-engine.bench.ts`
    // scans 100K nodes) and must be invoked explicitly — they are not bounded
    // or deterministic enough to run in the default suite.
    include: ['src/**/*.spec.ts'],
    setupFiles: ['./vitest.setup.ts'],
    exclude: [
      '**/node_modules/**',
      // Benchmark/stress suites are not functional regression tests: the
      // stability/scalability/latency/throughput suites run for hours, the
      // LDBC SNB suite needs an external dataset, and even the lighter
      // micro-benchmarks assert wall-clock performance bounds (e.g. `<=1000ms`
      // on 100K-node scans) that are inherently flaky on shared CI runners.
      // Exclude the whole benchmark tree so `vitest run --root .` stays a
      // bounded, deterministic functional run.
      'src/benchmark/**',
      // ZMQ-heavy distributed tests spawn child processes with ZMQ sockets and
      // wedge on CI runners (no broker, connection probes defer infinitely).
      // They run serially in a dedicated job via vitest.slow.config.ts.
      '**/rebalancer.spec.ts',
      '**/shard-dual-write.spec.ts',
      '**/tls.spec.ts',
      '**/cert-monitor.spec.ts',
      '**/event-bus-edge.spec.ts',
      '**/event-bus.live.spec.ts',
      '**/event-bus-worker-pool.spec.ts',
      '**/reshard-manager.spec.ts',
      '**/multi-leader-integration.spec.ts',
      '**/multi-leader-edge.spec.ts',
      '**/multi-leader-extreme.spec.ts',
      '**/multi-leader-benchmark.spec.ts',
      // Filesystem-bound tests write under ./test-data/ and must run serially
      // in a dedicated job via vitest.data.config.ts to avoid directory
      // contention. (Two of them are also tracked as known-broken.)
      '**/e2e/*.spec.ts',
      '**/cluster/*.spec.ts',
      '**/stress/*.spec.ts',
      '**/ops/backup.spec.ts',
      '**/ops/backup-manager.spec.ts',
      '**/ops/backup-scheduler.spec.ts',
      '**/ops/query-slow-log.spec.ts',
      '**/core/query-cache-persister.spec.ts',
      '**/search/search-edge.spec.ts',
      // onnxruntime-node native module: its InitOrtOnce registers a process
      // cleanup hook via napi_add_env_cleanup_hook. Under a worker-thread pool
      // (vmThreads/threads) the native singleton is re-initialized per thread,
      // registering the same hook twice and aborting the process with
      // "Assertion failed: (insertion_info.second) == (true)". These two specs
      // also depend on a `/tmp/minimal_gnn.onnx` fixture that is not committed
      // (no build-onnx.sh exists), so they are tracked as known-broken and must
      // run in an isolated child-process pool once the fixture is restored.
      '**/algorithms/onnx-runtime-wrapper.spec.ts',
      '**/algorithms/gnn-engine.integration.spec.ts',
    ],
    testTimeout: 1200000,
    hookTimeout: 1200000,
    globals: true,
    // Isolation via child processes. The `forks` pool runs each test file in
    // its own child process, which isolates native modules (overgraph, lmdb)
    // whose FinalizationRegistry cleanup hooks abort the process with
    // `illegal access` when run under a worker-thread pool (vmThreads). See
    // vitest.fast.config.ts for the original precedent (onnxruntime-node's
    // InitOrtOnce cleanup hook).
    pool: 'forks',
    singleFork: false,
    server: {
      deps: {
        exclude: ['raft-logic'],
      },
    },
    alias: {
      '@': path.resolve(__dirname, 'src'),
      'test': path.resolve(__dirname, 'test'),
      'graph-crdt': path.resolve(__dirname, 'src/test-utils/__mocks__/graph-crdt.ts'),
      'chokidar': path.resolve(__dirname, 'src/security/__mocks__/chokidar.ts'),
      // zeromq is a native addon whose CJS exports cannot be reliably
      // intercepted by vi.mock under the vmThreads pool. Alias it to the
      // project mock so EventBus and DC-sync resolve to mock sockets in tests.
      'zeromq': path.resolve(__dirname, 'src/test-utils/__mocks__/zeromq.ts'),
    },
  },
})
