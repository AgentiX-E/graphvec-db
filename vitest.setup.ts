/**
 * vitest.setup.ts — Global test isolation for the query engine's module-global registries.
 *
 * The query engine (executor-registry.ts) keeps index/constraint/database/GE-pool
 * state in module-level singletons that persist across test files within a single
 * vitest run (the config uses `singleThread: true`, so every spec file shares one
 * process and one set of module globals). Without a reset, a uniqueness constraint
 * registered by e.g. constraint.spec.ts leaks into subsequent MERGE/CREATE specs and
 * raises `ConstraintValidationFailed: Node(...) already exists ...`.
 *
 * This setup runs once before each spec file and clears all four registries, giving
 * every spec file a clean slate. It is intentionally coarse-grained (per-file, not
 * per-test) to avoid disturbing specs that build up state across their own tests.
 */

import { beforeAll } from 'vitest'
import {
  _clearIndexes,
  _clearConstraints,
  _clearDatabases,
  _clearGeInstances,
} from './src/query/query-engine'

beforeAll(() => {
  _clearIndexes()
  _clearConstraints()
  _clearDatabases()
  _clearGeInstances()
})
