/**
 * C-04: Cypher 内置函数扩展 — 测试
 *
 * 验证 PEG 解析 + engine 内置函数（BUILTIN_FUNCTIONS）
 */

import { describe, it, expect } from 'vitest'
import {
  BUILTIN_FUNCTIONS,
  isBuiltinFunction,
  executeBuiltinFunction,
} from './query-engine'

describe('C-04: BUILTIN_FUNCTIONS', () => {
  // TC1: toUpper / toLower
  it('toUpper / toLower', () => {
    expect(executeBuiltinFunction('toUpper', ['hello'])).toBe('HELLO')
    expect(executeBuiltinFunction('toLower', ['WORLD'])).toBe('world')
    expect(executeBuiltinFunction('toUpper', [''])).toBe('')
    expect(executeBuiltinFunction('toLower', [''])).toBe('')
  })

  // TC2: substring
  it('substring', () => {
    expect(executeBuiltinFunction('substring', ['abcdef', 2])).toBe('cdef')
    expect(executeBuiltinFunction('substring', ['abcdef', 2, 3])).toBe('cde')
    expect(executeBuiltinFunction('substring', ['x', 0, 1])).toBe('x')
  })

  // TC3: abs / round
  it('abs / round', () => {
    expect(executeBuiltinFunction('abs', [-5])).toBe(5)
    expect(executeBuiltinFunction('abs', [0])).toBe(0)
    expect(executeBuiltinFunction('abs', [3.14])).toBe(3.14)
    expect(executeBuiltinFunction('round', [3.14159])).toBe(3)
    expect(executeBuiltinFunction('round', [3.14159, 2])).toBe(3.14)
    expect(executeBuiltinFunction('round', [1.5])).toBe(2)
  })

  // TC4: coalesce
  it('coalesce', () => {
    expect(executeBuiltinFunction('coalesce', [null, undefined, 'default'])).toBe('default')
    expect(executeBuiltinFunction('coalesce', ['first', null])).toBe('first')
    expect(executeBuiltinFunction('coalesce', [null, 'second'])).toBe('second')
    expect(executeBuiltinFunction('coalesce', [0, null])).toBe(0) // 0 is not null
    expect(executeBuiltinFunction('coalesce', [null, null, null])).toBe(undefined)
  })

  // TC5: timestamp + isBuiltinFunction check
  it('timestamp + isBuiltinFunction', () => {
    expect(isBuiltinFunction('timestamp')).toBe(true)
    expect(isBuiltinFunction('toUpper')).toBe(true)
    expect(isBuiltinFunction('toLower')).toBe(true)
    expect(isBuiltinFunction('substring')).toBe(true)
    expect(isBuiltinFunction('abs')).toBe(true)
    expect(isBuiltinFunction('round')).toBe(true)
    expect(isBuiltinFunction('coalesce')).toBe(true)
    expect(isBuiltinFunction('unknownFunc')).toBe(false)
    expect(isBuiltinFunction('foobar')).toBe(false)

    const ts = executeBuiltinFunction('timestamp', [])
    expect(typeof ts).toBe('number')
    expect(ts).toBeGreaterThan(1700000000000)
  })

  // TC6: 无参数内置函数（timestamp）
  it('timestamp with no args', () => {
    const ts = executeBuiltinFunction('timestamp', [])
    expect(ts).toBeGreaterThan(0)
  })

  // TC7: BUILTIN_FUNCTIONS map verification
  it('BUILTIN_FUNCTIONS has all 7 functions', () => {
    const keys = Object.keys(BUILTIN_FUNCTIONS)
    expect(keys.sort()).toEqual([
      'abs', 'coalesce', 'round', 'substring', 'timestamp', 'toLower', 'toUpper',
    ])
  })

  // TC8: 未知函数抛出错误
  it('unknown function throws', () => {
    expect(() => executeBuiltinFunction('nonexistent', [])).toThrow('Unknown built-in function')
  })
})
