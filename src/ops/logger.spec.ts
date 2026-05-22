import pino from 'pino'
import { Logger, withTraceContext, getTraceContext, getTraceId, TraceContext } from './logger'

/* ------------------------------------------------------------------ */
/*  Helper: capture formatted output by pointing pino at a sink       */
/* ------------------------------------------------------------------ */

function captureJson(): { lines: Record<string, unknown>[]; stream: { write: (buf: string) => void } } {
  const lines: Record<string, unknown>[] = []
  const stream = {
    write(buf: string) {
      lines.push(JSON.parse(buf.toString()))
    },
  }
  return { lines, stream }
}

describe('Logger with trace context', () => {
  beforeEach(() => {
    // restore NODE_ENV so pino doesn't spin up pino-pretty
    process.env.NODE_ENV = 'production'
  })

  afterEach(() => {
    delete process.env.NODE_ENV
  })

  // --------------- getTraceContext / getTraceId ---------------

  describe('getTraceContext / getTraceId', () => {
    it('returns undefined when called outside withTraceContext()', () => {
      expect(getTraceContext()).toBeUndefined()
      expect(getTraceId()).toBeUndefined()
    })

    it('returns the active context inside withTraceContext()', () => {
      const ctx: TraceContext = { traceId: 'trace-001', spanId: 'span-001' }
      withTraceContext(ctx, () => {
        expect(getTraceContext()).toEqual(ctx)
        expect(getTraceId()).toBe('trace-001')
      })
    })

    it('supports nested withTraceContext (each call creates a child scope)', () => {
      const parentCtx: TraceContext = { traceId: 'root', spanId: 'parent' }
      const childCtx: TraceContext = { traceId: 'root', spanId: 'child', parentSpanId: 'parent' }

      withTraceContext(parentCtx, () => {
        expect(getTraceId()).toBe('root')
        expect(getTraceContext()!.spanId).toBe('parent')

        withTraceContext(childCtx, () => {
          expect(getTraceId()).toBe('root')
          expect(getTraceContext()!.spanId).toBe('child')
          expect(getTraceContext()!.parentSpanId).toBe('parent')
        })

        // After child exits we're back in parent scope
        expect(getTraceContext()!.spanId).toBe('parent')
      })
    })

    it('preserves context across async/await boundaries', async () => {
      const ctx: TraceContext = { traceId: 'async-trace', spanId: 'async-span' }

      const result = await withTraceContext(ctx, async () => {
        // Simulate an async operation
        await new Promise((r) => setImmediate(r))
        return getTraceId()
      })

      expect(result).toBe('async-trace')
    })
  })

  // --------------- Logger traceId in structured output ---------------

  describe('Logger output with trace context', () => {
    it('includes traceId when Logger is constructed with an explicit traceId', () => {
      const { lines, stream } = captureJson()
      const log = new Logger('test', 'explicit-trace')
      // Replace pino's underlying sink
      ;(log as any).logger = pino({ name: 'test', level: 'info' }, stream)

      log.info('hello')

      expect(lines).toHaveLength(1)
      const record = lines[0] as Record<string, unknown>
      expect(record.msg).toBe('hello')
      expect(record.traceId).toBe('explicit-trace')
    })

    it('includes traceId when running inside withTraceContext()', () => {
      const { lines, stream } = captureJson()
      const log = new Logger('test')
      ;(log as any).logger = pino({ name: 'test', level: 'info' }, stream)

      const ctx: TraceContext = { traceId: 'async-trace', spanId: 'span-1' }
      withTraceContext(ctx, () => {
        log.info('inside context')
      })

      expect(lines).toHaveLength(1)
      expect((lines[0] as Record<string, unknown>).traceId).toBe('async-trace')
    })

    it('prefers the explicit constructor traceId over the async context', () => {
      const { lines, stream } = captureJson()
      const log = new Logger('test', 'explicit-trace')
      ;(log as any).logger = pino({ name: 'test', level: 'info' }, stream)

      const ctx: TraceContext = { traceId: 'async-trace', spanId: 'span-1' }
      withTraceContext(ctx, () => {
        log.info('both present')
      })

      expect(lines).toHaveLength(1)
      // Constructor traceId wins
      expect((lines[0] as Record<string, unknown>).traceId).toBe('explicit-trace')
    })

    it('does not include traceId when neither constructor nor async context is set', () => {
      const { lines, stream } = captureJson()
      const log = new Logger('test')
      ;(log as any).logger = pino({ name: 'test', level: 'info' }, stream)

      log.info('no trace')

      expect(lines).toHaveLength(1)
      const record = lines[0] as Record<string, unknown>
      expect(record.traceId).toBeUndefined()
    })
  })
})
