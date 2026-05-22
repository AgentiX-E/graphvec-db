import { retry } from './retry'

describe('retry', () => {
  test('should succeed on first try', async () => {
    const result = await retry(() => Promise.resolve('ok'), { maxRetries: 3 })
    expect(result).toBe('ok')
  })

  test('should retry on failure and succeed', async () => {
    let attempts = 0
    const result = await retry(() => {
      attempts++
      if (attempts < 3) throw new Error('not yet')
      return Promise.resolve('finally')
    }, { maxRetries: 3, baseDelayMs: 10 })
    expect(result).toBe('finally')
    expect(attempts).toBe(3)
  })

  test('should throw after all retries', async () => {
    await expect(
      retry(() => Promise.reject(new Error('always fails')), {
        maxRetries: 2,
        baseDelayMs: 10,
      })
    ).rejects.toThrow('always fails')
  })

  test('should use defaults when no options provided', async () => {
    const result = await retry(() => Promise.resolve('defaults'))
    expect(result).toBe('defaults')
  })

  test('should respect maxDelayMs cap', async () => {
    let attempts = 0
    const start = Date.now()
    await retry(
      () => {
        attempts++
        return Promise.reject(new Error('fail'))
      },
      { maxRetries: 2, baseDelayMs: 5000, maxDelayMs: 10 }
    ).catch(() => {})
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(1000) // should cap at 10ms, not back off to 5s
  })
})
