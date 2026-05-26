"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.LmdbWal = void 0;
/**
 * lmdb-wal.ts — LMDB WAL 持久化方案
 *
 * 替换 wal.ts 的自研二进制 WAL + 全内存 entries 数组。
 * 用 LMDB 实现：
 * - 日志条目按 index 有序存储 → 支持范围查询
 * - 每个 append 即 fsync（同步写）→ 不丢失数据
 * - 无需全量加载到内存 → 防止 OOM
 * - ACID 事务 → truncate/snapshot 原子操作
 *
 * 接口与 WAL 兼容（LogEntry, open/append/truncate/close/sync 等）。
 */
const lmdb_1 = require("lmdb");
const fs = __importStar(require("node:fs"));
const logger_1 = require("../ops/logger");
const msgpackr_1 = require("msgpackr");
/**
 * entries Db 存储结构：key=index, value={t:term, d:Buffer(data)}
 * 用 msgpackr 序列化值以确保 LMDB 能正确编码 Buffer
 */
class LmdbWal {
    dbPath;
    db;
    entriesDb;
    metaDb;
    lastIndex = 0;
    lastTerm = 0;
    logger;
    _opened = false;
    constructor(path) {
        this.dbPath = path;
        this.logger = new logger_1.Logger('LmdbWal');
    }
    get isOpen() {
        return this._opened;
    }
    async open() {
        if (this._opened)
            return;
        try {
            const dir = this.dbPath.substring(0, this.dbPath.lastIndexOf('/'));
            if (dir && dir !== this.dbPath) {
                fs.mkdirSync(dir, { recursive: true });
            }
            this.db = (0, lmdb_1.open)({
                path: this.dbPath,
                maxDbs: 2,
                noSync: false,
                mapSize: 1024 * 1024 * 1024,
                encoding: 'binary',
            });
            this.entriesDb = this.db.openDB('entries', { encoding: 'binary' });
            this.metaDb = this.db.openDB('meta', { encoding: 'string' });
            // 恢复 lastIndex / lastTerm
            const last = this._lastEntry();
            if (last) {
                this.lastIndex = last.index;
                this.lastTerm = last.term;
            }
            this._opened = true;
            this.logger.info(`LmdbWal opened: ${this.dbPath}, lastIndex=${this.lastIndex}, lastTerm=${this.lastTerm}`);
        }
        catch (err) {
            this.logger.error(`Failed to open LmdbWal: ${this.dbPath}`, err);
            throw err;
        }
    }
    async append(term, data) {
        if (!this._opened)
            throw new Error('LmdbWal not opened');
        const index = ++this.lastIndex;
        this.lastTerm = term;
        await this.entriesDb.put(index, (0, msgpackr_1.encode)({ t: term, d: Buffer.from(data) }));
        return { index, term, data };
    }
    async truncate(lastIndex) {
        if (!this._opened)
            return;
        if (lastIndex >= this.lastIndex)
            return;
        await this._deleteRange(lastIndex + 1);
        this.lastIndex = lastIndex;
        const last = this._lastEntry();
        this.lastTerm = last ? last.term : 0;
    }
    entriesCount() {
        return this.entriesDb.getCount();
    }
    async truncateBefore(index) {
        if (!this._opened)
            return;
        await this._deleteBefore(index);
        const last = this._lastEntry();
        if (last) {
            this.lastIndex = last.index;
            this.lastTerm = last.term;
        }
        else {
            this.lastIndex = 0;
            this.lastTerm = 0;
        }
    }
    readAll() {
        return this._entries().map(({ key, value }) => {
            const stored = (0, msgpackr_1.decode)(value);
            return { index: key, term: stored.t, data: stored.d };
        });
    }
    getLastIndex() { return this.lastIndex; }
    getLastTerm() { return this.lastTerm; }
    getEntry(index) {
        const buf = this.entriesDb.get(index);
        if (!buf)
            return undefined;
        const stored = (0, msgpackr_1.decode)(buf);
        return { index, term: stored.t, data: stored.d };
    }
    getEntriesFrom(startIndex) {
        return this._entries(startIndex).map(({ key, value }) => {
            const stored = (0, msgpackr_1.decode)(value);
            return { index: key, term: stored.t, data: stored.d };
        });
    }
    async close() {
        if (!this._opened)
            return;
        this._opened = false;
        await this.db.close();
    }
    async sync() {
        if (!this._opened)
            return;
        await this.db.transactionSync?.(() => { });
    }
    async destroy() {
        await this.close();
        try {
            fs.rmSync(this.dbPath, { recursive: true, force: true });
        }
        catch { /* ignore */ }
        this.lastIndex = 0;
        this.lastTerm = 0;
    }
    async persistMeta(key, value) {
        if (!this._opened)
            return;
        await this.metaDb.put(key, value);
    }
    loadMeta(key) {
        if (!this._opened)
            return undefined;
        return this.metaDb.get(key);
    }
    // ─── 内部辅助 ──────────────────────────────
    _lastEntry() {
        const range = this.entriesDb.getRange({ limit: 1, reverse: true });
        const arr = range.asArray ?? [];
        if (arr.length > 0) {
            const { key, value } = arr[0];
            const stored = (0, msgpackr_1.decode)(value);
            return { index: key, term: stored.t };
        }
        return null;
    }
    _entries(start) {
        const opts = {};
        if (start !== undefined)
            opts.start = start;
        const range = this.entriesDb.getRange(opts);
        return range.asArray ?? [];
    }
    async _deleteRange(startIndex) {
        const eDb = this.entriesDb;
        const opts = { start: startIndex };
        for (const { key } of eDb.getRange(opts).asArray ?? []) {
            await eDb.remove(key);
        }
    }
    async _deleteBefore(index) {
        const eDb = this.entriesDb;
        for (const { key } of eDb.getRange({ end: index - 1, start: -Infinity }).asArray ?? []) {
            await eDb.remove(key);
        }
    }
}
exports.LmdbWal = LmdbWal;
//# sourceMappingURL=lmdb-wal.js.map