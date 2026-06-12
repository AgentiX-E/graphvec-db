/**
 * step-definitions.ts — Cucumber step definitions for TCK Cypher testing
 *
 * Architecture:
 *   .feature file → Cucumber → step definitions
 *                                  ↓
 *   parseQuery(query) → _executeQuery(plan, nodes) → assert
 *
 * Each scenario creates a temporary GraphEngine, upserts nodes,
 * executes the query, and asserts the result.
 */

import {
  Given, When, Then, Before, After,
  DataTable,
} from '@cucumber/cucumber'
import assert from 'assert'
import { parseQuery, _executeQuery } from '../query-engine'

// ── Shared state ──
interface TestCtx {
  nodes: Array<Record<string, unknown>>
  query: string
  result: unknown
  error: Error | null
}

const ctx: TestCtx = {
  nodes: [],
  query: '',
  result: null,
  error: null,
}

Before(function () {
  ctx.nodes = []
  ctx.query = ''
  ctx.result = null
  ctx.error = null
})

// ── DataTable → node array ──
function dtToNodes(dt: DataTable): Array<Record<string, unknown>> {
  const nodes: Array<Record<string, unknown>> = []
  const raw = dt.hashes()
  for (const row of raw) {
    const node: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(row)) {
      if (val === '' || val === 'NULL') continue // skip empty fields
      const num = Number(val)
      node[key as string] = Number.isNaN(num) ? val : num
    }
    if (!('_label' in node)) node['_label'] = 'Default'
    nodes.push(node)
  }
  return nodes
}

// ── Given: graph set up ──
Given('an empty graph', function () {
  ctx.nodes = []
})

Given('a graph with the following nodes:', function (dt: DataTable) {
  ctx.nodes = dtToNodes(dt)
})

Given('a graph with:', function (dt: DataTable) {
  ctx.nodes = dtToNodes(dt)
})

// ── When: execute query ──
When('executing query:', function (query: string) {
  ctx.query = query.trim()
  try {
    const plan = parseQuery(ctx.query)
    assert.ok(plan)
    assert.ok(plan.type)
    const result = _executeQuery(plan, ctx.nodes)
    ctx.result = result
    ctx.error = null
  } catch (e: any) {
    ctx.error = e
    ctx.result = null
  }
})

When('executing query: {string}', function (query: string) {
  ctx.query = query
  try {
    const plan = parseQuery(ctx.query)
    assert.ok(plan)
    const result = _executeQuery(plan, ctx.nodes)
    ctx.result = result
    ctx.error = null
  } catch (e: any) {
    ctx.error = e
    ctx.result = null
  }
})

// ── Then: assertions ──
Then('the result should be empty', function () {
  assert.strictEqual(ctx.error, null)
  const rows = ctx.result as Array<unknown>
  assert.strictEqual(rows.length, 0)
})

Then(/^the result should have (\d+) rows?$/, function (count: string) {
  assert.strictEqual(ctx.error, null)
  const rows = ctx.result as Array<unknown>
  assert.strictEqual(rows.length, parseInt(count, 10))
})

Then('the first result should contain fields:', function (dt: DataTable) {
  assert.strictEqual(ctx.error, null)
  const rows = ctx.result as Array<Record<string, unknown>>
  assert.ok(rows.length > 0)
  const first = rows[0]
  for (const { field, expected } of dt.hashes()) {
    // Support dot-path: n.name → first['n']['name']
    if (field.includes('.')) {
      const [objKey, propKey] = field.split('.')
      const nested = first[objKey] as Record<string, unknown> | undefined
      if (expected === '' || expected === '*') {
        assert.ok(nested)
      } else {
        assert.strictEqual(nested?.[propKey], expected)
      }
    } else {
      if (expected === '' || expected === '*') {
        assert.ok(first[field])
      } else {
        assert.strictEqual(first[field], expected)
      }
    }
  }
})

Then('the row should have field {string} equal to {string}', function (fieldPath: string, expected: string) {
  assert.strictEqual(ctx.error, null)
  const rows = ctx.result as Array<Record<string, unknown>>
  assert.ok(rows.length > 0)
  const row = rows[0]
  if (fieldPath.includes('.')) {
    const [objKey, propKey] = fieldPath.split('.')
    const nested = row[objKey] as Record<string, unknown> | undefined
    const numVal = Number(expected)
    const expVal = Number.isNaN(numVal) ? expected : numVal
    assert.strictEqual(nested?.[propKey], expVal)
  } else {
    const numVal = Number(expected)
    const expVal = Number.isNaN(numVal) ? expected : numVal
    assert.strictEqual(row[fieldPath], expVal)
  }
})

Then('the row should have field {string} equal to {int}', function (fieldPath: string, expected: number) {
  const rows = ctx.result as Array<Record<string, unknown>>
  assert.ok(rows.length > 0)
  if (fieldPath.includes('.')) {
    const [objKey, propKey] = fieldPath.split('.')
    const nested = rows[0][objKey] as Record<string, unknown> | undefined
    assert.strictEqual(nested?.[propKey], expected)
  } else {
    assert.strictEqual(rows[0][fieldPath], expected)
  }
})

Then('the query should succeed', function () {
  assert.strictEqual(ctx.error, null)
})
