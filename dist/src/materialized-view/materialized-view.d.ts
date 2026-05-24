import { GraphEngine } from '../core/graph-engine';
import { MaterializedViewConfig, MaterializedViewStatus, PatternMatchOptions } from '../types';
/**
 * MaterializedView — 基于 OverGraph 内建能力的物化视图
 *
 * 利用 OverGraph 的 query_pattern + temporal_validity 实现
 * 不依赖独立的视图引擎，直接使用 OverGraph 实例存储
 */
export declare class MaterializedView {
    private viewEngine;
    private sourceEngine;
    private config;
    private logger;
    private refreshTimer;
    private _stopped;
    constructor(config: MaterializedViewConfig, sourceEngine: GraphEngine, viewDataDir: string);
    /** 打开视图引擎 */
    open(): void;
    /** 关闭视图引擎 */
    close(): void;
    /** 刷新视图 — 从 source engine 查询并写入 view engine */
    refresh(): Promise<number>;
    /** 从视图查询 */
    query(pattern: PatternMatchOptions): import("../types").NodeRecord[];
    /** 删除视图 — 清除物理文件 */
    drop(): void;
    getStatus(): MaterializedViewStatus;
    private startAutoRefresh;
    private stopAutoRefresh;
}
//# sourceMappingURL=materialized-view.d.ts.map