"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MaterializedView = void 0;
const graph_engine_1 = require("../core/graph-engine");
const logger_1 = require("../ops/logger");
/**
 * MaterializedView — 基于 OverGraph 内建能力的物化视图
 *
 * 利用 OverGraph 的 query_pattern + temporal_validity 实现
 * 不依赖独立的视图引擎，直接使用 OverGraph 实例存储
 */
class MaterializedView {
    viewEngine;
    sourceEngine;
    config;
    logger;
    refreshTimer = null;
    _stopped = false;
    constructor(config, sourceEngine, viewDataDir) {
        this.config = config;
        this.sourceEngine = sourceEngine;
        this.logger = new logger_1.Logger('MaterializedView');
        this.viewEngine = new graph_engine_1.GraphEngine({
            path: viewDataDir,
            denseVector: { dimension: 384 },
        });
    }
    /** 打开视图引擎 */
    open() {
        this.viewEngine.open();
        if (this.config.refreshPolicy === 'periodic') {
            this.startAutoRefresh();
        }
    }
    /** 关闭视图引擎 */
    close() {
        this.viewEngine.close();
        this.stopAutoRefresh();
    }
    /** 刷新视图 — 从 source engine 查询并写入 view engine */
    async refresh() {
        if (this._stopped)
            return 0;
        const results = this.sourceEngine.queryPattern(this.config.pattern);
        let count = 0;
        for (const node of results) {
            this.viewEngine.upsertNode(node.type, node.name, { props: node.props });
            count++;
        }
        return count;
    }
    /** 从视图查询 */
    query(pattern) {
        return this.viewEngine.queryPattern(pattern);
    }
    /** 删除视图 — 清除物理文件 */
    drop() {
        this.viewEngine.close();
        // 物理文件清理：调用 rm -rf 由外部管理
    }
    getStatus() {
        const stats = this.viewEngine.stats();
        return {
            name: this.config.name,
            nodeCount: stats.nodeCount,
            edgeCount: stats.edgeCount,
            lastRefreshed: null,
            nextRefresh: null,
            sizeBytes: stats.diskSizeBytes,
        };
    }
    startAutoRefresh() {
        this._stopped = false;
        if (!this.config.refreshIntervalSeconds)
            return;
        this.refreshTimer = setInterval(() => this.refresh().catch(err => this.logger.error(`[MaterializedView:${this.config.name}] Refresh error:`, err)), this.config.refreshIntervalSeconds * 1000);
    }
    stopAutoRefresh() {
        this._stopped = true;
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }
}
exports.MaterializedView = MaterializedView;
//# sourceMappingURL=materialized-view.js.map