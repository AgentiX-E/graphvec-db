/**
 * compression.ts — REST API 响应压缩中间件
 *
 * 使用原生 Node.js zlib 实现 gzip/brotli 压缩。
 * 不引入新 npm 包（zlib 为 Node.js 内置）。
 *
 * 支持：
 * - Accept-Encoding 协商（gzip / brotli）
 * - 可配置压缩阈值（默认 >= 1024 bytes 才压缩）
 * - 仅压缩 application/json 响应
 * - 压缩级别可配置（fast / balanced / max）
 */

import * as zlib from 'zlib'
import type { IncomingMessage, ServerResponse } from 'http'

// ── 类型定义 ──────────────────────────────────────────────

export type CompressionAlgorithm = 'gzip' | 'brotli' | 'none'
export type CompressionLevel = 'fast' | 'balanced' | 'max'

export interface CompressionOptions {
  /** 压缩算法，默认 gzip */
  algorithm: CompressionAlgorithm
  /** 压缩级别，默认 balanced */
  level: CompressionLevel
  /** 最小压缩字节数（小于此值不压缩），默认 1024 */
  threshold: number
  /** 要压缩的 Content-Type 列表 */
  contentTypes: string[]
}

// ── 默认配置 ──────────────────────────────────────────────

const DEFAULT_OPTIONS: CompressionOptions = {
  algorithm: 'gzip',
  level: 'balanced',
  threshold: 1024,
  contentTypes: ['application/json'],
}

const zlibLevelMap: Record<CompressionLevel, number> = {
  fast: zlib.constants.Z_BEST_SPEED,
  balanced: zlib.constants.Z_DEFAULT_COMPRESSION,
  max: zlib.constants.Z_BEST_COMPRESSION,
}

/**
 * 在 headers 对象中进行 case-insensitive 键查找
 */
function findHeader(
  headers: Record<string, string | number | string[] | undefined>,
  key: string,
): string | undefined {
  const lowerKey = key.toLowerCase()
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lowerKey) {
      const val = headers[k]
      if (val === undefined) return undefined
      return String(val)
    }
  }
  return undefined
}

// ── Accept-Encoding 协商 ─────────────────────────────────

/**
 * 根据 Accept-Encoding 请求头协商最佳压缩算法
 *
 * 优先级：brotli > gzip > 无压缩
 *
 * @returns 协商后的压缩算法，若不支持压缩则返回 'none'
 */
export function negotiateEncoding(
  acceptEncoding: string | undefined,
): 'gzip' | 'brotli' | null {
  if (!acceptEncoding) return null

  const encodings = acceptEncoding.toLowerCase().split(',').map(e => e.trim())

  // 检查是否包含 identity（表示接受未编码响应）
  const hasIdentity = encodings.includes('identity')
  const qValues: { encoding: string; q: number }[] = []

  for (const encoding of encodings) {
    const parts = encoding.split(';')
    const name = parts[0].trim()
    let q = 1.0
    if (parts.length > 1) {
      const qMatch = parts[1].match(/q\s*=\s*([\d.]+)/)
      if (qMatch) q = parseFloat(qMatch[1])
    }
    qValues.push({ encoding: name, q })
  }

  // 按 q 值降序排序
  qValues.sort((a, b) => b.q - a.q)

  for (const { encoding, q } of qValues) {
    if (q === 0) continue
    if (encoding === 'br') return 'brotli'
    if (encoding === 'gzip') return 'gzip'
    if (encoding === '*') return 'gzip' // 通配符默认 gzip
  }

  if (hasIdentity) return null
  return null
}

// ── CompressionMiddleware ─────────────────────────────────

/**
 * CompressionMiddleware — REST 响应压缩中间件
 *
 * 包装 ServerResponse 的 write/end 方法，在写入时压缩响应体。
 * 只在满足以下条件时压缩：
 * 1. Content-Type 在 contentTypes 列表中
 * 2. 响应体大小 >= threshold
 * 3. 客户端 Accept-Encoding 支持 gzip 或 brotli
 */
export class CompressionMiddleware {
  private options: CompressionOptions

  constructor(options?: Partial<CompressionOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  /**
   * 获取当前配置
   */
  getOptions(): Readonly<CompressionOptions> {
    return Object.freeze({ ...this.options })
  }

  /**
   * 更新配置
   */
  setOptions(partial: Partial<CompressionOptions>): void {
    this.options = { ...this.options, ...partial }
  }

  /**
   * REST 响应压缩中间件
   *
   * 包装 ServerResponse，使其在 write/end 时进行压缩。
   * 需在写入响应头**之前**调用。
   *
   * @example
   * ```ts
   * const middleware = new CompressionMiddleware()
   * middleware.wrapResponse(req, res)
   * ```
   */
  wrapResponse(req: IncomingMessage, res: ServerResponse): void {
    const encoding = negotiateEncoding(req.headers['accept-encoding'])
    if (!encoding || encoding === 'none') return

    const algorithm = this.options.algorithm === 'auto' ? encoding : this.options.algorithm
    if (algorithm === 'none') return

    // 捕获当前配置列表（避免 this 上下文丢失问题）
    const contentTypes = this.options.contentTypes
    const threshold = this.options.threshold
    const optLevel = this.options.level

    // 保存原始方法引用
    const originalWriteHead = res.writeHead.bind(res)
    const originalEnd = res.end.bind(res) as ServerResponse['end']

    // 延迟 writeHead — 在 end() 时统一 flush
    let deferredStatus: number | null = null
    let deferredReason: string | undefined
    let deferredHeaders: Record<string, string | number | string[]> | undefined
    let compressionApplied = false
    let responseBodyChunks: Buffer[] = []

    // 缓存 write 调用的数据
    res.write = function (chunk: any, _encodingOrCb?: any, _cb?: any): boolean {
      if (chunk) {
        responseBodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      }
      return true
    } as any

    // 覆盖 writeHead — 暂存 headers，不立即发送
    res.writeHead = function (statusCode: number, ...args: any[]): ServerResponse {
      deferredStatus = statusCode

      if (typeof args[0] === 'string') {
        deferredReason = args[0] as string
        deferredHeaders = args[1] as Record<string, string | number | string[]>
      } else {
        deferredReason = undefined
        deferredHeaders = args[0] as Record<string, string | number | string[]>
      }

      // 合并已设置的头部，检查是否应压缩（case-insensitive）
      const allHeaders = { ...res.getHeaders(), ...deferredHeaders } as Record<string, string | number | string[]>
      const contentType = findHeader(allHeaders, 'content-type') ?? ''
      compressionApplied = contentTypes.some(ct => contentType.toLowerCase().includes(ct.toLowerCase()))

      // 将要压缩时，移除 Content-Length（压缩后长度会变）
      if (compressionApplied && deferredHeaders && allHeaders['content-length'] !== undefined) {
        delete (deferredHeaders as any)['content-length']
      }

      return res
    } as any

    // 覆盖 end — 执行实际压缩
    res.end = function (this: ServerResponse, ...args: any[]): ServerResponse {
      // 收集最后的 data chunk
      let finalChunk: Buffer | undefined
      if (args.length > 0 && (Buffer.isBuffer(args[0]) || typeof args[0] === 'string')) {
        finalChunk = Buffer.isBuffer(args[0]) ? args[0] : Buffer.from(String(args[0]))
      }

      if (finalChunk) {
        responseBodyChunks.push(finalChunk)
      }

      const fullBody = Buffer.concat(responseBodyChunks)

      // 如果已标记压缩且 body 超过阈值
      if (compressionApplied && fullBody.length >= threshold) {
        const compressFn = algorithm === 'brotli'
          ? (data: Buffer) => zlib.brotliCompressSync(data, {
              params: {
                [zlib.constants.BROTLI_PARAM_QUALITY]: 6,
              },
            })
          : (data: Buffer) => zlib.gzipSync(data, { level: zlibLevelMap[optLevel] })

        try {
          const compressed = compressFn(fullBody)

          // Pre-set headers so getHeader() can read them
          if (deferredHeaders) {
            for (const [k, v] of Object.entries(deferredHeaders)) {
              try { res.setHeader(k, v as string | number | string[]) } catch { /* ignore */ }
            }
          }
          try { res.setHeader('Content-Encoding', algorithm) } catch { /* ignore */ }
          try { res.setHeader('Content-Length', compressed.length) } catch { /* ignore */ }

          if (deferredReason) {
            originalWriteHead(deferredStatus ?? 200, deferredReason)
          } else {
            originalWriteHead(deferredStatus ?? 200)
          }

          originalEnd(compressed)
          return res as any
        } catch {
          // 压缩失败时回退到未压缩
          if (deferredHeaders) {
            for (const [k, v] of Object.entries(deferredHeaders)) {
              try { res.setHeader(k, v as string | number | string[]) } catch { /* ignore */ }
            }
          }
          try { res.setHeader('Content-Length', fullBody.length) } catch { /* ignore */ }

          if (deferredReason) {
            originalWriteHead(deferredStatus ?? 200, deferredReason)
          } else {
            originalWriteHead(deferredStatus ?? 200)
          }
          originalEnd(fullBody)
          return res as any
        }
      }

      // 不压缩 — 正常输出
      // Set all deferred headers before flushing
      if (deferredHeaders) {
        for (const [k, v] of Object.entries(deferredHeaders)) {
          try { res.setHeader(k, v as string | number | string[]) } catch { /* ignore */ }
        }
      }
      try { res.setHeader('Content-Length', fullBody.length) } catch { /* ignore */ }

      if (deferredReason) {
        originalWriteHead(deferredStatus ?? 200, deferredReason)
      } else {
        originalWriteHead(deferredStatus ?? 200)
      }
      originalEnd(fullBody)
      return res as any
    } as any
  }

  /**
   * gRPC 压缩选项
   *
   * @returns 可传递给 @grpc/grpc-js ChannelOptions 的压缩配置
   */
  getGrpcCompressionOptions(): Record<string, number> {
    const options: Record<string, number> = {}

    if (this.options.algorithm === 'gzip' || this.options.algorithm === 'none') {
      // @grpc/grpc-js 使用 grpc.default_compression_algorithm
      // 2 = grpc.compress.GZip 压缩算法标识
      options['grpc.default_compression_algorithm'] = this.options.algorithm === 'gzip' ? 2 : 0
    }

    return options
  }

  // ── 内部工具 ──────────────────────────────

  private getBrotliQuality(): number {
    switch (this.options.level) {
      case 'fast': return zlib.constants.BROTLI_MIN_QUALITY
      case 'max': return zlib.constants.BROTLI_MAX_QUALITY
      case 'balanced': return 6
    }
  }
}
