"use strict";
// ============================================================
// CompositeIndex — 复合索引引擎
//
// 支持多字段复合索引，包括：
// - addRecord / removeRecord 维护索引记录
// - query 支持精确匹配、范围查询、前缀匹配
// - 跨字段复合查询（AND 逻辑）
// - indexName / clear 等方法
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.CompositeIndex = void 0;
class CompositeIndex {
    name;
    records = new Map();
    fieldIndex = new Map(); // field → value → record ids
    numericIndex = new Map(); // field → number value → record ids
    constructor(name) {
        this.name = name;
    }
    /** 添加记录到索引 */
    addRecord(record) {
        this.records.set(record.id, record);
        for (const [field, value] of Object.entries(record.fields)) {
            if (typeof value === 'number') {
                if (!this.numericIndex.has(field)) {
                    this.numericIndex.set(field, new Map());
                }
                const numMap = this.numericIndex.get(field);
                if (!numMap.has(value)) {
                    numMap.set(value, new Set());
                }
                numMap.get(value).add(record.id);
            }
            else {
                const strValue = String(value);
                if (!this.fieldIndex.has(field)) {
                    this.fieldIndex.set(field, new Map());
                }
                const strMap = this.fieldIndex.get(field);
                if (!strMap.has(strValue)) {
                    strMap.set(strValue, new Set());
                }
                strMap.get(strValue).add(record.id);
            }
        }
    }
    /** 从索引中移除记录 */
    removeRecord(recordId) {
        const record = this.records.get(recordId);
        if (!record)
            return false;
        for (const [field, value] of Object.entries(record.fields)) {
            if (typeof value === 'number') {
                const numMap = this.numericIndex.get(field);
                if (numMap) {
                    const set = numMap.get(value);
                    if (set) {
                        set.delete(recordId);
                        if (set.size === 0)
                            numMap.delete(value);
                    }
                    if (numMap.size === 0)
                        this.numericIndex.delete(field);
                }
            }
            else {
                const strValue = String(value);
                const strMap = this.fieldIndex.get(field);
                if (strMap) {
                    const set = strMap.get(strValue);
                    if (set) {
                        set.delete(recordId);
                        if (set.size === 0)
                            strMap.delete(strValue);
                    }
                    if (strMap.size === 0)
                        this.fieldIndex.delete(field);
                }
            }
        }
        this.records.delete(recordId);
        return true;
    }
    /** 精确查询 */
    queryExact(field, value) {
        if (typeof value === 'number') {
            const numMap = this.numericIndex.get(field);
            if (!numMap)
                return [];
            const set = numMap.get(value);
            return set ? Array.from(set) : [];
        }
        const strValue = String(value);
        const strMap = this.fieldIndex.get(field);
        if (!strMap)
            return [];
        const set = strMap.get(strValue);
        return set ? Array.from(set) : [];
    }
    /** 范围查询（仅支持数值） */
    queryRange(field, min, max) {
        const numMap = this.numericIndex.get(field);
        if (!numMap)
            return [];
        const result = new Set();
        for (const [numVal, ids] of numMap.entries()) {
            if (min !== undefined && numVal < min)
                continue;
            if (max !== undefined && numVal > max)
                continue;
            for (const id of ids) {
                result.add(id);
            }
        }
        return Array.from(result);
    }
    /** 前缀查询（仅支持字符串值） */
    queryPrefix(field, prefix) {
        const strMap = this.fieldIndex.get(field);
        if (!strMap)
            return [];
        const result = new Set();
        for (const [strVal, ids] of strMap.entries()) {
            if (strVal.startsWith(prefix)) {
                for (const id of ids) {
                    result.add(id);
                }
            }
        }
        return Array.from(result);
    }
    /** 通用查询（支持精确/范围/前缀条件，多个条件 AND 合并） */
    query(conditions) {
        if (conditions.length === 0) {
            return Array.from(this.records.keys());
        }
        let result = null;
        for (const condition of conditions) {
            let ids = [];
            switch (condition.operator) {
                case 'eq':
                    ids = this.queryExact(condition.field, condition.value);
                    break;
                case 'gt':
                    {
                        const val = Number(condition.value);
                        ids = this.queryRange(condition.field, val + 1);
                    }
                    break;
                case 'gte':
                    {
                        const val = Number(condition.value);
                        ids = this.queryRange(condition.field, val);
                    }
                    break;
                case 'lt':
                    {
                        const val = Number(condition.value);
                        ids = this.queryRange(condition.field, undefined, val - 1);
                    }
                    break;
                case 'lte':
                    {
                        const val = Number(condition.value);
                        ids = this.queryRange(condition.field, undefined, val);
                    }
                    break;
                case 'prefix':
                    ids = this.queryPrefix(condition.field, String(condition.value));
                    break;
            }
            const resultSet = new Set(ids);
            if (result === null) {
                result = ids;
            }
            else {
                result = result.filter(id => resultSet.has(id));
            }
        }
        return result ?? [];
    }
    /** 获取索引名称 */
    indexName() {
        return this.name;
    }
    /** 清空索引 */
    clear() {
        this.records.clear();
        this.fieldIndex.clear();
        this.numericIndex.clear();
    }
    /** 获取统计信息 */
    stats() {
        const fieldKeys = new Set();
        for (const [, record] of this.records) {
            for (const key of Object.keys(record.fields)) {
                fieldKeys.add(key);
            }
        }
        return {
            name: this.name,
            recordCount: this.records.size,
            fieldKeys: Array.from(fieldKeys),
        };
    }
    /** 获取记录数 */
    get size() {
        return this.records.size;
    }
}
exports.CompositeIndex = CompositeIndex;
//# sourceMappingURL=composite-index.js.map