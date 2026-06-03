/**
 * builtin-functions.spec.ts — Cypher 内置函数（字符串、时间、聚合）
 *
 * 验证 query-engine.ts 中 BUILTIN_FUNCTIONS 中所有函数的正确性。
 */

import { describe, it, expect } from 'vitest'
import {
  BUILTIN_FUNCTIONS,
  isBuiltinFunction,
  executeBuiltinFunction,
} from './query-engine'

describe('字符串函数', () => {
  // TC1: toUpper / toLower
  it('toUpper / toLower', () => {
    expect(executeBuiltinFunction('toUpper', ['hello'])).toBe('HELLO')
    expect(executeBuiltinFunction('toLower', ['WORLD'])).toBe('world')
    expect(executeBuiltinFunction('toUpper', [''])).toBe('')
    expect(executeBuiltinFunction('toLower', [''])).toBe('')

    // Null input
    expect(executeBuiltinFunction('toUpper', [null])).toBe('')
    expect(executeBuiltinFunction('toLower', [undefined])).toBe('')
  })

  // TC2: substring
  it('substring — 基本和带长度参数', () => {
    expect(executeBuiltinFunction('substring', ['abcdef', 2])).toBe('cdef')
    expect(executeBuiltinFunction('substring', ['abcdef', 2, 3])).toBe('cde')
    expect(executeBuiltinFunction('substring', ['x', 0, 1])).toBe('x')
    expect(executeBuiltinFunction('substring', ['hello', 1, 2])).toBe('el')
    expect(executeBuiltinFunction('substring', ['hello', 5])).toBe('')

    // Null input
    expect(executeBuiltinFunction('substring', [null, 0, 1])).toBe('')
  })

  // TC3: replace
  it('replace', () => {
    expect(executeBuiltinFunction('replace', ['hello world', 'world', 'there'])).toBe('hello there')
    expect(executeBuiltinFunction('replace', ['aaaa', 'aa', 'b'])).toBe('bb')
    expect(executeBuiltinFunction('replace', ['hello', 'x', 'y'])).toBe('hello')
    expect(executeBuiltinFunction('replace', ['', 'a', 'b'])).toBe('')

    // Null input
    expect(executeBuiltinFunction('replace', [null, 'a', 'b'])).toBe('')
  })

  // TC4: trim / lTrim / rTrim
  it('trim / lTrim / rTrim', () => {
    expect(executeBuiltinFunction('trim', ['  hello  '])).toBe('hello')
    expect(executeBuiltinFunction('lTrim', ['  hello  '])).toBe('hello  ')
    expect(executeBuiltinFunction('rTrim', ['  hello  '])).toBe('  hello')
    expect(executeBuiltinFunction('trim', ['hello'])).toBe('hello')
    expect(executeBuiltinFunction('trim', [''])).toBe('')

    // Null input
    expect(executeBuiltinFunction('trim', [null])).toBe('')
    expect(executeBuiltinFunction('lTrim', [undefined])).toBe('')
    expect(executeBuiltinFunction('rTrim', [null])).toBe('')
  })

  // TC5: split / reverse
  it('split / reverse', () => {
    expect(executeBuiltinFunction('split', ['a,b,c', ','])).toEqual(['a', 'b', 'c'])
    expect(executeBuiltinFunction('split', ['hello world', ' '])).toEqual(['hello', 'world'])
    expect(executeBuiltinFunction('split', ['hello', ','])).toEqual(['hello'])
    expect(executeBuiltinFunction('split', ['', ','])).toEqual([''])

    // Null input
    expect(executeBuiltinFunction('split', [null, ','])).toEqual([])

    expect(executeBuiltinFunction('reverse', ['abc'])).toBe('cba')
    expect(executeBuiltinFunction('reverse', ['hello'])).toBe('olleh')
    expect(executeBuiltinFunction('reverse', [''])).toBe('')

    // Null input
    expect(executeBuiltinFunction('reverse', [null])).toBe('')
  })
})

describe('时间函数', () => {
  // TC6: timestamp() 返回数字
  it('timestamp() 返回数字', () => {
    const ts = executeBuiltinFunction('timestamp', [])
    expect(typeof ts).toBe('number')
    expect(ts).toBeGreaterThan(1700000000000) // must be after 2023-11
  })

  // TC7: datetime() 返回 ISO 字符串
  it('datetime() 返回字符串', () => {
    const dt = executeBuiltinFunction('datetime', [])
    expect(typeof dt).toBe('string')
    // ISO 8601 format check — should contain T and Z or timezone
    expect(dt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })
})

describe('类型转换和元数据函数', () => {
  // TC8: toString / toInteger / toFloat
  it('toString / toInteger / toFloat', () => {
    expect(executeBuiltinFunction('toString', [42])).toBe('42')
    expect(executeBuiltinFunction('toString', [3.14])).toBe('3.14')
    expect(executeBuiltinFunction('toString', ['hello'])).toBe('hello')
    expect(executeBuiltinFunction('toString', [null])).toBe('')
    expect(executeBuiltinFunction('toString', [undefined])).toBe('')

    expect(executeBuiltinFunction('toInteger', ['42'])).toBe(42)
    expect(executeBuiltinFunction('toInteger', [3.99])).toBe(3)
    expect(executeBuiltinFunction('toInteger', ['abc'])).toBe(0)
    expect(executeBuiltinFunction('toInteger', [null])).toBe(0)

    expect(executeBuiltinFunction('toFloat', ['3.14'])).toBe(3.14)
    expect(executeBuiltinFunction('toFloat', [42])).toBe(42)
    expect(executeBuiltinFunction('toFloat', ['abc'])).toBe(0)
    expect(executeBuiltinFunction('toFloat', [null])).toBe(0)
  })

  // TC9: type() — 返回关系类型名
  it('type()', () => {
    const rel = { _edgeLabel: 'KNOWS' }
    expect(executeBuiltinFunction('type', [rel])).toBe('KNOWS')

    const rel2 = { _label: 'WORKS_AT' }
    expect(executeBuiltinFunction('type', [rel2])).toBe('WORKS_AT')

    const rel3 = { label: 'RELATED' }
    expect(executeBuiltinFunction('type', [rel3])).toBe('RELATED')

    // Null/undefined
    expect(executeBuiltinFunction('type', [null])).toBe('')
  })

  // TC10: labels() — 返回节点标签数组
  it('labels()', () => {
    const node = { _label: 'Person' }
    expect(executeBuiltinFunction('labels', [node])).toEqual(['Person'])

    const node2 = { label: 'Movie' }
    expect(executeBuiltinFunction('labels', [node2])).toEqual(['Movie'])

    const node3 = {}
    expect(executeBuiltinFunction('labels', [node3])).toEqual([])

    // Null/undefined
    expect(executeBuiltinFunction('labels', [null])).toEqual([])
  })
})

describe('BUILTIN_FUNCTIONS 注册验证', () => {
  // TC11: isBuiltinFunction — 函数存在检查
  it('isBuiltinFunction — 已知和未知函数', () => {
    // 字符串函数
    expect(isBuiltinFunction('toUpper')).toBe(true)
    expect(isBuiltinFunction('toLower')).toBe(true)
    expect(isBuiltinFunction('substring')).toBe(true)
    expect(isBuiltinFunction('replace')).toBe(true)
    expect(isBuiltinFunction('trim')).toBe(true)
    expect(isBuiltinFunction('lTrim')).toBe(true)
    expect(isBuiltinFunction('rTrim')).toBe(true)
    expect(isBuiltinFunction('split')).toBe(true)
    expect(isBuiltinFunction('reverse')).toBe(true)

    // 时间函数
    expect(isBuiltinFunction('timestamp')).toBe(true)
    expect(isBuiltinFunction('datetime')).toBe(true)

    // 类型转换
    expect(isBuiltinFunction('toString')).toBe(true)
    expect(isBuiltinFunction('toInteger')).toBe(true)
    expect(isBuiltinFunction('toFloat')).toBe(true)

    // 元数据
    expect(isBuiltinFunction('type')).toBe(true)
    expect(isBuiltinFunction('labels')).toBe(true)

    // 已有的数字/工具函数
    expect(isBuiltinFunction('abs')).toBe(true)
    expect(isBuiltinFunction('round')).toBe(true)
    expect(isBuiltinFunction('coalesce')).toBe(true)

    // 未知函数
    expect(isBuiltinFunction('unknownFunc')).toBe(false)
    expect(isBuiltinFunction('foobar')).toBe(false)
  })

  // TC12: 未定义的函数 → 报错
  it('未定义的函数抛出错误', () => {
    expect(() => executeBuiltinFunction('nonexistent', [])).toThrow('Unknown built-in function')
    expect(() => executeBuiltinFunction('undefinedFunction', ['test'])).toThrow('Unknown built-in function')
  })

  // TC13: BUILTIN_FUNCTIONS 完整键列表
  it('BUILTIN_FUNCTIONS 包含所有函数', () => {
    const keys = Object.keys(BUILTIN_FUNCTIONS).sort()
    expect(keys).toEqual([
      'abs',
      'coalesce',
      'datetime',
      'endNode',
      'lTrim',
      'labels',
      'length',
      'nodes',
      'relationships',
      'rels',
      'replace',
      'reverse',
      'round',
      'rTrim',
      'split',
      'startNode',
      'substring',
      'timestamp',
      'toFloat',
      'toInteger',
      'toLower',
      'toString',
      'toUpper',
      'trim',
      'type',
    ].sort())
  })
})
