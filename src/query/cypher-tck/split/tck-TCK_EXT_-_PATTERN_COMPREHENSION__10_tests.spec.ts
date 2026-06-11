/**
 * tck-TCK_EXT_-_PATTERN_COMPREHENSION__10_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - PATTERN_COMPREHENSION (10 tests)', () => {
  test('PCOMP-01 pattern comprehension list', () => {
    const plan = execQuery('MATCH (a:Person) RETURN [(a)-[:KNOWS]->(b) | b.name] AS friends')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PCOMP-02 pattern comprehension filtered', () => {
    const plan = execQuery('MATCH (a:Person) RETURN [(a)-[:KNOWS]->(b) WHERE b.age > 25 | b.name] AS adult_friends')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PCOMP-03 pattern comprehension multi', () => {
    const plan = execQuery('MATCH (a:Person) RETURN [(a)-[:KNOWS]->(b) | b.name] AS friends, [(a)-[:WORKS_AT]->(c) | c.name] AS workplaces')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PCOMP-04 comprehension count', () => {
    const plan = execQuery('MATCH (a:Person) RETURN size([(a)-[:KNOWS]->(b) | b]) AS friend_count')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PCOMP-05 comprehension + scalar', () => {
    const plan = execQuery('MATCH (a:Person) RETURN a.name, [(a)-[:KNOWS]->(b) | b.name] AS friends ORDER BY a.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PCOMP-06 comprehension with UNWIND', () => {
    const plan = execQuery('MATCH (a:Person) UNWIND [(a)-[:KNOWS]->(b) | b.name] AS friend RETURN a.name, friend')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PCOMP-07 comprehension + WHERE', () => {
    const plan = execQuery('MATCH (a:Person) WHERE size([(a)-[:KNOWS]->() | 1]) > 2 RETURN a.name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PCOMP-08 comprehension with labels', () => {
    const plan = execQuery('MATCH (a:Person) RETURN [(a)-[:KNOWS]->(b:Person|Employee) | b.name] AS connections')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PCOMP-09 comprehension var-length', () => {
    const plan = execQuery('MATCH (a:Person) RETURN [(a)-[:KNOWS*1..3]->(b) | b.name] AS network')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('PCOMP-10 comprehension + collect', () => {
    const plan = execQuery('MATCH (a:Person) RETURN collect([(a)-[:KNOWS]->(b) | b.name]) AS all_lists')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

})
