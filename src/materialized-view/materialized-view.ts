import { GraphEngine } from '../core/graph-engine'
import {
  MaterializedViewConfig, MaterializedViewStatus, PatternMatchOptions, OverGraphConfig,
} from '../types'
import { Logger } from '../ops/logger'

/**
 * MaterializedView — 基于 OverGraph 内建能力的物化视图
 *
 * 利用 OverGraph 的 query_pattern + temporal_validity 实现
 * 不依赖独立的视图引擎，直接使用 OverGraph 实例存储
 */
export class MaterializedView {
  private viewEngine: GraphEngine
  private sourceEngine: GraphEngine
  private config: MaterializedViewConfig
  private logger: Logger
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private _stopped: boolean = false

  constructor(
    config: MaterializedViewConfig,
    sourceEngine: GraphEngine,
    viewDataDir: string,
  ) {
    this.config = config
    this.sourceEngine = sourceEngine
    this.logger = new Logger('MaterializedView')
    this.viewEngine = new GraphEngine({
      path: viewDataDir,
      denseVector: { dimension: 384 },
    } as OverGraphConfig)
  }

  /** 打开视图引擎 */
  open(): void {
    this.viewEngine.open()
    if (this.config.refreshPolicy === 'periodic') {
      this.startAutoRefresh()
    }
  }

  /** 关闭视图引擎 */
  close(): void {
    this.viewEngine.close()
    this.stopAutoRefresh()
  }

  /** 刷新视图 — 从 source engine 查询并写入 view engine */
  async refresh(): Promise<number> {
    if (this._stopped) return 0
    const results = this.sourceEngine.queryPattern(this.config.pattern)
    let count = 0

    for (const node of results) {
      this.viewEngine.upsertNode(node.type, node.name, { props: node.props })
      count++
    }

    return count
  }

  /** 从视图查询 */
  query(pattern: PatternMatchOptions) {
    return this.viewEngine.queryPattern(pattern)
  }

  /** 删除视图 — 清除物理文件 */
  drop(): void {
    this.viewEngine.close()
    // 物理文件清理：调用 rm -rf 由外部管理
  }

  getStatus(): MaterializedViewStatus {
    const stats = this.viewEngine.stats()
    return {
      name: this.config.name,
      nodeCount: stats.nodeCount,
      edgeCount: stats.edgeCount,
      lastRefreshed: null,
      nextRefresh: null,
      sizeBytes: stats.diskSizeBytes,
    }
  }

  private startAutoRefresh(): void {
    this._stopped = false
    if (!this.config.refreshIntervalSeconds) return
    this.refreshTimer = setInterval(
      () => this.refresh().catch(err => this.logger.error(`[MaterializedView:${this.config.name}] Refresh error:`, err as Error)),
      this.config.refreshIntervalSeconds * 1000
    )
    this.refreshTimer.unref()
  }

  private stopAutoRefresh(): void {
    this._stopped = true
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  }
}
