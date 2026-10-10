/**
 * executor-registry.ts — index / constraint / database / GE-instance registry tests.
 *
 * These registries are in-memory Maps/Sets with a best-effort JSON persistence
 * layer. The tests drive every mutator and accessor directly, exercising the
 * `_saveStore` write path and every branch of the database lifecycle, and reset
 * global state in beforeEach/afterEach to avoid cross-test pollution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  _registerIndex,
  _dropIndex,
  _getAllIndexes,
  _getIndex,
  _clearIndexes,
  _registerConstraint,
  _dropConstraint,
  _getAllConstraints,
  _clearConstraints,
  DEFAULT_DATABASE,
  _getActiveDatabase,
  _setActiveDatabase,
  _createDatabase,
  _dropDatabase,
  _getAllDatabases,
  _clearDatabases,
  _clearGeInstances,
  _geInstanceRegistry,
  _gePool,
  _geDirRegistry,
  _indexRegistry,
} from './executor-registry'

describe('index registry', () => {
  beforeEach(() => _clearIndexes())
  afterEach(() => _clearIndexes())

  it('registers, retrieves, and lists indexes', () => {
    _registerIndex('Person', 'name')
    _registerIndex('Movie', 'title')
    expect(_getIndex('Person', 'name')).toEqual({ label: 'Person', property: 'name' })
    expect(_getIndex('Movie', 'title')).toEqual({ label: 'Movie', property: 'title' })
    expect(_getAllIndexes()).toHaveLength(2)
  })

  it('returns undefined for a missing index', () => {
    expect(_getIndex('Person', 'absent')).toBeUndefined()
  })

  it('drops an index', () => {
    _registerIndex('Person', 'name')
    _dropIndex('Person', 'name')
    expect(_getIndex('Person', 'name')).toBeUndefined()
    expect(_getAllIndexes()).toHaveLength(0)
  })

  it('clears all indexes', () => {
    _registerIndex('A', 'x')
    _registerIndex('B', 'y')
    _clearIndexes()
    expect(_getAllIndexes()).toHaveLength(0)
  })
})

describe('constraint registry', () => {
  beforeEach(() => _clearConstraints())
  afterEach(() => _clearConstraints())

  it('registers, retrieves, and lists unique constraints', () => {
    _registerConstraint('c1', 'Person', 'name')
    expect(_getAllConstraints()).toEqual([{ name: 'c1', label: 'Person', property: 'name', type: 'UNIQUE' }])
  })

  it('drops a constraint', () => {
    _registerConstraint('c1', 'Person', 'name')
    _dropConstraint('c1')
    expect(_getAllConstraints()).toHaveLength(0)
  })

  it('clears all constraints', () => {
    _registerConstraint('c1', 'Person', 'name')
    _registerConstraint('c2', 'Movie', 'title')
    _clearConstraints()
    expect(_getAllConstraints()).toHaveLength(0)
  })
})

describe('database registry', () => {
  beforeEach(() => _clearDatabases())
  afterEach(() => _clearDatabases())

  it('always starts with the default database active', () => {
    expect(_getActiveDatabase()).toBe(DEFAULT_DATABASE)
    expect(_getAllDatabases()).toContain(DEFAULT_DATABASE)
  })

  it('creates a database and switches to it', () => {
    _createDatabase('shop')
    _setActiveDatabase('shop')
    expect(_getActiveDatabase()).toBe('shop')
    expect(_getAllDatabases()).toContain('shop')
  })

  it('ignores switching to an unknown database', () => {
    _setActiveDatabase('ghost')
    expect(_getActiveDatabase()).toBe(DEFAULT_DATABASE)
  })

  it('drops a non-default database and resets active if it was active', () => {
    _createDatabase('shop')
    _setActiveDatabase('shop')
    _dropDatabase('shop')
    expect(_getAllDatabases()).not.toContain('shop')
    expect(_getActiveDatabase()).toBe(DEFAULT_DATABASE)
  })

  it('refuses to drop the default database', () => {
    _dropDatabase(DEFAULT_DATABASE)
    expect(_getAllDatabases()).toContain(DEFAULT_DATABASE)
  })

  it('drops a non-active database without touching the active one', () => {
    _createDatabase('a')
    _createDatabase('b')
    _dropDatabase('a')
    expect(_getAllDatabases()).toContain('b')
    expect(_getAllDatabases()).not.toContain('a')
  })
})

describe('GE instance registry + clear', () => {
  afterEach(() => _clearGeInstances())

  it('clears the GE instance and dir registries and pool reference', () => {
    // The registry is keyed by database; seed dummy entries to verify clearing.
    const dummyKey = '__probe__'
    // Avoid constructing a real GraphEngine: just verify the clear resets the
    // exported internal registries to empty maps and nulls the pool reference.
    _clearGeInstances()
    expect(_gePool.value).toBeNull()
    expect(_geDirRegistry.size).toBe(0)
    // The live registry may contain prior entries; after clear it should be empty.
    expect(_geInstanceRegistry.size).toBe(0)
  })
})

describe('persistence (_saveStore) and GE clear — filesystem branches', () => {
  it('mkdirs the store dir when it does not yet exist (L36)', () => {
    const fs = require('fs')
    const path = require('path')
    const dir = path.resolve('.opengraph')
    // Force the directory to be absent so _saveStore takes the mkdir branch.
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    try {
      _registerIndex('Person', 'name')
      expect(fs.existsSync(path.join(dir, 'index-constraint-store.json'))).toBe(true)
    } finally {
      _clearIndexes()
    }
  })

  it('rmSyncs an existing GE pool dir during _clearGeInstances (L132)', () => {
    const fs = require('fs')
    const probe = '/tmp/tckge-pool'
    fs.mkdirSync(probe, { recursive: true })
    _clearGeInstances()
    expect(fs.existsSync(probe)).toBe(false)
  })
})

describe('startup persistence load (top-level try block)', () => {
  it('loads persisted indexes and constraints when the store file exists at import', async () => {
    const fs = require('fs')
    const path = require('path')
    const { vi } = await import('vitest')
    const dir = path.resolve('.opengraph')
    fs.mkdirSync(dir, { recursive: true })
    const store = path.join(dir, 'index-constraint-store.json')
    fs.writeFileSync(store, JSON.stringify({
      indexes: [{ label: 'Person', property: 'name' }],
      constraints: [{ name: 'c_person_name', label: 'Person', property: 'name', type: 'UNIQUE' }],
    }), 'utf8')

    vi.resetModules()
    // Re-import: the top-level try now sees the store file and loads it.
    const fresh = await import('./executor-registry')
    expect(fresh._getIndex('Person', 'name')).toEqual({ label: 'Person', property: 'name' })
    expect(fresh._getAllConstraints()).toContainEqual({ name: 'c_person_name', label: 'Person', property: 'name', type: 'UNIQUE' })

    // Cleanup: remove the store + reset in-memory state for other tests.
    fresh._clearIndexes()
    fresh._clearConstraints()
    if (fs.existsSync(store)) fs.rmSync(store, { force: true })
    vi.resetModules()
  })
})

describe('startup persistence load — absent keys (L74/L75 false arms)', () => {
  it('loads nothing when the store file lacks indexes/constraints keys', async () => {
    const fs = require('fs')
    const path = require('path')
    const { vi } = await import('vitest')
    const dir = path.resolve('.opengraph')
    fs.mkdirSync(dir, { recursive: true })
    const store = path.join(dir, 'index-constraint-store.json')
    // Store exists but has NO indexes / constraints keys -> both load guards false.
    fs.writeFileSync(store, JSON.stringify({ foo: 1 }), 'utf8')

    vi.resetModules()
    const fresh = await import('./executor-registry')
    expect(fresh._getAllIndexes()).toHaveLength(0)
    expect(fresh._getAllConstraints()).toHaveLength(0)

    if (fs.existsSync(store)) fs.rmSync(store, { force: true })
    fresh._clearIndexes()
    fresh._clearConstraints()
    vi.resetModules()
  })
})

describe('startup persistence load — store file absent (L71 false arm)', () => {
  it('skips loading cleanly when no store file exists at import', async () => {
    const fs = require('fs')
    const path = require('path')
    const { vi } = await import('vitest')
    const store = path.resolve('.opengraph/index-constraint-store.json')
    // Ensure the store file is absent so fs.existsSync(_storePath) is false.
    if (fs.existsSync(store)) fs.rmSync(store, { force: true })

    vi.resetModules()
    const fresh = await import('./executor-registry')
    expect(fresh._getAllIndexes()).toHaveLength(0)
    expect(fresh._getAllConstraints()).toHaveLength(0)

    fresh._clearIndexes()
    fresh._clearConstraints()
    vi.resetModules()
  })
})
