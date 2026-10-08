# AgentiX GraphVec — Test Coverage Master Plan (v1)

**Author:** Lambertyan
**Date:** 2026-10-08
**Goal:** Drive every test-coverage dimension to ≥95%, with a strict bug-discovery-first
methodology, scientific per-iteration testing, and rigorous acceptance gates.

---

## 0. Ground Truth (measured, not assumed)

| Metric | Value | Source |
|---|---|---|
| Total source `.ts` files (non-spec, non-tck) | 222 | `find src` |
| Total source LOC | ~105,044 | `find src -name '*.ts' -not spec` |
| Total spec files | 375 | `find src -name '*.spec.ts'` |
| Query-engine non-TCK `it()` tests | 906 | grep |
| openCypher TCK feature scenarios | 1,624 | grep `Scenario` |
| Cached coverage (stale, Jun 9) | statements 10.8% | `coverage-final/coverage-final.json` |
| Module with real coverage signal | `algorithms` 92.7% | same (only module actually covered) |

**Critical finding:** the cached `coverage-final.json` is **six months stale** and does NOT
reflect current coverage. Almost all modules read 0% simply because the historical coverage run
did not exercise them (or coverage was globally disabled — `vitest.config.ts` sets
`coverage.enabled: false`, and HARD-RULES mandates `--coverage.enabled=false` on every run).

**Consequence:** there is NO trustworthy current coverage number. The first deliverable of this
effort MUST be a fresh, authoritative coverage baseline per module.

---

## 1. Guiding Principles (non-negotiable)

1. **Bug discovery first, coverage second.** A test that passes only trivially (or an assertion
   that was loosened to match buggy output) is worse than no test. We never mask a bug to turn a
   `×` into a `✓`.
2. **Coverage is a consequence, not a target.** We write tests that assert *behaviour*; high
   coverage is the by-product. Where a line is untestable-behind-`if`, we either test both branch
   arms or refactor to make it reachable — we do not add dead `expect`. 
3. **Every dimension, every module ≥95%.** statement / branch / function / line each ≥95%,
   measured per module (`src/<module>/`) and aggregated.
4. **Scientific iteration.** Each iteration = one module (or one bounded area) → baseline →
   gap analysis → test writing → bug fixes → acceptance → commit. No ambiguity about what
   "done" means.
5. **All commits by Lambertyan; all comments/docs/commit messages in English.**

---

## 2. The Acceptance Gate (identical for every iteration)

Every iteration is "accepted" only when ALL of the following hold, verified by an automated
script (`scripts/accept-gate.sh`, to be created in Iteration 0):

1. `vitest run <module> --coverage.enabled=true` → statement/branch/function/line **each ≥95%**
   for that module's non-spec source files.
2. Zero failing tests in the module (`0 failed`).
3. No production-code change made solely to satisfy a test (review: every `fix:` commit must be
   traceable to a *real* defect, documented).
4. Relevant TCK regression green (if module touches query semantics).
5. `git diff --check` clean, `tsc` (build) succeeds, no stray `__probe`/`.spec` debug files.

**Bug-fix policy:** a genuine bug discovered during test writing is fixed in a **separate commit**
from the test that exposed it (`test:` then `fix:`), so reviewers can see the red→green transition.

---

## 3. Module Sequencing (priority-ranked)

Ranked by (a) business-criticality, (b) current visible debt, (c) risk of hidden bugs.

### Phase A — Query engine (the current front line)
| Iter | Module | Files | Rationale |
|---|---|---|---|
| 0 | Test infra | — | Create `accept-gate.sh`, coverage baseline harness, `test:coverage` per-module scripts |
| 1 | `query` | 48 spec / 16 src | Core Cypher engine; 906 tests + 1624 TCK scenarios; 1 KNOWN outstanding bug (Precedence4[4] `true <> false` → should be `null`) |
| 2 | `core` | 52 spec / 32 src | GraphEngine + WAL + transactions + database-manager; highest LOC share |

### Phase B — distributed / consensus
| 3 | `consensus` (Raft) | 29 spec / 17 src | Raft logic + integration; WASM option partially disabled |
| 4 | `shard` | 11 spec / 10 src | scatter-gather, rebalancer, edge-affinity |
| 5 | `replication` | 5 / 5 | multi-leader, outbox |
| 6 | `reshard` | 5 / 4 | auto-splitter |

### Phase C — API / ops / security
| 7 | `api` | 36 spec / 25 src | REST/graph API surface |
| 8 | `ops` | 25 / 23 | metrics, health, backup, slow-log |
| 9 | `security` | 17 / 7 | RBAC, TLS, audit |

### Phase D — algorithms / search / remaining
| 10 | `algorithms` | 40 / 36 | already 92.7% — close the last ~7% |
| 11 | `search` | 5 / 3 | vector/GNN search |
| 12 | `index` / `materialized-view` / `models` / `schema` / `import` / `utils` / `cli` / `perf` / `benchmark` | — | long-tail sweep | 

---

## 4. Iteration 0 — Test Infrastructure (foundation, do first)

Deliverables:
1. `scripts/accept-gate.sh <module> [--threshold 95]` — runs vitest with coverage ON for one
   module, asserts all four dimensions ≥ threshold, exits non-zero otherwise.
2. `scripts/coverage-baseline.ts` — produces `coverage-baseline-YYYYMMDD.json` (fresh, authoritative)
   for every module, replacing the stale `coverage-final.json` as the source of truth.
3. Per-module `test:<module>` scripts already exist (see `package.json`); add `test:coverage:*`
   counterparts that run with coverage ON (unlike the `--coverage.enabled=false` HARD-RULES).
4. Update `scripts/HARD-RULES.md`: coverage runs are **allowed** (they are fast per-module), only
   the *full* stability/benchmark suites remain forbidden on the main session.

**Acceptance:** `npm run test:coverage:query` prints four ≥95% numbers or fails with the gap.

---

## 5. Known Outstanding Bug (start here in Iteration 1)

`src/query/cypher-tck/features/expressions/precedence/Precedence4.feature` Scenario Outline [4]:
```
(true OR null STARTS WITH 'abc') <> ((true OR null) STARTS WITH 'abc') AS d   // expect null
```
Current engine returns `true`; TCK expects `null` (Neo4j: `boolean <> boolean` with null-tainted
operands resolves to `null` under three-valued logic). Root cause suspected in `_evalComparison`
`<>` handling of boolean/null. **Fix in a dedicated commit, verify with a targeted TCK run.**

---

## 6. Scientific Test Methodology per Iteration

1. **Baseline:** run coverage with `coverage.text` reporter; dump the per-file uncovered lines.
2. **Triage uncovered lines into 3 buckets:**
   - **T1 — behaviour not yet tested:** write a new test; assert real behaviour.
   - **T2 — defensive/dead branch:** decide: (a) the branch is reachable and meaningful → test it;
     (b) the branch is genuinely unreachable dead code → refactor/remove it (a "fix").
   - **T3 — config/glue (unavoidable):** document why it's countably exempt (e.g. generated code,
     process-exit paths); keep exemptions logged and <5% of total.
3. **Red→Green:** write the failing test first if a bug is suspected; confirm it fails; fix; confirm green.
4. **Boundary discipline:** every list/map/string/range boundary, every null-handling branch,
   every error path gets an explicit test. No "happy path only" coverage inflation.

---

## 7. Acceptance / Commit Protocol (per iteration)

1. `git add` tests → commit `test(<module>): ...` (by Lambertyan).
2. If a real bug was exposed → separate commit `fix(<module>): ...` with a clear defect description.
3. Run `accept-gate.sh <module>`; attach the four coverage numbers to the commit message / summary.
4. Append progress to `memory/2026-10-08.md` (and today's rolling file).
5. Never force-push, never squash unrelated modules, never mask a failing test.

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Full `vitest run src/` hangs (Redis/ZMQ/benchmark deps) | Keep HARD-RULES; only run per-module; coverage run is per-module |
| Coverage run slow for big modules (core/query) | Run in sub-agent with `runTimeoutSeconds`; never block main session >60s |
| Loose assertions inflate coverage while hiding bugs | Mandatory T1/T2/T3 triage; red→green discipline; independent `fix:` commits |
| Stale TCK expectations vs current semantics | For every TCK failure, determine "production bug" vs "stale expectation" and document; only ever fix production bugs (as done for tck-PATH collision-aware columns) |
| `stability.spec.ts` / `ldbc-snb` 6–10h suites | Explicitly out of scope for coverage; documented in HARD-RULES |

---

## 9. Definition of Done (whole effort)

- `coverage-baseline-YYYYMMDD.json` exists and is authoritative.
- Every module in Phases A–D reports statement/branch/function/line ≥95%.
- Zero known open TCK failures in the query engine.
- All commits by Lambertyan, all artifacts in English.
- `memory/` reflects the full audit trail.
