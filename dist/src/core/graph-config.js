"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GraphConfig = void 0;
const graph_engine_1 = require("./graph-engine");
/**
 * 环境变量白名单校验配置
 */
const ENV_VALIDATORS = {
    DATA_DIR: {
        parse: (raw) => raw.trim(),
        validate: (value) => {
            if (typeof value !== 'string' || value.length === 0)
                return 'DATA_DIR must be a non-empty string';
            return null;
        },
    },
    VECTOR_DIMENSION: {
        parse: (raw) => {
            const n = parseInt(raw, 10);
            if (isNaN(n))
                throw new Error(`VECTOR_DIMENSION must be a valid integer, got: "${raw}"`);
            return n;
        },
        validate: (value) => {
            if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
                return 'VECTOR_DIMENSION must be a positive integer';
            }
            return null;
        },
    },
};
/**
 * GraphConfig — 图引擎配置管理
 * 支持从环境变量和配置对象合并，含环境变量校验
 */
class GraphConfig {
    config;
    errors = [];
    constructor(overrides) {
        // 解析并校验环境变量
        const envConfig = this.parseEnvVars();
        if (this.errors.length > 0) {
            throw new Error(`GraphConfig environment validation failed:\n${this.errors.join('\n')}`);
        }
        this.config = {
            path: envConfig.dataDir
                ? `${envConfig.dataDir}/graph`
                : './data/graph',
            denseVector: envConfig.vectorDimension
                ? { dimension: envConfig.vectorDimension }
                : { dimension: 384 },
            ...overrides,
        };
    }
    /**
     * 解析环境变量，带校验
     */
    parseEnvVars() {
        const result = {};
        // DATA_DIR 校验
        const dataDirRaw = process.env.DATA_DIR;
        if (dataDirRaw !== undefined && dataDirRaw !== '') {
            const validator = ENV_VALIDATORS.DATA_DIR;
            const parsed = validator.parse(dataDirRaw);
            const err = validator.validate(parsed);
            if (err) {
                this.errors.push(`- DATA_DIR: ${err}`);
            }
            else {
                result.dataDir = parsed;
            }
        }
        // VECTOR_DIMENSION 校验
        const dimRaw = process.env.VECTOR_DIMENSION;
        if (dimRaw !== undefined && dimRaw !== '') {
            const validator = ENV_VALIDATORS.VECTOR_DIMENSION;
            let parsed;
            try {
                parsed = validator.parse(dimRaw);
            }
            catch (e) {
                this.errors.push(`- VECTOR_DIMENSION: ${e.message}`);
                return result;
            }
            const err = validator.validate(parsed);
            if (err) {
                this.errors.push(`- VECTOR_DIMENSION: ${err}`);
            }
            else {
                result.vectorDimension = parsed;
            }
        }
        return result;
    }
    getConfig() {
        return { ...this.config };
    }
    createEngine() {
        return new graph_engine_1.GraphEngine(this.getConfig());
    }
}
exports.GraphConfig = GraphConfig;
//# sourceMappingURL=graph-config.js.map