import { GraphEngine } from './graph-engine'
import { OverGraphConfig } from '../types'

/**
 * GraphConfig — 图引擎配置管理
 * 支持从环境变量和配置对象合并
 */
export class GraphConfig {
  private config: OverGraphConfig

  constructor(overrides?: Partial<OverGraphConfig>) {
    this.config = {
      path: process.env.DATA_DIR
        ? `${process.env.DATA_DIR}/graph`
        : './data/graph',
      denseVector: process.env.VECTOR_DIMENSION
        ? { dimension: parseInt(process.env.VECTOR_DIMENSION, 10) }
        : { dimension: 384 },
      ...overrides,
    }
  }

  getConfig(): OverGraphConfig {
    return { ...this.config }
  }

  createEngine(): GraphEngine {
    return new GraphEngine(this.getConfig())
  }
}
