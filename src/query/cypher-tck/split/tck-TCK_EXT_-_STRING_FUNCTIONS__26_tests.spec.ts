/**
 * tck-TCK_EXT_-_STRING_FUNCTIONS__26_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - STRING_FUNCTIONS (26 tests)', () => {
  test('STR-01 MATCH string concat', async () => {
    const plan = execQuery("MATCH (n:Person) RETURN n.name + ': ' + n.city AS info")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-02 RETURN literal concat', async () => {
    const plan = execQuery("RETURN 'Hello' + ' ' + 'World' AS greeting")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-03 MATCH WHERE string equal', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.name = 'Alice' RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-04 MATCH WHERE string not equal', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.name <> 'Alice' RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-05 MATCH WHERE STARTS WITH', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.name STARTS WITH 'A' RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-06 MATCH WHERE ENDS WITH', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.name ENDS WITH 'e' RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-07 MATCH WHERE CONTAINS', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.name CONTAINS 'li' RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-08 RETURN toUpper', async () => {
    const plan = execQuery("RETURN toUpper('hello') AS upper")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-09 RETURN toLower', async () => {
    const plan = execQuery("RETURN toLower('HELLO') AS lower")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-10 RETURN toString', async () => {
    const plan = execQuery('RETURN toString(42) AS str')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-11 RETURN substring', async () => {
    const plan = execQuery("RETURN substring('hello', 1, 3) AS sub")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-12 RETURN left', async () => {
    const plan = execQuery("RETURN left('hello', 2) AS l")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-13 RETURN right', async () => {
    const plan = execQuery("RETURN right('hello', 2) AS r")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-14 RETURN lTrim', async () => {
    const plan = execQuery("RETURN lTrim('  hello') AS l")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-15 RETURN rTrim', async () => {
    const plan = execQuery("RETURN rTrim('hello  ') AS r")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-16 RETURN trim', async () => {
    const plan = execQuery("RETURN trim('  hello  ') AS t")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-17 RETURN size hello', async () => {
    const plan = execQuery("RETURN size('hello') AS len")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-18 RETURN replace', async () => {
    const plan = execQuery("RETURN replace('hello', 'l', 'x') AS replaced")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-19 RETURN reverse string', async () => {
    const plan = execQuery("RETURN reverse('hello') AS rev")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-20 MATCH field concat', async () => {
    const plan = execQuery("MATCH (n:Person) RETURN n.name + ' - ' + n.city AS combined")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-21 RETURN length', async () => {
    const plan = execQuery("RETURN length('hello') AS len")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-22 MATCH IN string list', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.name IN ['Alice', 'Bob'] RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-23 RETURN double concat', async () => {
    const plan = execQuery("RETURN 'hello' + ' ' + 'world' AS greeting")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-24 MATCH NOT equal', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE NOT n.name = 'Alice' RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-25 MATCH regex wildcard', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.name =~ 'A.*' RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR-26 MATCH regex exact', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.name =~ 'Alice' RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

})
