import { parallelLimit, withTimeout, waitFor } from './promise-utils'

describe('promise-utils', () => {
  describe('parallelLimit', () => {
    test('should limit concurrency', async () => {
      let concurrent = 0
      let maxConcurrent = 0
      const items = Array.from({ length: 10 }, (_, i) => i)
      await parallelLimit(
        items,
        async (item: number) => {
          concurrent++
          maxConcurrent = Math.max(maxConcurrent, concurrent)
          await new Promise(r => setTimeout(r, 20))
          concurrent--
        },
        3
      )
      expect(maxConcurrent).toBe(3)
    })

    test('should complete all items', async () => {
      const results: number[] = []
      const items = [1, 2, 3, 4, 5]
      await parallelLimit(
        items,
        async (item: number) => {
          await new Promise(r => setTimeout(r, 10))
          results.push(item)
        },
        2
      )
      expect(results).toHaveLength(5)
      expect(results.sort()).toEqual([1, 2, 3, 4, 5])
    })
  })

  describe('withTimeout', () => {
    test('should throw on timeout', async () => {
      await expect(
        withTimeout(new Promise(r => setTimeout(r, 200)), 50)
      ).rejects.toThrow('Timeout after 50ms')
    })

    test('should resolve before timeout', async () => {
      const result = await withTimeout(Promise.resolve('early'), 1000)
      expect(result).toBe('early')
    })

    test('should use custom timeout message', async () => {
      await expect(
        withTimeout(new Promise(r => setTimeout(r, 200)), 50, 'custom timeout')
      ).rejects.toThrow('custom timeout')
    })
  })

  describe('waitFor', () => {
    test('should wait until condition met', async () => {
      let value = false
      setTimeout(() => { value = true }, 50)
      await waitFor(() => value, 500, 10)
      expect(value).toBe(true)
    })

    test('should throw on timeout', async () => {
      await expect(waitFor(() => false, 50, 10)).rejects.toThrow(
        'waitFor: condition not met within 50ms'
      )
    })
  })
})
