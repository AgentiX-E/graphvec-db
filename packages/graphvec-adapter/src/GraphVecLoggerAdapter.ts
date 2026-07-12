/**
 * GraphVecLoggerAdapter — Implements ILogger for the graphvec-db engine.
 *
 * Wraps the src/ops/Logger class (pino-based structured logger) and maps
 * its API to the db-operations ILogger interface. Also implements
 * ITraceContextProvider for async trace context propagation.
 */

import type { ILogger, LogEntry, LogLevel, ITraceContextProvider } from '@agentix-e/db-operations-logger';
import { Logger as NativeLogger, withTraceContext, getTraceId, TraceContext } from 'graphvec-db/ops/logger';

/**
 * Map pino log level strings to db-operations LogLevel.
 */
function toCanonicalLevel(level: string): LogLevel {
  switch (level) {
    case 'trace': return 'trace';
    case 'debug': return 'debug';
    case 'info': return 'info';
    case 'warn': return 'warn';
    case 'error': return 'error';
    case 'fatal': return 'fatal';
    default: return 'info';
  }
}

/**
 * GraphVecLoggerAdapter — adapts the graphvec-db Logger to ILogger.
 *
 * The graphvec-db `Logger` is pino-based with a flat method signature:
 * `logger.info('message')`. This adapter preserves the existing pino binding
 * while exposing the richer ILogger interface.
 *
 * @example
 * ```ts
 * const adapter = new GraphVecLoggerAdapter('graphvec-core');
 * adapter.info({ shardId: 'shard-1' }, 'Shard started');
 * ```
 */
export class GraphVecLoggerAdapter implements ILogger, ITraceContextProvider {
  private logger: NativeLogger;
  private bindings: Record<string, unknown>;

  constructor(
    component: string = 'graphvec-adapter',
    bindings?: Record<string, unknown>,
  ) {
    this.logger = new NativeLogger(component);
    this.bindings = { component, ...bindings };
  }

  // ── ILogger implementation ──

  child(bindings: Record<string, unknown>): ILogger {
    return new GraphVecLoggerAdapter(
      (bindings.component as string) || (this.bindings.component as string) || 'graphvec-adapter',
      { ...this.bindings, ...bindings },
    );
  }

  // trace
  trace(msg: string): void;
  trace(context: Record<string, unknown>, msg: string): void;
  trace(contextOrMsg: Record<string, unknown> | string, msg?: string): void {
    if (typeof contextOrMsg === 'string') {
      this.logger.trace(contextOrMsg);
    } else {
      this.logger.trace(`${Object.entries(contextOrMsg).map(([k, v]) => `${k}=${v}`).join(' ')} ${msg}`);
    }
  }

  // debug
  debug(msg: string): void;
  debug(context: Record<string, unknown>, msg: string): void;
  debug(contextOrMsg: Record<string, unknown> | string, msg?: string): void {
    if (typeof contextOrMsg === 'string') {
      this.logger.debug(contextOrMsg);
    } else {
      this.logger.debug(`${Object.entries(contextOrMsg).map(([k, v]) => `${k}=${v}`).join(' ')} ${msg}`);
    }
  }

  // info
  info(msg: string): void;
  info(context: Record<string, unknown>, msg: string): void;
  info(contextOrMsg: Record<string, unknown> | string, msg?: string): void {
    if (typeof contextOrMsg === 'string') {
      this.logger.info(contextOrMsg);
    } else {
      this.logger.info(`${Object.entries(contextOrMsg).map(([k, v]) => `${k}=${v}`).join(' ')} ${msg}`);
    }
  }

  // warn
  warn(msg: string): void;
  warn(context: Record<string, unknown>, msg: string): void;
  warn(contextOrMsg: Record<string, unknown> | string, msg?: string): void {
    if (typeof contextOrMsg === 'string') {
      this.logger.warn(contextOrMsg);
    } else {
      this.logger.warn(`${Object.entries(contextOrMsg).map(([k, v]) => `${k}=${v}`).join(' ')} ${msg}`);
    }
  }

  // error
  error(msg: string): void;
  error(context: Record<string, unknown>, msg: string): void;
  error(err: Error, msg?: string): void;
  error(context: Record<string, unknown>, err: Error, msg?: string): void;
  error(
    contextOrMsgOrErr: Record<string, unknown> | string | Error,
    msgOrErr?: string | Error,
    msg?: string,
  ): void {
    // error(err: Error, msg?: string)
    if (contextOrMsgOrErr instanceof Error) {
      this.logger.error(contextOrMsgOrErr.message);
      return;
    }
    // error(context, err, msg)
    if (typeof contextOrMsgOrErr === 'object' && msgOrErr instanceof Error) {
      this.logger.error(`${Object.entries(contextOrMsgOrErr).map(([k, v]) => `${k}=${v}`).join(' ')} ${msgOrErr.message}`);
      return;
    }
    // error(msg: string)
    if (typeof contextOrMsgOrErr === 'string') {
      this.logger.error(contextOrMsgOrErr);
      return;
    }
    // error(context, msg)
    if (typeof contextOrMsgOrErr === 'object') {
      this.logger.error(`${Object.entries(contextOrMsgOrErr).map(([k, v]) => `${k}=${v}`).join(' ')} ${msgOrErr}`);
    }
  }

  // fatal
  fatal(msg: string): void;
  fatal(context: Record<string, unknown>, msg: string): void;
  fatal(err: Error, msg?: string): void;
  fatal(context: Record<string, unknown>, err: Error, msg?: string): void;
  fatal(
    contextOrMsgOrErr: Record<string, unknown> | string | Error,
    msgOrErr?: string | Error,
    msg?: string,
  ): void {
    if (contextOrMsgOrErr instanceof Error) {
      this.logger.fatal(contextOrMsgOrErr.message);
      return;
    }
    if (typeof contextOrMsgOrErr === 'object' && msgOrErr instanceof Error) {
      this.logger.fatal(`${Object.entries(contextOrMsgOrErr).map(([k, v]) => `${k}=${v}`).join(' ')} ${msgOrErr.message}`);
      return;
    }
    if (typeof contextOrMsgOrErr === 'string') {
      this.logger.fatal(contextOrMsgOrErr);
      return;
    }
    if (typeof contextOrMsgOrErr === 'object') {
      this.logger.fatal(`${Object.entries(contextOrMsgOrErr).map(([k, v]) => `${k}=${v}`).join(' ')} ${msgOrErr}`);
    }
  }

  // ── ITraceContextProvider ──

  getTraceId(): string | undefined {
    return getTraceId();
  }

  withTrace<T>(traceId: string, fn: () => T): T {
    const ctx: TraceContext = { traceId, spanId: `${traceId}-span` };
    return withTraceContext(ctx, fn);
  }

  withTraceAsync<T>(traceId: string, fn: () => Promise<T>): Promise<T> {
    const ctx: TraceContext = { traceId, spanId: `${traceId}-span` };
    return new Promise<T>((resolve, reject) => {
      try {
        resolve(withTraceContext(ctx, fn));
      } catch (err) {
        reject(err);
      }
    });
  }
}
