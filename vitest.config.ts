import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/test-utils/**', 'src/security/__mocks__/**', 'src/**/*.d.ts'],
      reporter: ['text', 'text-summary', 'json'],
      reportsDirectory: './coverage',
    },
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.bench.ts'],
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
    ],
    testTimeout: 1200000,
    hookTimeout: 1200000,
    globals: true,
    pool: 'vmThreads',
    singleThread: true,
    deps: {
      server: {
        inline: [/lmdb/, /@lmdb/],
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
