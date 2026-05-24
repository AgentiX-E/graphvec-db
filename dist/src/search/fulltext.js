"use strict";
// ============================================================
// FullTextIndex — 内存全文索引
// 支持分词、倒排索引、BM25 评分、高亮、拼写校正、持久化
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
exports.FullTextIndex = void 0;
// ──────────────────────────────────────────
// BM25 常量
// ──────────────────────────────────────────
const BM25_K1 = 1.2;
const BM25_B = 0.75;
// ──────────────────────────────────────────
// FullTextIndex 类
// ──────────────────────────────────────────
class FullTextIndex {
    docs = new Map();
    invertedIndex = new Map(); // term → field → docIds
    options;
    // BM25 辅助数据结构
    _termFreqs = new Map(); // term → docId → tf (per entire doc, across fields)
    _docLengths = new Map(); // docId → total terms
    _avgDocLength = 0;
    constructor(options) {
        this.options = {
            defaultFieldWeight: options?.defaultFieldWeight ?? 1.0,
            fieldWeights: options?.fieldWeights ?? { name: 2.0, title: 2.0, description: 1.0, content: 1.0 },
            analyzer: options?.analyzer ?? 'simple',
        };
    }
    // ──────────────────────────────────────────
    // 核心 API
    // ──────────────────────────────────────────
    /**
     * 添加文档到索引
     */
    addDocument(docId, fields) {
        if (this.docs.has(docId)) {
            this.removeDocument(docId);
        }
        this.docs.set(docId, { fields });
        // 为当前文档统计 term 频率和文档长度
        const termCounts = new Map();
        let totalTerms = 0;
        for (const [fieldName, fieldValue] of Object.entries(fields)) {
            const tokens = this.tokenize(fieldValue);
            const uniqueTokens = new Set(tokens);
            // 更新倒排索引（精确 docIds, 每个 term 只记录一次 per doc 用于倒排）
            for (const token of uniqueTokens) {
                let fieldIndex = this.invertedIndex.get(token);
                if (!fieldIndex) {
                    fieldIndex = new Map();
                    this.invertedIndex.set(token, fieldIndex);
                }
                let docSet = fieldIndex.get(fieldName);
                if (!docSet) {
                    docSet = new Set();
                    fieldIndex.set(fieldName, docSet);
                }
                docSet.add(docId);
            }
            // 更新 term 频率（all tokens, including repeats）
            for (const token of tokens) {
                termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
                totalTerms++;
            }
        }
        // 更新 BM25 数据结构
        this._docLengths.set(docId, totalTerms);
        for (const [term, freq] of termCounts) {
            let perDoc = this._termFreqs.get(term);
            if (!perDoc) {
                perDoc = new Map();
                this._termFreqs.set(term, perDoc);
            }
            perDoc.set(docId, freq);
        }
        this._recomputeAvgDocLength();
    }
    /**
     * 从索引中删除文档
     */
    removeDocument(docId) {
        this.docs.delete(docId);
        for (const [, fieldIndex] of this.invertedIndex) {
            for (const [, docSet] of fieldIndex) {
                docSet.delete(docId);
            }
        }
        // 清理空的倒排索引条目
        for (const [term, fieldIndex] of this.invertedIndex) {
            for (const [field, docSet] of fieldIndex) {
                if (docSet.size === 0) {
                    fieldIndex.delete(field);
                }
            }
            if (fieldIndex.size === 0) {
                this.invertedIndex.delete(term);
            }
        }
        // 清理 BM25 数据结构
        this._docLengths.delete(docId);
        for (const [, perDoc] of this._termFreqs) {
            perDoc.delete(docId);
        }
        // 清理空 term 条目
        for (const [term, perDoc] of this._termFreqs) {
            if (perDoc.size === 0) {
                this._termFreqs.delete(term);
            }
        }
        this._recomputeAvgDocLength();
    }
    /**
     * 搜索索引
     */
    search(query, options) {
        if (!query.trim())
            return [];
        const opts = {
            limit: options?.limit ?? 10,
            fields: options?.fields ?? [],
            fuzzy: options?.fuzzy ?? false,
            threshold: options?.threshold ?? 0.8,
            weights: options?.weights ?? {},
            mode: options?.mode ?? 'or',
            scoring: options?.scoring ?? 'bm25',
        };
        const queryTokens = this.tokenize(query);
        if (queryTokens.length === 0)
            return [];
        // 加权评分
        const scores = new Map();
        const matches = new Map();
        if (opts.scoring === 'bm25' && this.docs.size > 0 && this._avgDocLength > 0) {
            // BM25 scoring: compute BM25 per query term, then combine
            const N = this.docs.size;
            const fieldWeightOverride = Object.keys(opts.weights).length > 0
                ? opts.weights
                : this.options.fieldWeights;
            for (const queryToken of queryTokens) {
                const exactMatchDocs = this.findExact(queryToken, opts.fields);
                const df = exactMatchDocs.size;
                const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
                for (const docId of exactMatchDocs) {
                    const dl = this._docLengths.get(docId) ?? 1;
                    const tf = this._termFreqs.get(queryToken)?.get(docId) ?? 1;
                    // BM25 term score (without field weighting)
                    const numerator = tf * (BM25_K1 + 1);
                    const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / this._avgDocLength));
                    let bm25Score = idf * (numerator / denominator);
                    // Apply field weight as a multiplier
                    const fieldWeight = this.getFieldWeightMultiplier(docId, queryToken, opts.fields, fieldWeightOverride);
                    bm25Score *= fieldWeight;
                    const current = scores.get(docId) ?? 0;
                    scores.set(docId, current + bm25Score);
                    if (!matches.has(docId)) {
                        matches.set(docId, {});
                    }
                    const docMatches = matches.get(docId);
                    const matchingFields = this.getMatchingFields(docId, queryToken, opts.fields);
                    for (const field of matchingFields) {
                        if (!docMatches[field])
                            docMatches[field] = [];
                        if (!docMatches[field].includes(queryToken)) {
                            docMatches[field].push(queryToken);
                        }
                    }
                }
                // 模糊匹配 (fuzzy still additive)
                if (opts.fuzzy) {
                    const fuzzyDocs = this.findFuzzy(queryToken, opts.threshold, opts.fields);
                    for (const { docId, score: fuzzyScore } of fuzzyDocs) {
                        const current = scores.get(docId) ?? 0;
                        scores.set(docId, current + fuzzyScore);
                    }
                }
            }
        }
        else {
            // Fallback: original additive scoring
            for (const queryToken of queryTokens) {
                const exactMatchDocs = this.findExact(queryToken, opts.fields);
                for (const docId of exactMatchDocs) {
                    const current = scores.get(docId) ?? 0;
                    const fieldWeights = this.getFieldWeights(docId, queryToken, opts.fields, opts.weights);
                    const maxWeight = Math.max(...Object.values(fieldWeights), 0);
                    scores.set(docId, current + maxWeight);
                    if (!matches.has(docId)) {
                        matches.set(docId, {});
                    }
                    const docMatches = matches.get(docId);
                    for (const [field, weight] of Object.entries(fieldWeights)) {
                        if (weight > 0) {
                            if (!docMatches[field])
                                docMatches[field] = [];
                            if (!docMatches[field].includes(queryToken)) {
                                docMatches[field].push(queryToken);
                            }
                        }
                    }
                }
                // 模糊匹配
                if (opts.fuzzy) {
                    const fuzzyDocs = this.findFuzzy(queryToken, opts.threshold, opts.fields);
                    for (const { docId, score: fuzzyScore } of fuzzyDocs) {
                        const current = scores.get(docId) ?? 0;
                        scores.set(docId, current + fuzzyScore);
                    }
                }
            }
        }
        // 根据模式过滤
        let resultDocIds;
        if (opts.mode === 'and') {
            resultDocIds = Array.from(scores.keys()).filter(docId => {
                for (const token of queryTokens) {
                    if (!this.docHasTerm(docId, token)) {
                        return false;
                    }
                }
                return true;
            });
        }
        else {
            resultDocIds = Array.from(scores.keys());
        }
        // 排序并截取
        const results = resultDocIds
            .map(docId => ({
            docId,
            score: scores.get(docId) ?? 0,
            matches: matches.get(docId),
        }))
            .sort((a, b) => b.score - a.score)
            .slice(0, opts.limit);
        return results;
    }
    /**
     * 获取所有已索引的文档
     * 用于段合并时遍历所有文档
     */
    getAllIndexedDocs() {
        const result = [];
        for (const [docId, doc] of this.docs) {
            result.push({ docId, fields: { ...doc.fields } });
        }
        return result;
    }
    /**
     * 获取索引统计
     */
    stats() {
        return {
            documentCount: this.docs.size,
            termCount: this.invertedIndex.size,
        };
    }
    /**
     * 清空索引
     */
    clear() {
        this.docs.clear();
        this.invertedIndex.clear();
        this._termFreqs.clear();
        this._docLengths.clear();
        this._avgDocLength = 0;
    }
    // ──────────────────────────────────────────
    // 字段权重 & 高亮
    // ──────────────────────────────────────────
    /**
     * 高亮文档中的匹配词
     */
    highlight(docId, query, before = '<b>', after = '</b>') {
        const doc = this.docs.get(docId);
        if (!doc)
            return {};
        const queryTokens = this.tokenize(query);
        if (queryTokens.length === 0)
            return { ...doc.fields };
        const result = {};
        for (const [fieldName, fieldValue] of Object.entries(doc.fields)) {
            const value = Array.isArray(fieldValue) ? fieldValue.join(' ') : fieldValue;
            let highlighted = value;
            for (const token of queryTokens) {
                const regex = new RegExp(`(${this.escapeRegex(token)})`, 'gi');
                highlighted = highlighted.replace(regex, `${before}$1${after}`);
            }
            result[fieldName] = highlighted;
        }
        return result;
    }
    /**
     * 拼写校正建议
     */
    spellCorrect(query, maxSuggestions = 3) {
        const tokens = this.tokenize(query);
        if (tokens.length === 0)
            return [];
        const suggestions = [];
        const knownTerms = Array.from(this.invertedIndex.keys());
        for (const token of tokens) {
            if (this.invertedIndex.has(token)) {
                suggestions.push(token);
                continue;
            }
            let bestDistance = Infinity;
            let bestTerm = token;
            for (const term of knownTerms) {
                const dist = this.levenshteinDistance(token.toLowerCase(), term.toLowerCase());
                if (dist < bestDistance) {
                    bestDistance = dist;
                    bestTerm = term;
                }
            }
            if (bestDistance > 0 && bestDistance <= 2) {
                suggestions.push(bestTerm);
            }
            else {
                suggestions.push(token);
            }
        }
        return Array.from(new Set(suggestions)).slice(0, maxSuggestions);
    }
    // ──────────────────────────────────────────
    // 持久化
    // ──────────────────────────────────────────
    /**
     * 序列化索引为 JSON
     */
    serialize() {
        const data = {
            docs: Array.from(this.docs.entries()),
            invertedIndex: Array.from(this.invertedIndex.entries()).map(([term, fieldIndex]) => [
                term,
                Array.from(fieldIndex.entries()).map(([field, docSet]) => [
                    field,
                    Array.from(docSet),
                ]),
            ]),
            options: this.options,
            _termFreqs: Array.from(this._termFreqs.entries()).map(([term, perDoc]) => [
                term,
                Array.from(perDoc.entries()),
            ]),
            _docLengths: Array.from(this._docLengths.entries()),
            _avgDocLength: this._avgDocLength,
        };
        return JSON.stringify(data);
    }
    /**
     * 从 JSON 恢复索引
     */
    static deserialize(json) {
        const data = JSON.parse(json);
        const index = new FullTextIndex(data.options);
        if (data.docs) {
            for (const [docId, docData] of data.docs) {
                index.docs.set(docId, docData);
            }
        }
        if (data.invertedIndex) {
            for (const [term, fieldEntries] of data.invertedIndex) {
                const fieldIndex = new Map();
                for (const [field, docIds] of fieldEntries) {
                    fieldIndex.set(field, new Set(docIds));
                }
                index.invertedIndex.set(term, fieldIndex);
            }
        }
        // 恢复 BM25 数据结构（兼容旧序列化格式）
        if (data._termFreqs) {
            for (const [term, perDoc] of data._termFreqs) {
                index._termFreqs.set(term, new Map(perDoc));
            }
        }
        if (data._docLengths) {
            index._docLengths = new Map(data._docLengths);
        }
        index._avgDocLength = data._avgDocLength ?? 0;
        return index;
    }
    /**
     * 保存到文件
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
        return FullTextIndex.deserialize(data);
    }
    // ──────────────────────────────────────────
    // 内部方法
    // ──────────────────────────────────────────
    tokenize(value) {
        if (Array.isArray(value)) {
            return value.flatMap(v => this.tokenizeString(v));
        }
        return this.tokenizeString(value);
    }
    tokenizeString(text) {
        if (!text)
            return [];
        // 检测是否包含 CJK 字符
        const hasCJK = /[\u4e00-\u9fff]/.test(text);
        if (hasCJK && this.options.analyzer === 'cjk') {
            return this._tokenizeCJK(text);
        }
        if (this.options.analyzer === 'simple') {
            const tokens = text
                .toLowerCase()
                .split(/[^a-zA-Z0-9\u4e00-\u9fff]+/)
                .filter(t => t.length > 0);
            // CJK 字符做 bigram 切分
            return this._splitCJKTokens(tokens);
        }
        // standard analyzer
        const tokens = text
            .toLowerCase()
            .split(/[^a-zA-Z0-9]+/)
            .filter(t => t.length > 0);
        // CJK 字符做 bigram 切分
        return this._splitCJKTokens(tokens);
    }
    /**
     * 将包含 CJK 字符的 token 拆分为 bigram
     */
    _splitCJKTokens(tokens) {
        const result = [];
        for (const token of tokens) {
            if (/[\u4e00-\u9fff]/.test(token)) {
                const cjkParts = this._splitCJKBigrams(token);
                result.push(...cjkParts);
            }
            else {
                result.push(token);
            }
        }
        return result;
    }
    /**
     * CJK bigram tokenizer: 对纯 CJK 文本做 2-gram 切分，
     * 对混合文本（如 "hello你好world"）拆分 CJK 和非 CJK 片段。
     */
    _tokenizeCJK(text) {
        const result = [];
        const lower = text.toLowerCase();
        // 将文本按连续的非 CJK 和 CJK 片段拆分
        const segments = lower.split(/([\u4e00-\u9fff]+)/).filter(s => s.length > 0);
        for (const segment of segments) {
            if (/^[\u4e00-\u9fff]+$/.test(segment)) {
                // 纯 CJK 片段：bigram
                const bigrams = this._splitCJKBigrams(segment);
                result.push(...bigrams);
            }
            else {
                // 非 CJK 片段：按原有规则切分
                const subTokens = segment
                    .split(/[^a-zA-Z0-9]+/)
                    .filter(t => t.length > 0);
                result.push(...subTokens);
            }
        }
        return result;
    }
    /**
     * 对纯 CJK 字符串做 2-gram（bigram）切分
     * 例如: "你好世界" → ["你好", "好世", "界世界"] (only first two bigrams)
     * 实际上输出: ["你好", "好世", "世界"]
     */
    _splitCJKBigrams(text) {
        const result = [];
        for (let i = 0; i < text.length - 1; i++) {
            result.push(text.substring(i, i + 2));
        }
        return result;
    }
    findExact(term, fields) {
        const result = new Set();
        const fieldIndex = this.invertedIndex.get(term);
        if (!fieldIndex)
            return result;
        if (fields.length > 0) {
            for (const field of fields) {
                const docSet = fieldIndex.get(field);
                if (docSet) {
                    for (const docId of docSet) {
                        result.add(docId);
                    }
                }
            }
        }
        else {
            for (const [, docSet] of fieldIndex) {
                for (const docId of docSet) {
                    result.add(docId);
                }
            }
        }
        return result;
    }
    findFuzzy(term, threshold, fields) {
        const results = [];
        const seen = new Set();
        const termLower = term.toLowerCase();
        for (const [indexedTerm, fieldIndex] of this.invertedIndex) {
            const similarity = this.jaccardSimilarity(termLower, indexedTerm.toLowerCase());
            if (similarity >= threshold) {
                for (const [, docSet] of fieldIndex) {
                    for (const docId of docSet) {
                        if (!seen.has(docId)) {
                            seen.add(docId);
                            results.push({ docId, score: similarity });
                        }
                    }
                }
            }
        }
        return results;
    }
    getFieldWeights(docId, term, fields, weights) {
        const result = {};
        const doc = this.docs.get(docId);
        if (!doc)
            return result;
        const fieldIndex = this.invertedIndex.get(term);
        if (!fieldIndex)
            return result;
        const targetFields = fields.length > 0 ? fields : Object.keys(doc.fields);
        for (const field of targetFields) {
            const docSet = fieldIndex.get(field);
            if (docSet && docSet.has(docId)) {
                result[field] = weights[field] ?? this.options.fieldWeights[field] ?? this.options.defaultFieldWeight;
            }
        }
        return result;
    }
    /**
     * 获取字段权重乘数（用于 BM25）——取所有匹配字段中的最大权重
     */
    getFieldWeightMultiplier(docId, term, fields, weights) {
        const doc = this.docs.get(docId);
        if (!doc)
            return 1.0;
        const fieldIndex = this.invertedIndex.get(term);
        if (!fieldIndex)
            return 1.0;
        const targetFields = fields.length > 0 ? fields : Object.keys(doc.fields);
        let maxWeight = 0;
        for (const field of targetFields) {
            const docSet = fieldIndex.get(field);
            if (docSet && docSet.has(docId)) {
                const w = weights[field] ?? this.options.fieldWeights[field] ?? this.options.defaultFieldWeight;
                if (w > maxWeight)
                    maxWeight = w;
            }
        }
        return maxWeight > 0 ? maxWeight : 1.0;
    }
    /**
     * 获取文档中匹配 query token 的字段名列表
     */
    getMatchingFields(docId, term, fields) {
        const doc = this.docs.get(docId);
        if (!doc)
            return [];
        const fieldIndex = this.invertedIndex.get(term);
        if (!fieldIndex)
            return [];
        const targetFields = fields.length > 0 ? fields : Object.keys(doc.fields);
        const result = [];
        for (const field of targetFields) {
            const docSet = fieldIndex.get(field);
            if (docSet && docSet.has(docId)) {
                result.push(field);
            }
        }
        return result;
    }
    docHasTerm(docId, term) {
        const fieldIndex = this.invertedIndex.get(term);
        if (!fieldIndex)
            return false;
        for (const [, docSet] of fieldIndex) {
            if (docSet.has(docId))
                return true;
        }
        return false;
    }
    escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    levenshteinDistance(a, b) {
        const m = a.length;
        const n = b.length;
        const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
        for (let i = 0; i <= m; i++)
            dp[i][0] = i;
        for (let j = 0; j <= n; j++)
            dp[0][j] = j;
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                if (a[i - 1] === b[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1];
                }
                else {
                    dp[i][j] = Math.min(dp[i - 1][j - 1] + 1, dp[i - 1][j] + 1, dp[i][j - 1] + 1);
                }
            }
        }
        return dp[m][n];
    }
    jaccardSimilarity(a, b) {
        const setA = new Set(a);
        const setB = new Set(b);
        const intersection = new Set([...setA].filter(x => setB.has(x)));
        const union = new Set([...setA, ...setB]);
        return union.size === 0 ? 0 : intersection.size / union.size;
    }
    /**
     * 重新计算平均文档长度
     */
    _recomputeAvgDocLength() {
        if (this._docLengths.size === 0) {
            this._avgDocLength = 0;
            return;
        }
        let sum = 0;
        for (const len of this._docLengths.values()) {
            sum += len;
        }
        this._avgDocLength = sum / this._docLengths.size;
    }
    /**
     * 字段权重设置
     */
    setOptions(options) {
        if (options.defaultFieldWeight !== undefined) {
            this.options.defaultFieldWeight = options.defaultFieldWeight;
        }
        if (options.fieldWeights !== undefined) {
            Object.assign(this.options.fieldWeights, options.fieldWeights);
        }
        if (options.analyzer !== undefined) {
            this.options.analyzer = options.analyzer;
        }
    }
    /**
     * 获取索引中文档数量
     */
    count() {
        return this.docs.size;
    }
    // ──────────────────────────────────────────
    // 高级功能：召回评估 & 自动调优
    // ──────────────────────────────────────────
    /**
     * 评估召回率
     */
    evaluateRecall(testQueries) {
        let totalRelevant = 0;
        let totalRetrieved = 0;
        let totalRetrievedRelevant = 0;
        for (const { query, relevantDocIds } of testQueries) {
            const results = this.search(query, { limit: relevantDocIds.length });
            const retrievedIds = new Set(results.map(r => r.docId));
            const relevantSet = new Set(relevantDocIds);
            const retrievedRelevant = Array.from(retrievedIds).filter(id => relevantSet.has(id)).length;
            totalRelevant += relevantDocIds.length;
            totalRetrieved += results.length;
            totalRetrievedRelevant += retrievedRelevant;
        }
        const precision = totalRetrieved > 0 ? totalRetrievedRelevant / totalRetrieved : 0;
        const recall = totalRelevant > 0 ? totalRetrievedRelevant / totalRelevant : 0;
        const f1 = precision + recall > 0 ? 2 * (precision * recall) / (precision + recall) : 0;
        return { precision, recall, f1 };
    }
    /**
     * 自动调优——尝试多种权重组合找到最佳 F1 分数
     */
    autoTune(testQueries, fieldCandidates = {}, iterations = 5) {
        let bestF1 = 0;
        let bestWeights = { ...this.options.fieldWeights };
        const fields = Object.keys(this.options.fieldWeights);
        for (let iter = 0; iter < iterations; iter++) {
            const trialWeights = {};
            for (const field of fields) {
                const candidates = fieldCandidates[field] ?? [1.0, 2.0, 3.0, 0.5, 1.5, 2.5];
                trialWeights[field] = candidates[iter % candidates.length];
            }
            this.setOptions({ fieldWeights: trialWeights });
            const { f1 } = this.evaluateRecall(testQueries);
            if (f1 > bestF1) {
                bestF1 = f1;
                bestWeights = { ...trialWeights };
            }
        }
        this.setOptions({ fieldWeights: bestWeights });
        return { bestWeights, bestF1 };
    }
}
exports.FullTextIndex = FullTextIndex;
//# sourceMappingURL=fulltext.js.map