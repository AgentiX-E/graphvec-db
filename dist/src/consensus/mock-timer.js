"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RealTimer = exports.MockTimer = void 0;
/**
 * MockTimer — 虚拟时钟计时器
 *
 * 用于测试中替代 real setTimeout/setInterval，实现：
 * - 确定性超时触发（不依赖真实时间）
 * - 快速快进（advanceTimeBy / runAll）
 * - 每个实例独立，无全局共享状态
 * - 支持清理和重置
 *
 * 接口兼容 Node.js 的 setTimeout/clearTimeout/setInterval/clearInterval
 */
class MockTimer {
    _nextId = 0;
    _currentTime = 0;
    _timeouts = [];
    _intervals = [];
    /** 获取当前虚拟时间 */
    get currentTime() {
        return this._currentTime;
    }
    setTimeout(cb, ms) {
        const id = ++this._nextId;
        this._timeouts.push({ deadline: this._currentTime + ms, cb, id });
        // 按 deadline 排序，保证触发顺序
        this._timeouts.sort((a, b) => a.deadline - b.deadline);
        return id;
    }
    clearTimeout(id) {
        this._timeouts = this._timeouts.filter(t => t.id !== id);
    }
    setInterval(cb, ms) {
        const id = ++this._nextId;
        this._intervals.push({ deadline: this._currentTime + ms, interval: ms, cb, id });
        return id;
    }
    clearInterval(id) {
        this._intervals = this._intervals.filter(t => t.id !== id);
    }
    /**
     * 推进虚拟时钟指定毫秒，触发到期的所有回调
     * 注意：一个回调执行中可能注册新的定时器，
     * 新定时器的 deadline 基于当前 _currentTime（而非推进后的时间）
     */
    advanceTimeBy(ms) {
        const targetTime = this._currentTime + ms;
        while (true) {
            // 找出所有 deadline <= targetTime 的 timeout
            const dueTimeouts = this._timeouts.filter(t => t.deadline <= targetTime);
            if (dueTimeouts.length === 0)
                break;
            // 逐个触发，允许回调注册新定时器
            for (const t of dueTimeouts) {
                this._timeouts = this._timeouts.filter(x => x.id !== t.id);
                // 将当前时间推进到该回调的 deadline
                this._currentTime = t.deadline;
                t.cb();
            }
        }
        // 推进 interval 定时器
        const dueIntervals = this._intervals.filter(t => t.deadline <= targetTime);
        for (const t of dueIntervals) {
            // 更新 deadline 到下一个周期
            // 使用循环补偿，确保快进多个周期
            while (t.deadline <= targetTime) {
                t.deadline += t.interval;
                t.cb();
            }
        }
        // 最终更新到目标时间
        this._currentTime = targetTime;
    }
    /** 执行所有待处理的 timeouts（直到队列为空） */
    runAll() {
        while (this._timeouts.length > 0) {
            const next = this._timeouts.shift();
            this._currentTime = next.deadline;
            next.cb();
        }
    }
    /** 重置所有状态 */
    reset() {
        this._timeouts = [];
        this._intervals = [];
        this._currentTime = 0;
        this._nextId = 0;
    }
}
exports.MockTimer = MockTimer;
/** Real timer provider（使用真实 setTimeout/setInterval） */
class RealTimer {
    setTimeout(cb, ms) {
        return setTimeout(cb, ms);
    }
    clearTimeout(id) {
        clearTimeout(id);
    }
    setInterval(cb, ms) {
        return setInterval(cb, ms);
    }
    clearInterval(id) {
        clearInterval(id);
    }
}
exports.RealTimer = RealTimer;
//# sourceMappingURL=mock-timer.js.map