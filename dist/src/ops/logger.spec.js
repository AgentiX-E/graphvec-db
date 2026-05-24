"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const pino_1 = __importDefault(require("pino"));
const logger_1 = require("./logger");
/* ------------------------------------------------------------------ */
/*  Helper: capture formatted output by pointing pino at a sink       */
/* ------------------------------------------------------------------ */
function captureJson() {
    const lines = [];
    const stream = {
        write(buf) {
            lines.push(JSON.parse(buf.toString()));
        },
    };
    return { lines, stream };
}
describe('Logger with trace context', () => {
    beforeEach(() => {
        // restore NODE_ENV so pino doesn't spin up pino-pretty
        process.env.NODE_ENV = 'production';
    });
    afterEach(() => {
        delete process.env.NODE_ENV;
    });
    // --------------- getTraceContext / getTraceId ---------------
    describe('getTraceContext / getTraceId', () => {
        it('returns undefined when called outside withTraceContext()', () => {
            expect((0, logger_1.getTraceContext)()).toBeUndefined();
            expect((0, logger_1.getTraceId)()).toBeUndefined();
        });
        it('returns the active context inside withTraceContext()', () => {
            const ctx = { traceId: 'trace-001', spanId: 'span-001' };
            (0, logger_1.withTraceContext)(ctx, () => {
                expect((0, logger_1.getTraceContext)()).toEqual(ctx);
                expect((0, logger_1.getTraceId)()).toBe('trace-001');
            });
        });
        it('supports nested withTraceContext (each call creates a child scope)', () => {
            const parentCtx = { traceId: 'root', spanId: 'parent' };
            const childCtx = { traceId: 'root', spanId: 'child', parentSpanId: 'parent' };
            (0, logger_1.withTraceContext)(parentCtx, () => {
                expect((0, logger_1.getTraceId)()).toBe('root');
                expect((0, logger_1.getTraceContext)().spanId).toBe('parent');
                (0, logger_1.withTraceContext)(childCtx, () => {
                    expect((0, logger_1.getTraceId)()).toBe('root');
                    expect((0, logger_1.getTraceContext)().spanId).toBe('child');
                    expect((0, logger_1.getTraceContext)().parentSpanId).toBe('parent');
                });
                // After child exits we're back in parent scope
                expect((0, logger_1.getTraceContext)().spanId).toBe('parent');
            });
        });
        it('preserves context across async/await boundaries', async () => {
            const ctx = { traceId: 'async-trace', spanId: 'async-span' };
            const result = await (0, logger_1.withTraceContext)(ctx, async () => {
                // Simulate an async operation
                await new Promise((r) => setImmediate(r));
                return (0, logger_1.getTraceId)();
            });
            expect(result).toBe('async-trace');
        });
    });
    // --------------- Logger traceId in structured output ---------------
    describe('Logger output with trace context', () => {
        it('includes traceId when Logger is constructed with an explicit traceId', () => {
            const { lines, stream } = captureJson();
            const log = new logger_1.Logger('test', 'explicit-trace');
            log.logger = (0, pino_1.default)({ name: 'test', level: 'info' }, stream);
            log.info('hello');
            expect(lines).toHaveLength(1);
            const record = lines[0];
            expect(record.msg).toBe('hello');
            expect(record.traceId).toBe('explicit-trace');
        });
        it('includes traceId when running inside withTraceContext()', () => {
            const { lines, stream } = captureJson();
            const log = new logger_1.Logger('test');
            log.logger = (0, pino_1.default)({ name: 'test', level: 'info' }, stream);
            const ctx = { traceId: 'async-trace', spanId: 'span-1' };
            (0, logger_1.withTraceContext)(ctx, () => {
                log.info('inside context');
            });
            expect(lines).toHaveLength(1);
            expect(lines[0].traceId).toBe('async-trace');
        });
        it('prefers the explicit constructor traceId over the async context', () => {
            const { lines, stream } = captureJson();
            const log = new logger_1.Logger('test', 'explicit-trace');
            log.logger = (0, pino_1.default)({ name: 'test', level: 'info' }, stream);
            const ctx = { traceId: 'async-trace', spanId: 'span-1' };
            (0, logger_1.withTraceContext)(ctx, () => {
                log.info('both present');
            });
            expect(lines).toHaveLength(1);
            // Constructor traceId wins
            expect(lines[0].traceId).toBe('explicit-trace');
        });
        it('does not include traceId when neither constructor nor async context is set', () => {
            const { lines, stream } = captureJson();
            const log = new logger_1.Logger('test');
            log.logger = (0, pino_1.default)({ name: 'test', level: 'info' }, stream);
            log.info('no trace');
            expect(lines).toHaveLength(1);
            const record = lines[0];
            expect(record.traceId).toBeUndefined();
        });
    });
});
//# sourceMappingURL=logger.spec.js.map