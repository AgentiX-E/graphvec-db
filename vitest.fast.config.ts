import { defineConfig } from 'vitest/config'
import path from 'path'

/**
 * Fast vitest config — runs non-ZMQ tests in parallel.
 *
 * Excludes ZMQ-heavy spec files that must run serially
 * (they spawn child processes with ZMQ sockets).
 * Run those separately with vitest.slow.config.ts.
 */
export default defineConfig({
  test: {
    environment: 'node',
    root: path.resolve(__dirname, 'src'),
    include: ['**/*.spec.ts'],
    exclude: [
      '**/node_modules/**',
      // Benchmark/stress suites are not functional regression tests: they run
      // for hours, need external datasets, or assert wall-clock performance
      // bounds that flake on shared CI runners.
      '**/benchmark/**',
      // ZMQ-heavy files excluded — they run via vitest.slow.config.ts (serially)
      '**/event-bus-edge.spec.ts',
      '**/event-bus.live.spec.ts',
      '**/event-bus-worker-pool.spec.ts',
      '**/multi-leader-benchmark.spec.ts',
      '**/multi-leader-edge.spec.ts',
      '**/multi-leader-extreme.spec.ts',
      '**/multi-leader-integration.spec.ts',
      // Filesystem-bound files excluded — they write under ./test-data/ and
      // must run serially via vitest.data.config.ts (no directory contention).
      '**/e2e/*.spec.ts',
      '**/cluster/*.spec.ts',
      '**/stress/*.spec.ts',
      '**/ops/backup.spec.ts',
      '**/ops/backup-scheduler.spec.ts',
      '**/ops/query-slow-log.spec.ts',
      '**/query-cache-persister.spec.ts',
      '**/search/search-edge.spec.ts',
      // onnxruntime-node specs depend on a `/tmp/minimal_gnn.onnx` fixture that
      // is not committed (there is no build-onnx.sh). They are tracked as
      // known-broken; re-enable once the fixture restoration pass lands.
      '**/algorithms/onnx-runtime-wrapper.spec.ts',
      '**/algorithms/gnn-engine.integration.spec.ts',
    ],
    testTimeout: 1200000,
    hookTimeout: 1200000,
    globals: true,
    // Isolation via child processes. The `forks` pool runs each test file in
    // its own child process, which isolates native modules whose process-level
    // singletons (e.g. onnxruntime-node's InitOrtOnce cleanup hook) would
    // otherwise be re-initialized across worker threads and abort the process.
    // Serial execution (`fileParallelism: false`) avoids cross-file
    // contention: unconsumed ZMQ socket probes and filesystem-bound fixtures
    // that deadlock under parallelism. The ZMQ and ./test-data/ specs are
    // already excluded, so the remaining files are pure unit tests that run
    // serially without contention.
    pool: 'forks',
    singleFork: false,
    fileParallelism: false,
    maxWorkers: 1,
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
    },
  },
})
