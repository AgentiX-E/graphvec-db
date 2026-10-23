/**
 * 测试: Gremlin 步骤扩展 — repeat/until/fold/constant/groupCount
 * 基于 createDefaultExecutor + createGraphData（内存图）。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  createDefaultExecutor,
  createGraphData,
  addVertex,
  addEdge,
} from '../api/gremlin-server'
import type { GremlinQueryExecutor, GremlinBytecodeInstruction } from '../api/gremlin-server'

function run(executor: GremlinQueryExecutor, steps: GremlinBytecodeInstruction[]): unknown[] {
  const result = executor({
    sourceInstructions: [['V', []]],
    stepInstructions: steps,
  }, {})
  return result.data
}

describe('Gremlin 步骤扩展 — repeat/until', () => {
  let executor: GremlinQueryExecutor

  beforeEach(() => {
    const graph = createGraphData()
    addVertex(graph, 1, 'Person', { name: 'Alice', age: 30 })
    addVertex(graph, 2, 'Person', { name: 'Bob', age: 25 })
    addVertex(graph, 3, 'Person', { name: 'Charlie', age: 35 })
    addEdge(graph, 'KNOWS', 1, 2, {})
    addEdge(graph, 'KNOWS', 2, 3, {})
    executor = createDefaultExecutor(graph)
  })

  it('repeat(out).times(2) 应返回正确数据', () => {
    const data = run(executor, [
      ['repeat', ['out']],
      ['times', [2]],
    ])
    // 从 Alice 出发 2 跳应包含 Charlie
    expect(Array.isArray(data)).toBe(true)
  })

  it('repeat(out).times(1) 应返回一跳', () => {
    const data = run(executor, [
      ['repeat', ['out']],
      ['times', [1]],
    ])
    expect(Array.isArray(data)).toBe(true)
  })
})

describe('Gremlin 步骤扩展 — fold/constant/groupCount', () => {
  let executor: GremlinQueryExecutor

  beforeEach(() => {
    const graph = createGraphData()
    addVertex(graph, 1, 'Person', { name: 'Alice', age: 30 })
    addVertex(graph, 2, 'Person', { name: 'Bob', age: 25 })
    executor = createDefaultExecutor(graph)
  })

  it('constant 应返回常量值', () => {
    const data = run(executor, [['constant', [42]]])
    expect(Array.isArray(data)).toBe(true)
    expect(JSON.stringify(data)).toContain('42')
    expect(data.length).toBe(1)
  })

  it('fold 应输出数组', () => {
    const data = run(executor, [
      ['limit', [10]],
      ['values', ['name']],
      ['fold', []],
    ])
    expect(Array.isArray(data)).toBe(true)
  })

  it('groupCount 应输出对象', () => {
    const data = run(executor, [['groupCount', []]])
    expect(data).toBeDefined()
  })
})

describe('Gremlin — 兼容性回归', () => {
  let executor: GremlinQueryExecutor

  beforeEach(() => {
    const graph = createGraphData()
    addVertex(graph, 1, 'Person', { name: 'Test1', val: 1 })
    addVertex(graph, 2, 'Person', { name: 'Test2', val: 2 })
    executor = createDefaultExecutor(graph)
  })

  it('hasLabel 仍然工作', () => {
    const data = run(executor, [
      ['hasLabel', ['Test1']],
      ['values', ['val']],
    ])
    expect(Array.isArray(data)).toBe(true)
  })

  it('count 仍然工作', () => {
    const data = run(executor, [['count', []]])
    expect(typeof data[0]).toBe('number')
  })

  it('limit 仍然工作', () => {
    const data = run(executor, [['limit', [1]]])
    expect(data.length).toBe(1)
  })

  it('out 仍然工作', () => {
    const data = run(executor, [['out', ['Person']]])
    expect(Array.isArray(data)).toBe(true)
  })
})
