/**
 * Coverage detection helper for tests.
 *
 * Wall-clock performance/micro-benchmark assertions (ratio of elapsed times,
 * O(log n) scaling checks, etc.) are meaningless under V8 coverage
 * instrumentation: the per-line counters add asymmetric, non-deterministic
 * overhead that easily flips tight ratios on a loaded CI runner.
 *
 * Such assertions should be skipped when coverage is active while still
 * running in the normal (non-instrumented) unit run. The vitest worker exposes
 * its resolved coverage flag via `__vitest_worker__.config.coverage.enabled`,
 * which is the only reliable in-worker signal (the `--coverage` CLI flag lives
 * in the parent process and `NODE_V8_COVERAGE` is not propagated to forks).
 */

interface VitestWorkerCoverage {
  coverage?: { enabled?: boolean }
}

/**
 * True when the current vitest run has coverage enabled (e.g. `--coverage`),
 * in which case wall-clock performance assertions should be skipped.
 */
export function isCoverageEnabled(): boolean {
  const worker = (globalThis as unknown as { __vitest_worker__?: { config?: VitestWorkerCoverage } })
    .__vitest_worker__
  return worker?.config?.coverage?.enabled === true
}
