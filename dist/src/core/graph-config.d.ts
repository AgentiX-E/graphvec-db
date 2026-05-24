import { GraphEngine } from './graph-engine';
import { OverGraphConfig } from '../types';
/**
 * GraphConfig — 图引擎配置管理
 * 支持从环境变量和配置对象合并，含环境变量校验
 */
export declare class GraphConfig {
    private config;
    private errors;
    constructor(overrides?: Partial<OverGraphConfig>);
    /**
     * 解析环境变量，带校验
     */
    private parseEnvVars;
    getConfig(): OverGraphConfig;
    createEngine(): GraphEngine;
}
//# sourceMappingURL=graph-config.d.ts.map