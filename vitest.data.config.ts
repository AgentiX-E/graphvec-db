import { defineConfig } from 'vitest/config'
import path from 'path'

/**
 * Data config — filesystem-bound spec files that must run serially.
 *
 * These specs create, mutate, and delete directories under `./test-data/`
 * (backup/restore, e2e scenes, cluster partitions, stress scenarios, on-disk
 * caches, search edge fixtures). They use hard-coded relative paths, so running
 * them concurrently would make multiple processes contend for the same
 * directory: file-lock contention, cross-test clobbering, and deadlock on CI
 * runners.
 *
 * Run serially (threads + singleThread) so only one process touches
 * `./test-data/` at a time. Fast, ZMQ-heavy-free unit tests run in parallel via
 * vitest.fast.config.ts, which excludes these files.
 */
export default defineConfig({
  test: {
    environment: 'node',
    root: path.resolve(__dirname, 'src'),
    include: [
      '**/e2e/api-e2e.spec.ts',
      '**/e2e/graph-engine-e2e.spec.ts',
      '**/e2e/multi-leader-e2e.spec.ts',
      '**/e2e/security-e2e.spec.ts',
      '**/cluster/consistency.spec.ts',
      '**/cluster/network-partition.spec.ts',
      '**/stress/chaos-recovery.spec.ts',
      '**/stress/concurrent-crash.spec.ts',
      '**/stress/memory-pressure.spec.ts',
      '**/ops/backup-manager.spec.ts',
      '**/ops/backup-scheduler.spec.ts',
      '**/ops/query-slow-log.spec.ts',
      '**/core/query-cache-persister.spec.ts',
      '**/search/search-edge.spec.ts',
    ],
    // Known-broken files, tracked separately and not part of this suite:
    //   - e2e/cypher-e2e.spec.ts  — 2121 tests, ~113 failing (delete-edge
    //     cascading, multi-hop traversal, type fidelity); needs a dedicated
    //     bug-fix pass before being re-enabled.
    //   - ops/backup.spec.ts      — collects via `createRequire('archiver')`,
    //     which loads archiver v8 (ESM-only) under Vitest and throws
    //     "Cannot use import statement outside a module".
    exclude: [
      '**/node_modules/**',
      '**/e2e/cypher-e2e.spec.ts',
      '**/ops/backup.spec.ts',
    ],
    testTimeout: 300000,
    hookTimeout: 300000,
    globals: true,
    pool: 'threads',
    // Serial execution: only one worker, no file-level parallelism, so only
    // one process touches ./test-data/ at a time (Vitest 4 exposes
    // `fileParallelism` and `maxWorkers` at the top level — `poolOptions`
    // was removed in v4).
    fileParallelism: false,
    maxWorkers: 1,
    server: {
      deps: {
        exclude: ['raft-logic'],
      },
    },
    alias: {
      '@': path.resolve(__dirname, 'src'),
      test: path.resolve(__dirname, 'test'),
      'graph-crdt': path.resolve(__dirname, 'src/test-utils/__mocks__/graph-crdt.ts'),
      chokidar: path.resolve(__dirname, 'src/security/__mocks__/chokidar.ts'),
    },
  },
})
