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
      // ZMQ-heavy files excluded — they run via vitest.slow.config.ts (serially)
      '**/event-bus-edge.spec.ts',
      '**/event-bus.live.spec.ts',
      '**/event-bus-worker-pool.spec.ts',
      '**/multi-leader-benchmark.spec.ts',
      '**/multi-leader-edge.spec.ts',
      '**/multi-leader-extreme.spec.ts',
      '**/multi-leader-integration.spec.ts',
    ],
    testTimeout: 1200000,
    hookTimeout: 1200000,
    globals: true,
    pool: 'forks',
    singleFork: false,
    fileParallelism: true,
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
