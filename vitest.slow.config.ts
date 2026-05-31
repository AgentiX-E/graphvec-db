import { defineConfig } from 'vitest/config'
import path from 'path'

/**
 * Slow config — only ZMQ-heavy & slow spec files that must run serially.
 *
 * These files spawn child processes with ZMQ sockets and cannot run
 * in parallel with each other without port conflicts.
 *
 * Fast tests are handled by the main vitest.config.ts (which excludes
 * these files and runs with fileParallelism: true).
 */
export default defineConfig({
  test: {
    environment: 'node',
    root: path.resolve(__dirname, 'src'),
    include: [
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
    ],
    exclude: ['**/node_modules/**'],
    testTimeout: 300000,
    hookTimeout: 300000,
    globals: true,
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true,
        minThreads: 1,
        maxThreads: 1,
      },
    },
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
