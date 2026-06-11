/**
 * tck-TCK_EXT_-_ADVANCED_CREATE__25_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - ADVANCED_CREATE (25 tests)', () => {
  test('CREATE-01 CREATE with multiple props', () => {
    const plan = execQuery("CREATE (n:Person {name: 'Alice', age: 30, city: 'NYC', active: true})")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CREATE-02 CREATE node with array', () => {
    const plan = execQuery("CREATE (n:Person {name: 'Bob', tags: ['dev', 'ops']})")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CREATE-03 CREATE edge with props', () => {
    const plan = execQuery("CREATE (a:Person {name: 'Alice'})-[r:KNOWS {since: 2020, level: 3}]->(b:Person {name: 'Bob'})")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CREATE-04 CREATE multiple nodes', () => {
    const plan = execQuery("CREATE (a:Person {name: 'A'}), (b:Person {name: 'B'}), (c:Person {name: 'C'})")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CREATE-05 CREATE + RETURN created', () => {
    const plan = execQuery("CREATE (n:Person {name: 'New'}) RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CREATE-06 CREATE + RETURN props', () => {
    const plan = execQuery("CREATE (n:Person {name: 'New', age: 25}) RETURN n.name, n.age")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CREATE-07 CREATE + MATCH + RETURN', () => {
    const plan = execQuery("CREATE (n:Person {name: 'New'}) MATCH (m:Person) RETURN count(m) AS total")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CREATE-08 CREATE + CREATE edge', () => {
    const plan = execQuery("CREATE (a:Person {name: 'A'}) CREATE (b:Person {name: 'B'}) CREATE (a)-[:KNOWS]->(b)")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CREATE-09 CREATE with nested expression', () => {
    const plan = execQuery("CREATE (n:Person {name: 'Test', score: 42 + 8})")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CREATE-10 CREATE with boolean', () => {
    const plan = execQuery("CREATE (n:Person {name: 'Test', active: true, verified: false})")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CREATE-11 CREATE with null', () => {
    const plan = execQuery("CREATE (n:Person {name: 'Test', middle_name: null})")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CREATE-12 CREATE multiple edges', () => {
    const plan = execQuery("CREATE (a:Person {name: 'A'})-[:KNOWS]->(b:Person {name: 'B'}), (a)-[:FRIEND_OF]->(c:Person {name: 'C'})")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CREATE-13 CREATE + ORDER BY', () => {
    const plan = execQuery("CREATE (n:Person {name: 'Test'}) RETURN n.name ORDER BY n.name")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CREATE-14 CREATE + SKIP + LIMIT', () => {
    const plan = execQuery("CREATE (n:Person {name: 'Test'}) MATCH (m:Person) RETURN m.name SKIP 5 LIMIT 10")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CREATE-15 CREATE with coalesce', () => {
    const plan = execQuery("CREATE (n:Person {name: coalesce('Alice', 'Default')})")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CREATE-16 CREATE with labeled edge', () => {
    const plan = execQuery("CREATE (a:Person {name: 'A'})-[:KNOWS {type: 'friend'}]->(b:Person {name: 'B'})")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CREATE-17 CREATE node + SET', () => {
    const plan = execQuery("CREATE (n:Person {name: 'Temp'}) SET n.status = 'pending'")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CREATE-18 CREATE with timestamp', () => {
    const plan = execQuery("CREATE (n:Event {name: 'Launch', time: timestamp()})")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CREATE-19 CREATE + MATCH edge', () => {
    const plan = execQuery("CREATE (a:Person {name: 'A'}) MATCH (b:Person {name: 'B'}) CREATE (a)-[:KNOWS]->(b)")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CREATE-20 CREATE with path prop', () => {
    const plan = execQuery("CREATE p = (a:Person {name: 'A'})-[:KNOWS]->(b:Person {name: 'B'}) RETURN p")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CREATE-21 CREATE and RETURN alias', () => {
    const plan = execQuery("CREATE (n:Person {name: 'Test'}) RETURN n AS new_node")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CREATE-22 CREATE with toUpper', () => {
    const plan = execQuery("CREATE (n:Person {name: toUpper('test')})")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CREATE-23 CREATE with size', () => {
    const plan = execQuery("CREATE (n:Person {name: 'Test', len: size('hello')})")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CREATE-24 CREATE multiple labels', () => {
    const plan = execQuery("CREATE (n:Person:Employee:Manager {name: 'Boss'})")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CREATE-25 CREATE + SKIP', () => {
    const plan = execQuery("CREATE (n:Person {name: 'Test'}) MATCH (m:Person) RETURN m SKIP 0")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

})
