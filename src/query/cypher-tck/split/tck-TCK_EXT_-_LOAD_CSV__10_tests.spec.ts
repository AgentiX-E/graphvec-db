/**
 * tck-TCK_EXT_-_LOAD_CSV__10_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - LOAD_CSV (10 tests)', () => {
  test('CSV-01 LOAD CSV basic', async () => {
    const plan = execQuery('LOAD CSV FROM "file:///data.csv" AS row RETURN row')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CSV-02 LOAD CSV WITH HEADERS', async () => {
    const plan = execQuery('LOAD CSV WITH HEADERS FROM "file:///data.csv" AS row RETURN row')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CSV-03 LOAD CSV + CREATE', async () => {
    const plan = execQuery('LOAD CSV FROM "file:///nodes.csv" AS row CREATE (n:Node {id: row[0], name: row[1]})')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CSV-04 LOAD CSV WITH HEADERS + CREATE', async () => {
    const plan = execQuery('LOAD CSV WITH HEADERS FROM "file:///people.csv" AS row CREATE (n:Person {name: row.name, age: toInteger(row.age)})')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CSV-05 LOAD CSV + MATCH + MERGE', async () => {
    const plan = execQuery('LOAD CSV WITH HEADERS FROM "file:///data.csv" AS row MATCH (n:Node {id: row.id}) MERGE (m:Node {name: row.name})')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CSV-06 LOAD CSV + FIELDTERMINATOR', async () => {
    const plan = execQuery('LOAD CSV FROM "file:///data.tsv" AS row FIELDTERMINATOR "\\t" RETURN row')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CSV-07 LOAD CSV + WHERE', async () => {
    const plan = execQuery('LOAD CSV WITH HEADERS FROM "file:///data.csv" AS row WHERE row.active = "true" RETURN row')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CSV-08 LOAD CSV + SET', async () => {
    const plan = execQuery('LOAD CSV WITH HEADERS FROM "file:///updates.csv" AS row MATCH (n:Person {id: row.id}) SET n.status = row.status')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CSV-09 LOAD CSV + FOREACH', async () => {
    const plan = execQuery('LOAD CSV FROM "file:///items.csv" AS row FOREACH (x IN [1] | CREATE (n:Item {value: row[0]}))')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('CSV-10 LOAD CSV + UNWIND', async () => {
    const plan = execQuery('LOAD CSV FROM "file:///list.csv" AS row UNWIND row AS item RETURN item')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

})
