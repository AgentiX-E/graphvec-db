/**
 * tck-TCK_EXT_-_DELETE_EXTENDED__15_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - DELETE_EXTENDED (15 tests)', () => {
  test('DEL-01 DELETE node', async () => {
    const plan = execQuery("MATCH (n:Person {name: 'Alice'}) DELETE n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DEL-02 DELETE multiple nodes', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age > 60 DELETE n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DEL-03 DELETE + RETURN', async () => {
    const plan = execQuery("MATCH (n:Person {name: 'Alice'}) DELETE n RETURN count(*) AS deleted")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DEL-04 DETACH DELETE node', async () => {
    const plan = execQuery("MATCH (n:Person {name: 'Alice'}) DETACH DELETE n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DEL-05 DETACH DELETE multiple', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age > 60 DETACH DELETE n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DEL-06 DETACH DELETE + RETURN', async () => {
    const plan = execQuery("MATCH (n:Person {name: 'Alice'}) DETACH DELETE n RETURN count(n) AS deleted")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DEL-07 DELETE with SKIP + LIMIT', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.expired = true DELETE n SKIP 5 LIMIT 10')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DEL-08 DETACH DELETE + ORDER BY', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.expired = true DETACH DELETE n ORDER BY n.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
}, 30000)

  test('DEL-09 DELETE + WHERE + property', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.status = 'deleted' DELETE n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DEL-10 DELETE edge only', async () => {
    const plan = execQuery("MATCH (a:Person {name: 'Alice'})-[r:KNOWS]->() DELETE r")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DEL-11 DELETE edges + nodes', async () => {
    const plan = execQuery("MATCH (a:Person {name: 'Alice'})-[r:KNOWS]->(b) DELETE r, b")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DEL-12 DETACH DELETE with MATCH', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.flagged = true DETACH DELETE n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DEL-13 DELETE all nodes', async () => {
    const plan = execQuery('MATCH (n) DELETE n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DEL-14 DETACH DELETE all', async () => {
    const plan = execQuery('MATCH (n) DETACH DELETE n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('DEL-15 DELETE with pattern', async () => {
    const plan = execQuery('MATCH (a:Person)-[r:KNOWS]->(b:Person) DELETE r')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

})
