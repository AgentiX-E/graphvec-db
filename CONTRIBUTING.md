# Contributing to AgentiX GraphVec

Thank you for your interest in contributing! GraphVec is an open-source graph database for the AI Agent era, and we welcome all forms of contribution — code, documentation, bug reports, feature requests, and community support.

---

## Table of Contents

- [Development Environment Setup](#development-environment-setup)
- [Running Tests](#running-tests)
- [Writing Tests](#writing-tests)
- [Coding Standards](#coding-standards)
- [Pull Request Process](#pull-request-process)
- [Issue & Bug Report Templates](#issue--bug-report-templates)
- [Code of Conduct](#code-of-conduct)

---

## Development Environment Setup

### Prerequisites

- **Node.js** >= 16.0.0 (18.x, 20.x, or 22.x recommended)
- **npm** >= 8.0.0
- **Git**

### Clone & Install

```bash
git clone https://github.com/agentiX/graphvec.git
cd graphvec
npm ci
```

### Build

```bash
npm run build
```

### Verify Your Setup

```bash
npm run test:unit
```

All unit tests should pass. If you see failures, check the [Troubleshooting](#troubleshooting) section.

### IDE Setup

We recommend:

- **VS Code** with the following extensions:
  - ESLint (dbaeumer.vscode-eslint)
  - TypeScript + JavaScript (built-in)
- **WebStorm** — TypeScript support is built-in

### Troubleshooting

| Problem | Solution |
|---------|----------|
| `npm ci` fails | Ensure Node.js >= 16 and npm >= 8 |
| Tests are very slow | Run `npm run test:unit` instead of `test:all` |
| TypeScript errors | Run `npx tsc --noEmit` to check |
| Port conflicts | Tests use in-memory stores by default; no ports needed |

---

## Running Tests

### Quick (Unit Tests Only)

```bash
npm run test:unit
```

Uses `vitest run --config vitest.config.ts` — runs all `*.spec.ts` files in `src/`.

### Full Test Suite

```bash
npm run test:all
```

This runs 30+ test groups sequentially: core, event bus, multi-leader, replication, consensus/raft, sharding, security, algorithms, API, import, indexing, materialized views, ops, query, search, utils, and benchmarks.

> ⚠️ The full suite may take 30–60 minutes. For development, use `test:unit`.

### Run Specific Test Groups

```bash
npm run test:core          # Core graph engine tests
npm run test:raft          # Raft consensus tests
npm run test:multileader   # Multi-leader replication tests
npm run test:shard-core    # Sharding tests
npm run test:algorithms    # Graph algorithm tests
```

### Run a Single Test File

```bash
npx vitest run --config vitest.config.ts --root . src/core/graph-engine.spec.ts
```

### Run Tests with Coverage

```bash
npx vitest run --config vitest.config.ts --root . --coverage
```

Coverage reports are output to the `coverage/` directory.

---

## Writing Tests

### Test Framework

We use **Vitest 4.1.7** with `@vitest/coverage-v8`.

### Where to Put Tests

Test files live alongside their source files with a `.spec.ts` suffix:

```
src/
├── core/
│   ├── graph-engine.ts
│   └── graph-engine.spec.ts      # <── test file
├── algorithms/
│   ├── pagerank.ts
│   └── pagerank.spec.ts          # <── test file
```

### Test Style Guide

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { GraphEngine } from './graph-engine'

describe('GraphEngine', () => {
  let engine: GraphEngine

  beforeEach(() => {
    engine = new GraphEngine(GraphConfig.default())
  })

  describe('upsertNode', () => {
    it('should insert a new node with properties', () => {
      engine.upsertNode(1, { props: { name: 'Alice' } })
      const node = engine.getNode(1)
      expect(node).toBeDefined()
      expect(node!.props.name).toBe('Alice')
    })

    it('should update existing node', () => {
      engine.upsertNode(1, { props: { name: 'Alice' } })
      engine.upsertNode(1, { props: { name: 'Bob' } })
      expect(engine.getNode(1)!.props.name).toBe('Bob')
    })
  })

  describe('getNeighbors', () => {
    it('should return neighbors up to specified depth', () => {
      // Arrange
      engine.upsertNode(1, { props: { name: 'A' } })
      engine.upsertNode(2, { props: { name: 'B' } })
      engine.upsertNode(3, { props: { name: 'C' } })
      engine.upsertEdge(1, 2, { weight: 1 })
      engine.upsertEdge(2, 3, { weight: 1 })

      // Act
      const neighbors = engine.getNeighbors(1, 2)

      // Assert
      expect(neighbors).toHaveLength(2) // node 2 (depth 1) + node 3 (depth 2)
    })
  })
})
```

### Rules for Test Contributions

1. **Every new feature must include tests** — no exceptions
2. **Every bug fix must include a regression test** — reproduce the bug, then fix
3. **Test both happy path and edge cases** — empty graphs, single nodes, deep traversals, concurrent writes
4. **Use descriptive test names** — `it('should ... when ...')`
5. **Keep tests fast** — prefer in-memory over disk I/O; mock network calls
6. **Do not use `test.only` or `test.skip`** — these should never be committed
7. **Use `beforeEach` for setup** — never share mutable state between tests

---

## Coding Standards

### TypeScript

- **Target:** ES2022 (strict mode enabled)
- **Formatting:** Enforced by ESLint (`npm run lint`)
- **Imports:** Prefer named exports over default exports
- **Types:** Always annotate public API surfaces; use type inference internally
- **Naming:**
  - Classes: `PascalCase`
  - Functions/variables: `camelCase`
  - Constants (baked-in magic values): `UPPER_SNAKE_CASE`
  - Files: `kebab-case.ts`
- **No `any` without explicit justification** — `@typescript-eslint/no-explicit-any` is set to `warn`
- **Unused variables** must be prefixed with `_`

### Git Commit Messages

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types:** `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `perf`, `ci`
**Scopes:** `core`, `algorithms`, `consensus`, `raft`, `shard`, `replication`, `security`, `query`, `ops`, `ci`, `docs`

Examples:
```
feat(core): add Cypher-compatible pattern matching
fix(raft): handle leader election timeout during snapshot install
docs(api): add JSDoc for all public GraphEngine methods
test(algorithms): add PageRank convergence edge cases
```

### Code Review Checklist

- [ ] Tests pass (`npm run test:unit`)
- [ ] Lint passes (`npm run lint`)
- [ ] TypeScript compiles (`npx tsc --noEmit`)
- [ ] No `TODO`, `FIXME`, `console.log`, `test.only` committed
- [ ] New public APIs are documented with JSDoc
- [ ] Test coverage is maintained or improved
- [ ] No breaking changes without migration guide
- [ ] Error messages are clear and actionable

---

## Pull Request Process

1. **Fork** the repository and create your branch from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```

2. **Make your changes** — follow the coding standards above.

3. **Run pre-commit checks:**
   ```bash
   npm run lint           # ESLint
   npx tsc --noEmit       # TypeScript type check
   npm run test:unit      # Unit tests
   ```

4. **Commit** — use conventional commit format:
   ```bash
   git commit -m "feat(core): add multi-hop graph traversal"
   ```

5. **Push** your branch:
   ```bash
   git push origin feat/my-feature
   ```

6. **Open a Pull Request** against the `main` branch on GitHub.
   - Use the PR template (see below)
   - Tag relevant reviewers
   - Link related issues

7. **CI will run automatically** (GitHub Actions):
   - `test` job: runs `npm run test:unit` on Node.js 20 and 22
   - `lint` job: TypeScript type check
   - All jobs must pass before merge

8. **Review process:**
   - At least one maintainer must approve
   - All CI checks must pass
   - No merge conflicts with `main`

9. **Merge** — squash-merge preferred for clean history.

### Branch Naming

| Prefix | Purpose |
|--------|---------|
| `feat/*` | New features |
| `fix/*` | Bug fixes |
| `docs/*` | Documentation changes |
| `test/*` | Test additions or improvements |
| `refactor/*` | Code refactoring (no behavior change) |
| `chore/*` | Build/config/maintenance |
| `perf/*` | Performance improvements |

---

## Issue & Bug Report Templates

### Bug Report

```markdown
**Describe the bug**
A clear and concise description of the issue.

**To Reproduce**
Minimal code to reproduce:

```typescript
import { GraphEngine } from 'agentix-graphvec'
const engine = new GraphEngine()
// ... repro steps
```

**Expected behavior**
What you expected to happen.

**Actual behavior**
What actually happened (error message, wrong output, crash).

**Environment:**
- OS: [e.g. Ubuntu 22.04, macOS 14]
- Node version: [e.g. 20.11.0]
- GraphVec version: [e.g. 0.1.0]

**Additional context**
Relevant logs, screenshots, or stack traces.
```

### Feature Request

```markdown
**Is your feature request related to a problem? Please describe.**
A clear and concise description of the problem.

**Describe the solution you'd like**
What should the API/capability look like?

**Describe alternatives you've considered**
Other approaches or existing workarounds.

**Additional context**
References to similar features in other graph databases, academic papers, etc.
```

### How to Submit Issues

- **Bug reports:** GitHub Issues → "Bug Report" template
- **Feature requests:** GitHub Issues → "Feature Request" template
- **Security vulnerabilities:** Email maintainers directly (not public issues)

---

## Code of Conduct

We are committed to fostering a welcoming, inclusive, and respectful community. All participants — contributors, maintainers, and users — are expected to:

- **Be respectful** of differing viewpoints and experiences
- **Accept constructive criticism** gracefully
- **Focus on what is best** for the community and project
- **Show empathy** towards other community members

Unacceptable behavior includes harassment, trolling, personal attacks, or any conduct that makes others feel unsafe or unwelcome.

Violations may result in temporary or permanent bans from project spaces.

---

## Getting Help

- **GitHub Issues:** For bugs and feature requests
- **Discussions:** For questions and community support (coming soon)
- **Internal:** Contact maintainers at [agentiX-team@example.com](mailto:agentiX-team@example.com)

Thank you for contributing to AgentiX GraphVec! 🚀
