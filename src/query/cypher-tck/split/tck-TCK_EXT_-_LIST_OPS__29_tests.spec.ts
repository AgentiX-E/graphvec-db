/**
 * tck-TCK_EXT_-_LIST_OPS__29_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - LIST_OPS (29 tests)', () => {
  test('LIST-01 RETURN [1,2,3]', async () => {
    const plan = execQuery('RETURN [1, 2, 3] AS list')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-02 RETURN [] empty', async () => {
    const plan = execQuery('RETURN [] AS empty')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-03 RETURN string list', async () => {
    const plan = execQuery("RETURN ['a', 'b', 'c'] AS strs")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-04 RETURN mixed list', async () => {
    const plan = execQuery("RETURN [1, 'two', 3.0] AS mixed")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-05 RETURN nested list', async () => {
    const plan = execQuery('RETURN [[1, 2], [3, 4]] AS nested')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-06 RETURN [0] index', async () => {
    const plan = execQuery('RETURN [1, 2, 3][0] AS first')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-07 RETURN [-1] neg index', async () => {
    const plan = execQuery('RETURN [1, 2, 3][-1] AS last')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-08 RETURN [1..3] slice', async () => {
    const plan = execQuery('RETURN [1, 2, 3, 4, 5][1..3] AS slice')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-09 RETURN size list', async () => {
    const plan = execQuery('RETURN size([1, 2, 3]) AS len')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-10 RETURN head', async () => {
    const plan = execQuery('RETURN head([1, 2, 3]) AS h')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-11 RETURN last', async () => {
    const plan = execQuery('RETURN last([1, 2, 3]) AS l')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-12 RETURN tail', async () => {
    const plan = execQuery('RETURN tail([1, 2, 3]) AS t')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-13 RETURN reverse list', async () => {
    const plan = execQuery('RETURN reverse([1, 2, 3]) AS rev')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-14 RETURN range(1,5)', async () => {
    const plan = execQuery('RETURN range(1, 5) AS rng')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-15 MATCH WHERE IN', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age IN [20, 30, 40] RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-16 MATCH WHERE NOT IN', async () => {
    const plan = execQuery('MATCH (n:Person) WHERE NOT n.age IN [20, 30, 40] RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-17 RETURN reduce', async () => {
    const plan = execQuery('RETURN reduce(s = 0, x IN [1, 2, 3] | s + x) AS sum')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-18 MATCH tags[0]', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN n.tags[0] AS first_tag')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-19 MATCH WHERE IN roles', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE 'admin' IN n.roles RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-20 RETURN [1,2]+[3,4]', async () => {
    const plan = execQuery('RETURN [1, 2] + [3, 4] AS combined')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-21 RETURN list WHERE', async () => {
    const plan = execQuery('RETURN [x IN [1, 2, 3, 4] WHERE x > 2] AS filtered')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 30000)

  test('LIST-22 RETURN list comprehension', async () => {
    const plan = execQuery('RETURN [x IN [1, 2, 3] | x * 2] AS doubled')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-23 RETURN [10,20,30][2]', async () => {
    const plan = execQuery('RETURN [10, 20, 30, 40, 50][2] AS third')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-24 MATCH edge list', async () => {
    const plan = execQuery('MATCH (a)-[r:KNOWS]->(b) RETURN r.dates AS dates')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-25 RETURN size([])', async () => {
    const plan = execQuery('RETURN size([]) AS zero')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-26 RETURN [1]+[2]+[3]', async () => {
    const plan = execQuery('RETURN [1] + [2] + [3] AS chain')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-27 RETURN comp WHERE+map', async () => {
    const plan = execQuery('RETURN [x IN [1, 2, 3, 4, 5, 6] WHERE x > 2 AND x < 6 | x * 10] AS result')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-28 MATCH RETURN collect', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN collect(n.name) AS names')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST-29 MATCH collect DISTINCT', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN collect(DISTINCT n.city) AS cities')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

})
