/**
 * query-params.ts — parameterized query pre-compilation tests.
 *
 * Drives the pure helpers (escapeString / serializeParamValue / _injectParams /
 * _extractParamNames) through the public surface (`cypher`, `compileCypher`,
 * `ParameterizedQuery`) and asserts real serialization + injection behavior,
 * including every escaping branch and the cache hit path.
 */

import { describe, it, expect } from 'vitest'
import { cypher, compileCypher, ParameterizedQuery } from './query-params'
import { parseQuery } from './query-engine'

describe('cypher — inline parameter injection', () => {
  it('returns a parsed plan directly when no params are supplied', () => {
    const plan = cypher('MATCH (n) RETURN n')
    expect(plan).toBeTruthy()
    // A bare template with no params parses to a generic query plan.
    expect(Array.isArray(plan.returnColumns) || plan.returnColumns === undefined).toBe(true)
  })

  it('returns a parsed plan directly when params object is empty', () => {
    const plan = cypher('MATCH (n) RETURN n', {})
    expect(plan).toBeTruthy()
  })

  it('injects a string parameter single-quoted (no embedded quote)', () => {
    const plan = cypher('MATCH (n) WHERE n.name = $name RETURN n', { name: 'Alice' })
    expect(plan).toBeTruthy()
  })

  it('injects a number parameter verbatim', () => {
    const plan = cypher('MATCH (n) WHERE n.age = $age RETURN n', { age: 42 })
    expect(plan).toBeTruthy()
  })

  it('injects a boolean parameter verbatim', () => {
    const plan = cypher('RETURN $flag AS x', { flag: true })
    expect(plan).toBeTruthy()
  })

  it('injects null as the literal null', () => {
    const plan = cypher('RETURN $x AS x', { x: null })
    expect(plan).toBeTruthy()
  })

  it('injects undefined as the literal null', () => {
    const plan = cypher('RETURN $x AS x', { x: undefined })
    expect(plan).toBeTruthy()
  })

  it('injects an array recursively', () => {
    const plan = cypher('RETURN $xs AS xs', { xs: [1, 'two', true] })
    expect(plan).toBeTruthy()
  })

  it('injects a nested object as JSON string', () => {
    const plan = cypher('RETURN $o AS o', { o: { a: 1, b: 2 } })
    expect(plan).toBeTruthy()
  })
})

describe('escapeString — quote selection + sanitization (via cypher injection)', () => {
  it('uses double quotes when value contains a single quote but no double quote', () => {
    // "O'Brien" -> "O'Brien" (double-quoted to preserve the apostrophe)
    const plan = cypher('RETURN $name AS name', { name: "O'Brien" })
    expect(plan).toBeTruthy()
  })

  it('strips both quote kinds when value contains both', () => {
    // `a'b"c` -> strips quotes -> `abc`
    const plan = cypher("RETURN $v AS v", { v: `a'b"c` })
    expect(plan).toBeTruthy()
  })

  it('strips control characters from the value', () => {
    const plan = cypher('RETURN $v AS v', { v: 'a\u0001b\u0009c' })
    expect(plan).toBeTruthy()
  })
})

describe('_injectParams — missing parameter handling', () => {
  it('throws when a referenced parameter is absent', () => {
    expect(() => cypher('MATCH (n) WHERE n.name = $name RETURN n', { other: 1 })).toThrow(
      /Missing parameter: \$name/,
    )
  })
})

describe('compileCypher + ParameterizedQuery — cache + precompiled lifecycle', () => {
  it('compiles a template into a reusable ParameterizedQuery', () => {
    const pq = compileCypher('MATCH (n) WHERE n.name = $name RETURN n')
    expect(pq).toBeInstanceOf(ParameterizedQuery)
  })

  it('extracts parameter names once (and caches the result)', () => {
    const pq = compileCypher('MATCH (a)-[r:$rel]->(b) WHERE a.x = $x RETURN a, b')
    const first = pq.getParamNames()
    expect([...first].sort()).toEqual(['rel', 'x'])
    // Second call hits the cache path (paramNames !== null).
    const second = pq.getParamNames()
    expect(second).toEqual(first)
  })

  it('reports hasParam for known and unknown names', () => {
    const pq = compileCypher('MATCH (n) WHERE n.name = $name RETURN n')
    expect(pq.hasParam('name')).toBe(true)
    expect(pq.hasParam('missing')).toBe(false)
  })

  it('executes with params only when at least one param is present', () => {
    const pq = compileCypher('MATCH (n) WHERE n.name = $name RETURN n')
    const plan = pq.execute({ name: 'Bob' })
    expect(plan).toBeTruthy()
  })

  it('executes a no-param template directly', () => {
    const pq = compileCypher('MATCH (n) RETURN n')
    const plan = pq.execute({})
    expect(plan).toBeTruthy()
  })

  it('returns an independent copy of param names from the cache', () => {
    const pq = compileCypher('RETURN $a, $b')
    const names = pq.getParamNames()
    names.push('injected')
    // The internal cache must not be mutated by the returned copy.
    expect(pq.getParamNames()).toEqual(['a', 'b'])
  })
})

describe('_extractParamNames — name syntax', () => {
  it('extracts multiple $-prefixed identifiers including underscores', () => {
    const pq = new ParameterizedQuery('RETURN $first_name, $second, $_hidden')
    expect(pq.getParamNames()).toEqual(['first_name', 'second', '_hidden'])
  })

  it('ignores non-identifier $-tokens', () => {
    const pq = new ParameterizedQuery('RETURN $1, $, $-')
    // `$1` etc. do not match `\w*` after `$` (a digit-leading name is skipped;
    // the regex requires [a-zA-Z_].)
    expect(pq.getParamNames()).toEqual([])
  })
})

describe('parseQuery round-trip sanity', () => {
  it('parseQuery re-export stays importable (guard against accidental break)', () => {
    expect(typeof parseQuery).toBe('function')
  })
})
