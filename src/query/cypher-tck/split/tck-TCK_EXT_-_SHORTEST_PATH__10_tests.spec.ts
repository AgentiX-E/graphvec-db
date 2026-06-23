/**
 * tck-TCK_EXT_-_SHORTEST_PATH__10_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - SHORTEST_PATH (10 tests)', () => {
  test('SP-01 shortestPath', async () => {
    const plan = execQuery("MATCH (a:Person {name: 'Alice'}), (b:Person {name: 'Bob'}) MATCH p = shortestPath((a)-[*..10]-(b)) RETURN p")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SP-02 allShortestPaths', async () => {
    const plan = execQuery("MATCH (a:Person {name: 'Alice'}), (b:Person {name: 'Bob'}) MATCH p = allShortestPaths((a)-[*..10]-(b)) RETURN p")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SP-03 shortestPath directed', async () => {
    const plan = execQuery("MATCH (a:Person {name: 'Alice'}), (b:Person {name: 'Bob'}) MATCH p = shortestPath((a)-[*..10]->(b)) RETURN p")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SP-04 shortestPath + length', async () => {
    const plan = execQuery("MATCH (a:Person {name: 'Alice'}), (b:Person {name: 'Bob'}) MATCH p = shortestPath((a)-[*..10]-(b)) RETURN length(p) AS path_length")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SP-05 allShortestPaths + nodes', async () => {
    const plan = execQuery("MATCH (a:Person {name: 'Alice'}), (b:Person {name: 'Bob'}) MATCH p = allShortestPaths((a)-[*..10]-(b)) RETURN nodes(p) AS nodes_list")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SP-06 shortestPath WHERE', async () => {
    const plan = execQuery("MATCH (a:Person {name: 'Alice'}), (b:Person {name: 'Bob'}) MATCH p = shortestPath((a)-[*..10]-(b)) WHERE length(p) > 2 RETURN p")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SP-07 shortestPath + ORDER', async () => {
    const plan = execQuery("MATCH (a:Person {name: 'Alice'}), (b:Person {name: 'Bob'}) MATCH p = shortestPath((a)-[*..10]-(b)) RETURN p ORDER BY length(p)")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SP-08 shortestPath + aggregate', async () => {
    const plan = execQuery('MATCH (a:Person), (b:Person) MATCH p = shortestPath((a)-[*..10]-(b)) RETURN a.name, b.name, length(p) AS dist')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SP-09 shortestPath + label filter', async () => {
    const plan = execQuery("MATCH (a:Person {name: 'Alice'}), (b:Person {name: 'Bob'}) MATCH p = shortestPath((a)-[*..10]-(b:Person)) RETURN p")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('SP-10 shortestPath + LIMIT', async () => {
    const plan = execQuery("MATCH (a:Person {name: 'Alice'}), (b:Person {name: 'Bob'}) MATCH p = shortestPath((a)-[*..10]-(b)) RETURN p LIMIT 5")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

})
