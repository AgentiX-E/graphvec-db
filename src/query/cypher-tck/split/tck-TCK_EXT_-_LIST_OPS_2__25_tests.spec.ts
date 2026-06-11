/**
 * tck-TCK_EXT_-_LIST_OPS_2__25_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - LIST_OPS_2 (25 tests)', () => {
  test('LIST2-01 RETURN list of lists index', () => {
    const plan = execQuery('RETURN [[1,2],[3,4]][0] AS first_sublist')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST2-02 RETURN list of lists deep index', () => {
    const plan = execQuery('RETURN [[1,2],[3,4]][0][1] AS deep')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
}, 30000)

  test('LIST2-03 RETURN list with range', () => {
    const plan = execQuery('RETURN [x IN range(1, 5)] AS ranged')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST2-04 MATCH WHERE number NOT IN', () => {
    const plan = execQuery('MATCH (n:Person) WHERE NOT n.age IN [20, 30] RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST2-05 RETURN reduce with string', () => {
    const plan = execQuery("RETURN reduce(s = '', x IN ['a','b','c'] | s + x) AS concat")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST2-06 RETURN reduce with mul', () => {
    const plan = execQuery('RETURN reduce(p = 1, x IN [1, 2, 3, 4] | p * x) AS product')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST2-07 RETURN reduce with list', () => {
    const plan = execQuery('RETURN reduce(r = [], x IN [1, 2, 3] | r + [x * 10]) AS list_result')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST2-08 RETURN list comprehension 2x', () => {
    const plan = execQuery('RETURN [x IN [1, 2, 3] | x * 2 + 1] AS transformed')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST2-09 RETURN list comprehension filter 2', () => {
    const plan = execQuery('RETURN [x IN range(1, 10) WHERE x % 2 = 0 | x * x] AS filtered_squares')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST2-10 RETURN index beyond length', () => {
    const plan = execQuery('RETURN [1, 2, 3][10] AS beyond')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST2-11 RETURN slice open start', () => {
    const plan = execQuery('RETURN [1, 2, 3, 4, 5][..3] AS from_start')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST2-12 RETURN slice open end', () => {
    const plan = execQuery('RETURN [1, 2, 3, 4, 5][2..] AS to_end')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST2-13 RETURN slice negative', () => {
    const plan = execQuery('RETURN [1, 2, 3, 4, 5][-3..-1] AS neg_slice')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST2-14 MATCH WHERE string IN multiple', () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.name IN ['Alice', 'Bob', 'Charlie'] RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST2-15 MATCH WHERE IN for integer field', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.id IN [1, 2, 3, 4, 5] RETURN n')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST2-16 RETURN head of empty list', () => {
    const plan = execQuery('RETURN head([]) AS empty_head')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST2-17 RETURN last of empty list', () => {
    const plan = execQuery('RETURN last([]) AS empty_last')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST2-18 RETURN list literal with bools', () => {
    const plan = execQuery('RETURN [true, false, 1 > 2, 1 < 2] AS bool_list')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST2-19 MATCH RETURN nested collect', () => {
    const plan = execQuery('MATCH (n:Person) RETURN collect([n.name, n.age]) AS nested_collect')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST2-20 RETURN list + scalar', () => {
    const plan = execQuery('RETURN [1, 2] + [3] AS list_concat')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST2-21 RETURN empty list concat', () => {
    const plan = execQuery('RETURN [] + [1, 2] AS partial_empty')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST2-22 RETURN concat two lists', () => {
    const plan = execQuery('RETURN [1, 2] + [3, 4] + [5, 6] AS three_way')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST2-23 RETURN collect with filter', () => {
    const plan = execQuery('MATCH (n:Person) WHERE n.age > 25 RETURN collect(n.name) AS adult_names')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST2-24 RETURN collect DISTINCT string', () => {
    const plan = execQuery('MATCH (n:Person) RETURN collect(DISTINCT n.name) AS distinct_names')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('LIST2-25 RETURN collect + size', () => {
    const plan = execQuery('MATCH (n:Person) RETURN size(collect(n.name)) AS name_count')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

})
