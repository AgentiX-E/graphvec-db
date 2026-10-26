import { GraphEngine } from './graph-engine'
import { OverGraphConfig } from '../types'

/**
 * 环境变量白名单校验配置
 */
const ENV_VALIDATORS: Record<string, {
  parse: (raw: string) => unknown
  validate: (value: unknown) => string | null
}> = {
  DATA_DIR: {
    parse: (raw: string) => raw.trim(),
    validate: (value: unknown) => {
      if (typeof value !== 'string' || value.length === 0) return 'DATA_DIR must be a non-empty string'
      return null
    },
  },
  VECTOR_DIMENSION: {
    parse: (raw: string) => {
      const trimmed = raw.trim()
      // Reject fractional or garbage input (e.g. "3.7", "12abc"). `Number` then
      // `Number.isInteger` enforces a strict integer rather than parseInt's
      // silent truncation of trailing non-numeric characters.
      if (!/^[+-]?\d+$/.test(trimmed)) {
        throw new Error(`VECTOR_DIMENSION must be a valid integer, got: "${raw}"`)
      }
      const n = Number(trimmed)
      if (!Number.isInteger(n)) {
        throw new Error(`VECTOR_DIMENSION must be a valid integer, got: "${raw}"`)
      }
      return n
    },
    validate: (value: unknown) => {
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        return 'VECTOR_DIMENSION must be a positive integer'
      }
      return null
    },
  },
}

/**
 * GraphConfig — 图引擎配置管理
 * 支持从环境变量和配置对象合并，含环境变量校验
 */
export class GraphConfig {
  private config: OverGraphConfig
  private errors: string[] = []

  constructor(overrides?: Partial<OverGraphConfig>) {
    // 解析并校验环境变量
    const envConfig = this.parseEnvVars()
    if (this.errors.length > 0) {
      throw new Error(`GraphConfig environment validation failed:\n${this.errors.join('\n')}`)
    }

    this.config = {
      path: envConfig.dataDir
        ? `${envConfig.dataDir}/graph`
        : './data/graph',
      denseVector: envConfig.vectorDimension
        ? { dimension: envConfig.vectorDimension }
        : { dimension: 384 },
      // 生产默认优化参数
      overgraph: {
        compactAfterNFlushes: 0,        // 禁用自动 compaction → 手动 compact 更可控
        memtableFlushThreshold: 100000, // 增大 memtable 减少 segment 碎片
        memtableHardCapBytes: 256 * 1024 * 1024, // 256MB
      },
      ...overrides,
    }
  }

  /**
   * 解析环境变量，带校验
   */
  private parseEnvVars(): { dataDir?: string; vectorDimension?: number } {
    const result: { dataDir?: string; vectorDimension?: number } = {}

    // DATA_DIR 校验
    const dataDirRaw = process.env.DATA_DIR
    if (dataDirRaw !== undefined && dataDirRaw !== '') {
      const validator = ENV_VALIDATORS.DATA_DIR
      const parsed = validator.parse(dataDirRaw)
      const err = validator.validate(parsed)
      if (err) {
        this.errors.push(`- DATA_DIR: ${err}`)
      } else {
        result.dataDir = parsed as string
      }
    }

    // VECTOR_DIMENSION 校验
    const dimRaw = process.env.VECTOR_DIMENSION
    if (dimRaw !== undefined && dimRaw !== '') {
      const validator = ENV_VALIDATORS.VECTOR_DIMENSION
      let parsed: unknown
      try {
        parsed = validator.parse(dimRaw)
      } catch (e) {
        this.errors.push(`- VECTOR_DIMENSION: ${(e as Error).message}`)
        return result
      }
      const err = validator.validate(parsed)
      if (err) {
        this.errors.push(`- VECTOR_DIMENSION: ${err}`)
      } else {
        result.vectorDimension = parsed as number
      }
    }

    return result
  }

  getConfig(): OverGraphConfig {
    return { ...this.config }
  }

  createEngine(): GraphEngine {
    return new GraphEngine(this.getConfig())
  }
}
