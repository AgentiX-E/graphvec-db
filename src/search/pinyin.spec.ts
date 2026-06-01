/**
 * pinyin.spec.ts — 拼音搜索模块测试
 */
import { toPinyin, toPinyinPrefix, pinyinSearch, getTextPinyinMatches, getPinyinTokens, isChineseChar } from './pinyin'

describe('toPinyin', () => {
  test('should convert simple Chinese text to pinyin', () => {
    const result = toPinyin('中国')
    expect(result).toBe('zhong guo')
  })

  test('should handle mixed Chinese and English text', () => {
    const result = toPinyin('Hello中国')
    expect(result).toBe('Hello zhong guo')
  })

  test('should use custom separator', () => {
    const result = toPinyin('中国', { separator: '-' })
    expect(result).toBe('zhong-guo')
  })

  test('should reject non-chinese chars when keepNonChinese is false', () => {
    const result = toPinyin('ABC中国', { keepNonChinese: false })
    expect(result).toBe('zhong guo')
  })

  test('should handle empty string', () => {
    expect(toPinyin('')).toBe('')
  })
})

describe('toPinyinPrefix', () => {
  test('should return pinyin initials', () => {
    const result = toPinyinPrefix('中国')
    expect(result).toBe('zg')
  })

  test('should handle single character', () => {
    const result = toPinyinPrefix('我')
    expect(result).toBe('w')
  })

  test('should handle mixed content', () => {
    const result = toPinyinPrefix('Hello上海')
    expect(result).toBe('Hellosh')
  })
})

describe('pinyinSearch', () => {
  test('should find candidates by full pinyin', () => {
    const candidates = ['中国', '美国', '日本']
    const result = pinyinSearch('zhong', candidates)
    expect(result).toContain('中国')
    expect(result).not.toContain('美国')
  })

  test('should find candidates by pinyin prefix initials', () => {
    const candidates = ['清华大学', '北京大学', '哈佛大学']
    const result = pinyinSearch('qh', candidates)
    expect(result).toContain('清华大学')
    expect(result).not.toContain('北京大学')
  })

  test('should find candidates by partial pinyin', () => {
    const candidates = ['上海', '深圳', '北京']
    const result = pinyinSearch('shang', candidates)
    expect(result).toContain('上海')
  })

  test('should return empty when query is empty', () => {
    expect(pinyinSearch('', ['中国'])).toEqual([])
  })

  test('should find candidates by direct text match', () => {
    const candidates = ['中国', '中国人']
    const result = pinyinSearch('中国', candidates)
    expect(result).toContain('中国')
    expect(result).toContain('中国人')
  })

  test('should handle no matches', () => {
    const candidates = ['中国', '美国']
    expect(pinyinSearch('xxx', candidates)).toEqual([])
  })
})

describe('getTextPinyinMatches', () => {
  test('should match by direct text inclusion', () => {
    expect(getTextPinyinMatches('中国', '中国')).toBe(true)
  })

  test('should match by pinyin', () => {
    expect(getTextPinyinMatches('中国', 'zhong')).toBe(true)
  })

  test('should match by pinyin prefix', () => {
    expect(getTextPinyinMatches('清华大学', 'qh')).toBe(true)
  })

  test('should return false for non-matching', () => {
    expect(getTextPinyinMatches('美国', 'zhong')).toBe(false)
  })

  test('should return false for empty query', () => {
    expect(getTextPinyinMatches('中国', '')).toBe(false)
  })
})

describe('isChineseChar', () => {
  test('should return true for Chinese characters', () => {
    expect(isChineseChar('中')).toBe(true)
    expect(isChineseChar('国')).toBe(true)
  })

  test('should return false for non-Chinese characters', () => {
    expect(isChineseChar('a')).toBe(false)
    expect(isChineseChar('1')).toBe(false)
    expect(isChineseChar('.')).toBe(false)
  })
})

describe('getPinyinTokens', () => {
  test('should return pinyin and prefix tokens', () => {
    const tokens = getPinyinTokens('中国')
    expect(tokens).toContain('zhong guo')
    expect(tokens).toContain('zg')
  })
})
