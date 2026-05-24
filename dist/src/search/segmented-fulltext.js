"use strict";
// ============================================================
// SegmentedFullTextIndex — Lucene Segment 风格的分段全文索引
// 将文档分配到多个 FullTextIndex（segment）中，每个 segment
// 达到上限后冻结（read-only），新建 segment。搜索跨 segment
// 合并结果，防止单个 Map 膨胀导致 OOM。
// ============================================================
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
exports.SegmentedFullTextIndex = void 0;
const fulltext_1 = require("./fulltext");
// ──────────────────────────────────────────
// SegmentedFullTextIndex 类
// ──────────────────────────────────────────
class SegmentedFullTextIndex {
    segments = [];
    activeSegment = null;
    maxSegmentSize;
    maxSegments;
    mergePolicy;
    totalDocs = 0;
    constructor(options) {
        this.maxSegmentSize = options?.maxSegmentSize ?? 100000;
        this.maxSegments = options?.maxSegments ?? 4;
        this.mergePolicy = options?.mergePolicy ?? 'largest-first';
    }
    // ──────────────────────────────────────────
    // 公开 API
    // ──────────────────────────────────────────
    /**
     * 添加文档到当前活跃段
     * 活跃段满时自动轮转创建新段
     */
    addDocument(docId, fields) {
        if (!this.activeSegment || this.activeSegment.documentCount >= this.maxSegmentSize) {
            this.rotateSegment();
        }
        const seg = this.activeSegment;
        seg.index.addDocument(docId, fields);
        seg.documentCount = seg.index.count();
        this.totalDocs++;
        if (this.shouldMerge()) {
            this.merge();
        }
    }
    /**
     * 删除文档（在所有段中查找并删除）
     */
    removeDocument(docId) {
        for (const seg of this.segments) {
            const before = seg.index.count();
            seg.index.removeDocument(docId);
            const after = seg.index.count();
            if (after < before) {
                this.totalDocs--;
                seg.documentCount = after;
                break;
            }
        }
    }
    /**
     * 搜索所有段，合并排序结果
     */
    search(query, options) {
        if (this.totalDocs === 0)
            return [];
        const opts = {
            limit: options?.limit ?? 10,
            fields: (options?.fields?.length ? options.fields : []),
            fuzzy: options?.fuzzy ?? false,
            threshold: options?.threshold ?? 0.8,
            weights: options?.weights ?? {},
            mode: options?.mode ?? 'or',
            scoring: options?.scoring ?? 'bm25',
        };
        // 每段独立搜索，取 limit * 2 以保障合并后有足够候选
        const perSegmentLimit = opts.limit * 2 * this.segments.length;
        const segOpts = { ...opts };
        if (!segOpts.fields || segOpts.fields.length === 0) {
            delete segOpts.fields;
        }
        const allResults = new Map();
        for (const seg of this.segments) {
            const results = seg.index.search(query, { ...segOpts, limit: perSegmentLimit });
            for (const r of results) {
                const existing = allResults.get(r.docId);
                if (!existing || r.score > existing.score) {
                    allResults.set(r.docId, r);
                }
            }
        }
        const sorted = Array.from(allResults.values())
            .sort((a, b) => b.score - a.score);
        return sorted.slice(0, opts.limit).map(r => ({
            docId: r.docId,
            score: r.score,
            matches: r.matches,
        }));
    }
    /**
     * 使用 BM25 评分搜索所有段，合并排序结果
     * 保证对所有段都使用 BM25 scoring
     */
    searchWithBM25(query, options) {
        return this.search(query, { ...options, scoring: 'bm25' });
    }
    /**
     * 获取索引状态
     */
    stats() {
        return {
            documentCount: this.totalDocs,
            totalSegments: this.segments.length,
            segmentSizes: this.segments.map(s => s.documentCount),
        };
    }
    /**
     * 清空所有段
     */
    clear() {
        for (const seg of this.segments) {
            seg.index.clear();
        }
        this.segments = [];
        this.activeSegment = null;
        this.totalDocs = 0;
    }
    // ──────────────────────────────────────────
    // 内部方法
    // ──────────────────────────────────────────
    /** 收集所有段中的字段名 */
    _collectActiveFields() {
        const fields = new Set();
        for (const seg of this.segments) {
            const json = seg.index.serialize();
            const data = JSON.parse(json);
            if (data.invertedIndex) {
                for (const [, fieldIndex] of data.invertedIndex) {
                    for (const field of Object.keys(fieldIndex ?? {})) {
                        fields.add(field);
                    }
                }
            }
        }
        return fields;
    }
    /**
     * 轮转创建新段
     */
    rotateSegment() {
        if (this.activeSegment) {
            this.activeSegment.isReadOnly = true;
        }
        const id = Date.now() + Math.floor(Math.random() * 1000);
        this.activeSegment = {
            id,
            documentCount: 0,
            index: new fulltext_1.FullTextIndex(),
            isReadOnly: false,
        };
        this.segments.push(this.activeSegment);
    }
    /**
     * 判断是否需要触发合并
     */
    shouldMerge() {
        return this.segments.length > this.maxSegments;
    }
    /**
     * 合并小段（减少段数）
     *
     * 策略：当段数 > maxSegments 时，选择最小的段合并成一个新段
     */
    merge() {
        if (this.segments.length <= this.maxSegments)
            return;
        const mergeable = this.segments.filter(s => s.isReadOnly);
        if (mergeable.length < 2)
            return;
        const sorted = [...mergeable].sort((a, b) => {
            if (this.mergePolicy === 'oldest-first') {
                return a.id - b.id;
            }
            return a.documentCount - b.documentCount;
        });
        const mergeCount = Math.min(sorted.length, Math.max(2, this.maxSegments - 1));
        const toMerge = sorted.slice(0, mergeCount);
        const mergedIndex = new fulltext_1.FullTextIndex();
        let mergedDocs = 0;
        for (const seg of toMerge) {
            const docs = seg.index.getAllIndexedDocs();
            for (const { docId, fields } of docs) {
                mergedIndex.addDocument(docId, fields);
                mergedDocs++;
            }
        }
        const newSegment = {
            id: Date.now(),
            documentCount: mergedDocs,
            index: mergedIndex,
            isReadOnly: true,
        };
        const toMergeSet = new Set(toMerge);
        this.segments = [
            ...this.segments.filter(s => !toMergeSet.has(s)),
            newSegment,
        ];
        this.totalDocs = this.segments.reduce((sum, s) => sum + s.documentCount, 0);
        if (this.activeSegment && !this.segments.includes(this.activeSegment)) {
            this.activeSegment = this.segments.find(s => !s.isReadOnly) ?? null;
        }
    }
    /**
     * 序列化所有段为 JSON（用于持久化）
     */
    serialize() {
        const data = {
            version: 1,
            maxSegmentSize: this.maxSegmentSize,
            totalDocs: this.totalDocs,
            segments: this.segments.map(seg => ({
                id: seg.id,
                documentCount: seg.documentCount,
                isReadOnly: seg.isReadOnly,
                index: JSON.parse(seg.index.serialize()),
            })),
            activeSegmentId: this.activeSegment?.id ?? null,
        };
        return JSON.stringify(data);
    }
    /**
     * 从序列化的 JSON 恢复
     */
    static deserialize(json) {
        const data = JSON.parse(json);
        const index = new SegmentedFullTextIndex({
            maxSegmentSize: data.maxSegmentSize ?? 100000,
        });
        if (data.segments) {
            for (const segData of data.segments) {
                const fi = fulltext_1.FullTextIndex.deserialize(JSON.stringify(segData.index));
                const seg = {
                    id: segData.id,
                    documentCount: segData.documentCount,
                    index: fi,
                    isReadOnly: segData.isReadOnly,
                };
                index.segments.push(seg);
                if (segData.id === data.activeSegmentId) {
                    index.activeSegment = seg;
                }
            }
            if (!index.activeSegment && index.segments.length > 0) {
                index.activeSegment = index.segments[index.segments.length - 1];
            }
        }
        index.totalDocs = data.totalDocs ?? 0;
        if (index.segments.length === 0) {
            index.rotateSegment();
        }
        return index;
    }
    /**
     * 持久化到文件
     */
    async saveToFile(filePath) {
        const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
        await fs.writeFile(filePath, this.serialize(), 'utf-8');
    }
    /**
     * 从文件加载
     */
    static async loadFromFile(filePath) {
        const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
        const data = await fs.readFile(filePath, 'utf-8');
        return SegmentedFullTextIndex.deserialize(data);
    }
}
exports.SegmentedFullTextIndex = SegmentedFullTextIndex;
//# sourceMappingURL=segmented-fulltext.js.map