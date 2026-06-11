/**
 * tck-shared.ts — TCK 测试共享工具
 * 提取自 openCypher-tck.spec.ts，供各分片文件引用。
 */

import { parseQuery, _executeQuery, execQuery } from '../../query-engine'
import { describe, it, test, expect } from 'vitest'

/**
 * 创建全量节点和关系数据集
 */
export function seedGraph() {
  const nodes: Record<string, any>[] = [
    { _label: 'Person', name: 'Alice', age: 30, active: true },
    { _label: 'Person', name: 'Bob', age: 25, active: false },
    { _label: 'Person', name: 'Charlie', age: 35, active: true },
    { _label: 'Person', name: 'David', age: 40, active: false },
    { _label: 'Person', name: 'Eve', age: 28, active: true },
    { _label: 'Person', name: 'Frank', age: 45 },
    { _label: 'Person', name: 'Grace', age: 22, active: true },
    { _label: 'Person', name: 'Hank', age: 55 },
    { _label: 'Company', name: 'TechCorp', industry: 'Tech' },
    { _label: 'Company', name: 'DataInc', industry: 'Data' },
    { _label: 'Company', name: 'WebCo', industry: 'Web' },
    { _label: 'Company', name: 'CloudSys', industry: 'Cloud' },
    { _label: 'City', name: 'London', country: 'UK' },
    { _label: 'City', name: 'Paris', country: 'France' },
    { _label: 'City', name: 'New York', country: 'USA' },
    { _label: 'City', name: 'Tokyo', country: 'Japan' },
  ]
  return [...nodes]
}

/**
 * 创建包含关系的完整数据集
 */
export function seedGraphWithRelations() {
  const nodes = seedGraph()
  // Add relationship data for path/edge tests
  nodes.push(
    { _label: 'KNOWS', _from: 'Alice', _to: 'Bob', since: 2020 },
    { _label: 'KNOWS', _from: 'Alice', _to: 'Charlie', since: 2019 },
    { _label: 'KNOWS', _from: 'Bob', _to: 'David', since: 2021 },
    { _label: 'WORKS_AT', _from: 'Alice', _to: 'TechCorp', role: 'Engineer' },
    { _label: 'WORKS_AT', _from: 'Bob', _to: 'DataInc', role: 'Analyst' },
    { _label: 'LIVES_IN', _from: 'Alice', _to: 'London' },
    { _label: 'LIVES_IN', _from: 'Bob', _to: 'Paris' },
    { _label: 'LIVES_IN', _from: 'Charlie', _to: 'New York' },
  )
  return nodes
}

/**
 * 规范化结果排序（用于断言前的稳定排序）
 */
export function normalize(
  result: Record<string, any>[],
  sortKey: string,
): Record<string, any>[] {
  if (!result || result.length === 0) return result || []
  const sorted = [...result]
  if (sortKey) {
    sorted.sort((a, b) => {
      const va = String(a[sortKey] ?? '')
      const vb = String(b[sortKey] ?? '')
      return va.localeCompare(vb)
    })
  }
  return sorted
}

export { parseQuery, _executeQuery, execQuery }
