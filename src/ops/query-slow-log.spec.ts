import { QuerySlowLog } from './query-slow-log'

describe('QuerySlowLog', () => {
  test('should create with default threshold', () => {
    const qsl = new QuerySlowLog()
    expect(qsl.count).toBe(0)
  })

  test('should create with custom threshold', () => {
    const qsl = new QuerySlowLog(200)
    expect(qsl.count).toBe(0)
  })

  test('should create with custom max entries', () => {
    const qsl = new QuerySlowLog(100, 50)
    expect(qsl.count).toBe(0)
  })

  test('should record a slow query via track', async () => {
    const qsl = new QuerySlowLog(100)
    const result = await qsl.track('testOp', async () => {
      await new Promise(r => setTimeout(r, 200))
      return 'done'
    })
    expect(result).toBe('done')
    expect(qsl.count).toBe(1)
  })

  test('should not record fast queries', async () => {
    const qsl = new QuerySlowLog(1000) // high threshold
    await qsl.track('fastOp', async () => 'result')
    expect(qsl.count).toBe(0)
  })

  test('should record slow queries with user info', async () => {
    const qsl = new QuerySlowLog(50)
    await qsl.track('testOp', async () => {
      await new Promise(r => setTimeout(r, 100))
      return 'done'
    }, 'user-1')
    expect(qsl.count).toBe(1)
  })

  test('should return slow queries via getSlowQueries', async () => {
    const qsl = new QuerySlowLog(50)
    await qsl.track('op1', async () => {
      await new Promise(r => setTimeout(r, 100))
      return 'ok'
    })
    const queries = qsl.getSlowQueries()
    expect(queries.length).toBe(1)
    expect(queries[0].op).toBe('op1')
    expect(queries[0].duration).toBeGreaterThanOrEqual(50)
    expect(queries[0].timestamp).toBeGreaterThan(0)
  })

  test('should clear all logs', async () => {
    const qsl = new QuerySlowLog(50)
    await qsl.track('op1', async () => {
      await new Promise(r => setTimeout(r, 100))
      return 'ok'
    })
    expect(qsl.count).toBe(1)
    qsl.clear()
    expect(qsl.count).toBe(0)
  })

  test('should update threshold', async () => {
    const qsl = new QuerySlowLog(1000)
    qsl.setThreshold(50)
    await qsl.track('op1', async () => {
      await new Promise(r => setTimeout(r, 100))
      return 'ok'
    })
    expect(qsl.count).toBe(1)
  })

  test('should track returned result from wrapped function', async () => {
    const qsl = new QuerySlowLog(50)
    const data = await qsl.track('fetchData', async () => ({ id: 1, name: 'test' }))
    expect(data).toEqual({ id: 1, name: 'test' })
  })

  test('should propagate exceptions from wrapped function', async () => {
    const qsl = new QuerySlowLog(50)
    await expect(
      qsl.track('errorOp', async () => {
        throw new Error('test error')
      })
    ).rejects.toThrow('test error')
  })

  test('should limit max entries', async () => {
    const qsl = new QuerySlowLog(1, 5) // max 5 entries
    const promises = []
    for (let i = 0; i < 10; i++) {
      promises.push(
        qsl.track(`op${i}`, async () => {
          await new Promise(r => setTimeout(r, 10))
          return i
        })
      )
    }
    await Promise.all(promises)
    expect(qsl.count).toBeLessThanOrEqual(5)
  })
})

describe('QuerySlowLog - persistent file', () => {
  const TEST_LOG = './test-data/slow-queries-test.log'
  let fs: any

  beforeAll(() => {
    fs = require('fs')
    try { fs.mkdirSync('./test-data', { recursive: true }) } catch { /* ignore */ }
    try { fs.unlinkSync(TEST_LOG) } catch { /* ignore */ }
  })

  afterAll(() => {
    try { fs.unlinkSync(TEST_LOG) } catch { /* ignore */ }
  })

  test('should write slow query log to file', async () => {
    const qsl = new QuerySlowLog(10, 100, TEST_LOG)
    // Enable file output
    process.env.SLOW_LOG_FILE = '1'

    await qsl.track('file-op', async () => {
      await new Promise(r => setTimeout(r, 50))
      return 'ok'
    })

    // Wait for write
    await new Promise(r => setTimeout(r, 200))

    const content = fs.readFileSync(TEST_LOG, 'utf-8')
    expect(content).toContain('file-op')
    expect(content).toContain('duration')

    qsl.close()
    delete process.env.SLOW_LOG_FILE
  })

  test('should recover logs from file on restart', async () => {
    // First instance: write a log entry
    const qsl1 = new QuerySlowLog(10, 100, TEST_LOG)
    process.env.SLOW_LOG_FILE = '1'
    await qsl1.track('recover-op', async () => {
      await new Promise(r => setTimeout(r, 50))
      return 'ok'
    })
    await new Promise(r => setTimeout(r, 200))
    qsl1.close()
    delete process.env.SLOW_LOG_FILE

    // Second instance: should recover from file
    const qsl2 = new QuerySlowLog(10, 1000, TEST_LOG)
    const queries = qsl2.getSlowQueries()
    expect(queries.length).toBeGreaterThanOrEqual(1)
    const recovered = queries.find(q => q.op === 'recover-op')
    expect(recovered).toBeDefined()
    expect(recovered!.duration).toBeGreaterThanOrEqual(10)
    qsl2.close()
  })

  test('should not lose logs after clear + new instance', async () => {
    const qsl = new QuerySlowLog(10, 100, TEST_LOG)
    process.env.SLOW_LOG_FILE = '1'
    await qsl.track('persist-op', async () => {
      await new Promise(r => setTimeout(r, 50))
      return 'ok'
    })
    await new Promise(r => setTimeout(r, 200))

    // Clear in-memory logs
    qsl.clear()
    expect(qsl.count).toBe(0)
    qsl.close()
    delete process.env.SLOW_LOG_FILE

    // New instance should still have the file-persisted entry
    const qsl2 = new QuerySlowLog(10, 1000, TEST_LOG)
    const queries = qsl2.getSlowQueries()
    const found = queries.find(q => q.op === 'persist-op')
    expect(found).toBeDefined()
    qsl2.close()
  })
})
