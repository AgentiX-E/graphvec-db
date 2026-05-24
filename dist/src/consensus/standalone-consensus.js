"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StandaloneConsensus = void 0;
/**
 * StandaloneConsensus — 单节点共识实现
 *
 * 无网络共识，直接本地应用写入
 * 适用于开发、测试、单节点部署
 */
class StandaloneConsensus {
    config;
    applyFn = null;
    _started = false;
    constructor(config) {
        this.config = { ...config, mode: 'standalone' };
    }
    setApply(fn) {
        this.applyFn = fn;
    }
    async start() {
        this._started = true;
    }
    async stop() {
        this._started = false;
    }
    async propose(data, _timeoutMs) {
        if (!this._started)
            return { ok: false };
        if (this.applyFn) {
            try {
                await this.applyFn(data);
                return { ok: true };
            }
            catch (err) {
                return { ok: false };
            }
        }
        return { ok: false };
    }
    async readIndex(_timeoutMs) {
        // standalone 模式无需等待
        return;
    }
    getRole() {
        return 'standalone';
    }
    getLeaderId() {
        return this._started ? this.config.nodeId : null;
    }
    getTerm() {
        return 1;
    }
    async waitForLeader(_timeoutMs) {
        return;
    }
}
exports.StandaloneConsensus = StandaloneConsensus;
//# sourceMappingURL=standalone-consensus.js.map