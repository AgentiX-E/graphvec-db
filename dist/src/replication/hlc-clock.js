"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HlcClock = void 0;
const hlc_1 = require("@consento/hlc");
// @consento/hlc 的 Timestamp.decode 不是静态方法；decode 在 codec 对象上
// 这里通过 as any 绕过 TS 类型限制，使用运行时 API
const HLC = hlc_1.Timestamp;
const HLC_codec = hlc_1.codec;
/**
 * HlcClock — @consento/hlc 的 TypeScript 封装
 *
 * CockroachDB 兼容的混合逻辑时钟
 * 提供纳秒精度、Uint8Array 编解码、跨 DC 同步
 *
 * 保证：
 * 1. 连续调用 now() 返回单调递增的时间戳（封装层维护上一次状态）
 * 2. update() 接收远程时间戳更新本地时钟，保持因果一致性
 * 3. toBytes() 使用 @consento/hlc 编码为 Uint8Array
 *
 * 注意：@consento/hlc v2.x 的 Timestamp.decode 不存在（实际在 codec 上），
 * 通过 any 桥接使用运行时 API
 */
class HlcClock {
    lastWallTime = 0n;
    lastLogical = 0;
    constructor() { }
    /**
     * 生成当前 HLC 时间戳（保证单调递增）
     */
    now() {
        return this.nowWithWallTime();
    }
    /**
     * 生成当前时间戳，使用系统毫秒时间作为 wallTime
     * HLC 的 wallTime 通常使用毫秒或微秒精度的时间
     */
    nowWithWallTime() {
        const now = BigInt(Date.now());
        const wallTime = now > this.lastWallTime ? now : this.lastWallTime;
        if (wallTime > this.lastWallTime) {
            this.lastWallTime = wallTime;
            this.lastLogical = 0;
        }
        else {
            this.lastLogical++;
        }
        const logical = this.lastLogical;
        return {
            wallTime,
            logical,
            toBytes() {
                return HLC_codec.encode(this);
            },
        };
    }
    /**
     * 根据远程时间戳更新本地时钟
     * 保证因果一致性：opA → opB ⇒ tsA < tsB
     */
    update(remoteTimestamp) {
        let remoteWallTime;
        let remoteLogical;
        if (remoteTimestamp instanceof Uint8Array) {
            try {
                const decoded = HLC_codec.decode(remoteTimestamp);
                remoteWallTime = decoded.wallTime;
                remoteLogical = decoded.logical;
            }
            catch {
                return; // 解析失败不阻塞
            }
        }
        else {
            remoteWallTime = remoteTimestamp.wallTime;
            remoteLogical = remoteTimestamp.logical;
        }
        // 取本地和远程的最大值
        if (remoteWallTime > this.lastWallTime) {
            this.lastWallTime = remoteWallTime;
            this.lastLogical = Math.max(this.lastLogical, remoteLogical) + 1;
        }
        else if (remoteWallTime === this.lastWallTime && remoteLogical > this.lastLogical) {
            this.lastLogical = remoteLogical + 1;
        }
    }
    /**
     * wallTime 与另一个时钟比较
     * @returns -1: 小于, 0: 相等, 1: 大于
     */
    compare(tsA, tsB) {
        if (tsA.wallTime < tsB.wallTime)
            return -1;
        if (tsA.wallTime > tsB.wallTime)
            return 1;
        if (tsA.logical < tsB.logical)
            return -1;
        if (tsA.logical > tsB.logical)
            return 1;
        return 0;
    }
}
exports.HlcClock = HlcClock;
//# sourceMappingURL=hlc-clock.js.map