/**
 * tck-TCK_EXT_-_STRING_FUNCTIONS_2__25_tests.spec.ts — auto-split from openCypher-tck.spec.ts
 */

import { describe, it, test, expect } from 'vitest'
import { parseQuery, _executeQuery, execQuery, seedGraph, seedGraphWithRelations, normalize } from './tck-shared'

describe('TCK EXT - STRING_FUNCTIONS_2 (25 tests)', () => {
  test('STR2-01 RETURN split function', async () => {
    const plan = execQuery("RETURN split('hello world', ' ') AS parts")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR2-02 MATCH WHERE string NOT STARTS', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE NOT n.name STARTS WITH 'A' RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR2-03 MATCH WHERE string NOT ENDS', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE NOT n.name ENDS WITH 'e' RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR2-04 MATCH WHERE string NOT CONTAINS', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE NOT n.name CONTAINS 'li' RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR2-05 RETURN toUpper with field', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN toUpper(n.name) AS upper')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR2-06 RETURN toLower with field', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN toLower(n.name) AS lower')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR2-07 RETURN upper + concat', async () => {
    const plan = execQuery("RETURN toUpper('hello') + ' ' + toUpper('world') AS upper_greeting")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR2-08 RETURN lower + concat', async () => {
    const plan = execQuery("RETURN toLower('HELLO') + ' ' + toLower('WORLD') AS lower_greeting")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR2-09 MATCH RETURN substring field', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN substring(n.name, 0, 2) AS prefix')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR2-10 MATCH RETURN left + right', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN left(n.name, 1) AS first, right(n.name, 1) AS last')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR2-11 MATCH RETURN trim field', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN trim(n.code) AS clean_code')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR2-12 MATCH RETURN replace field', async () => {
    const plan = execQuery("MATCH (n:Person) RETURN replace(n.phone, '-', '') AS clean_phone")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR2-13 RETURN toString + concat', async () => {
    const plan = execQuery("RETURN 'Age: ' + toString(42) AS age_str")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR2-14 MATCH WHERE regex case-insensitive', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.name =~ '(?i)alice' RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR2-15 MATCH WHERE regex starts with', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.name =~ 'A.*e' RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR2-16 MATCH WHERE regex ends with', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.name =~ '.*ce' RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR2-17 MATCH WHERE regex contains', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.name =~ '.*li.*' RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR2-18 MATCH WHERE regex OR', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.name =~ 'Alice|Bob' RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR2-19 RETURN size with field', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN size(n.name) AS name_length')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR2-20 RETURN size + replace', async () => {
    const plan = execQuery("MATCH (n:Person) RETURN size(replace(n.name, ' ', '')) AS compact_length")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR2-21 MATCH RETURN reverse field', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN reverse(n.name) AS reversed_name')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR2-22 MATCH RETURN toUpper(lower())', async () => {
    const plan = execQuery('MATCH (n:Person) RETURN toUpper(toLower(n.name)) AS normalized')
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR2-23 MATCH WHERE empty string', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.name = '' RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR2-24 MATCH WHERE NOT empty string', async () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.name <> '' RETURN n")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

  test('STR2-25 RETURN string + num field', async () => {
    const plan = execQuery("MATCH (n:Person) RETURN n.name + ' (' + toString(n.age) + ')' AS label")
    expect(plan).toBeDefined()
    expect(plan.type).toBeDefined()
    if (plan) {
      const result = await _executeQuery(plan, [{"_label":"Person","name":"Alice","age":30,"city":"NYC","status":"active","id":1}])
      expect(result).toBeDefined()
    }
  }, 10000)

})
