"use strict";
// ============================================================
// GraphImporter — 图数据导入器
// 支持 CSV / JSON / GraphSON / RDF 格式
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
exports.GraphImporter = void 0;
const fs = __importStar(require("fs"));
// ──────────────────────────────────────────
// GraphImporter 类
// ──────────────────────────────────────────
class GraphImporter {
    engine;
    constructor(engine) {
        this.engine = engine;
    }
    /**
     * 导入文件
     */
    async importFile(options) {
        const startTime = Date.now();
        const errors = [];
        let nodesImported = 0;
        let edgesImported = 0;
        try {
            switch (options.format) {
                case 'csv':
                    return this.importCSV(options);
                case 'json':
                    return this.importJSON(options);
                case 'graphson':
                    return this.importGraphSON(options);
                case 'rdf':
                    return this.importRDF(options);
                default:
                    throw new Error(`Unsupported format: ${options.format}`);
            }
        }
        catch (err) {
            errors.push(`Import failed: ${err.message}`);
        }
        return {
            nodesImported,
            edgesImported,
            errors,
            elapsedMs: Date.now() - startTime,
        };
    }
    // ──────────────────────────────────────────
    // CSV 导入
    // ──────────────────────────────────────────
    async importCSV(options) {
        const startTime = Date.now();
        const errors = [];
        let nodesImported = 0;
        let edgesImported = 0;
        const content = await fs.promises.readFile(options.filePath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim().length > 0);
        let startIdx = 0;
        if (options.skipHeader)
            startIdx = 1;
        for (let i = startIdx; i < lines.length; i++) {
            try {
                const cols = lines[i].split(options.delimiter ?? ',');
                if (cols.length < 2)
                    continue;
                const type = cols[0].trim().toLowerCase();
                if (type === 'node' || type === 'v') {
                    const nodeType = parseInt(cols[1], 10);
                    const name = cols[2]?.trim() ?? `node-${i}`;
                    const opts = {};
                    if (cols[3]?.trim()) {
                        try {
                            opts.props = JSON.parse(cols[3]);
                        }
                        catch { /* ignore bad props */ }
                    }
                    this.engine.upsertNode(nodeType, name, opts);
                    nodesImported++;
                }
                else if (type === 'edge' || type === 'e') {
                    const src = parseInt(cols[1], 10);
                    const dst = parseInt(cols[2], 10);
                    const edgeType = parseInt(cols[3], 10);
                    const opts = {};
                    if (cols[4]?.trim()) {
                        try {
                            opts.props = JSON.parse(cols[4]);
                        }
                        catch { /* ignore */ }
                    }
                    this.engine.upsertEdge(src, dst, edgeType, opts);
                    edgesImported++;
                }
            }
            catch (err) {
                errors.push(`Line ${i + 1}: ${err.message}`);
            }
        }
        return {
            nodesImported,
            edgesImported,
            errors: errors.slice(0, 100),
            elapsedMs: Date.now() - startTime,
        };
    }
    // ──────────────────────────────────────────
    // JSON 导入
    // ──────────────────────────────────────────
    async importJSON(options) {
        const startTime = Date.now();
        const errors = [];
        let nodesImported = 0;
        let edgesImported = 0;
        const content = await fs.promises.readFile(options.filePath, 'utf-8');
        const data = JSON.parse(content);
        const nodes = data.nodes ?? data.vertices ?? [];
        const edges = data.edges ?? [];
        // 导入节点
        for (const node of nodes) {
            try {
                const nodeType = node.type ?? node.typeId ?? options.nodeType ?? 1;
                const name = node.name ?? node.id?.toString() ?? `node-${nodesImported}`;
                const opts = {};
                if (node.props)
                    opts.props = node.props;
                this.engine.upsertNode(nodeType, name, opts);
                nodesImported++;
            }
            catch (err) {
                errors.push(`Node import: ${err.message}`);
            }
        }
        // 导入边
        for (const edge of edges) {
            try {
                const src = edge.src ?? edge.source ?? edge.from;
                const dst = edge.dst ?? edge.target ?? edge.to;
                const edgeType = edge.type ?? edge.label ?? options.edgeType ?? 1;
                const opts = {};
                if (edge.props)
                    opts.props = edge.props;
                this.engine.upsertEdge(src, dst, edgeType, opts);
                edgesImported++;
            }
            catch (err) {
                errors.push(`Edge import: ${err.message}`);
            }
        }
        return {
            nodesImported,
            edgesImported,
            errors: errors.slice(0, 100),
            elapsedMs: Date.now() - startTime,
        };
    }
    // ──────────────────────────────────────────
    // GraphSON 导入
    // ──────────────────────────────────────────
    async importGraphSON(options) {
        const startTime = Date.now();
        const errors = [];
        let nodesImported = 0;
        let edgesImported = 0;
        const content = await fs.promises.readFile(options.filePath, 'utf-8');
        const data = JSON.parse(content);
        const elements = [];
        if (Array.isArray(data)) {
            elements.push(...data);
        }
        else if (data.vertices || data.edges) {
            const vertices = (data.vertices ?? []).map((v) => ({
                ...v,
                type: 'vertex',
            }));
            const edgeList = (data.edges ?? []).map((e) => ({
                ...e,
                type: 'edge',
            }));
            elements.push(...vertices, ...edgeList);
        }
        for (const el of elements) {
            try {
                if (el.type === 'vertex') {
                    const nodeType = typeof el.label === 'number' ? el.label : 1;
                    const name = el.name ?? el.id?.toString() ?? `v-${nodesImported}`;
                    const opts = {};
                    if (el.properties) {
                        opts.props = {};
                        for (const [key, vals] of Object.entries(el.properties)) {
                            if (vals && vals.length > 0) {
                                opts.props[key] = String(vals[0].value);
                            }
                        }
                    }
                    this.engine.upsertNode(nodeType, name, opts);
                    nodesImported++;
                }
                else if (el.type === 'edge') {
                    const src = typeof el.outV === 'number' ? el.outV : parseInt(String(el.outV), 10);
                    const dst = typeof el.inV === 'number' ? el.inV : parseInt(String(el.inV), 10);
                    const edgeType = typeof el.label === 'number' ? el.label : 1;
                    this.engine.upsertEdge(src, dst, edgeType);
                    edgesImported++;
                }
            }
            catch (err) {
                errors.push(`GraphSON element: ${err.message}`);
            }
        }
        return {
            nodesImported,
            edgesImported,
            errors: errors.slice(0, 100),
            elapsedMs: Date.now() - startTime,
        };
    }
    // ──────────────────────────────────────────
    // RDF 导入
    // ──────────────────────────────────────────
    async importRDF(options) {
        const startTime = Date.now();
        const errors = [];
        let nodesImported = 0;
        let edgesImported = 0;
        const content = await fs.promises.readFile(options.filePath, 'utf-8');
        const triples = this.parseNTriples(content);
        const subjectNodes = new Map();
        const objectNodes = new Map();
        for (const triple of triples) {
            try {
                // Ensure subject node exists
                if (!subjectNodes.has(triple.subject)) {
                    this.engine.upsertNode(1, triple.subject);
                    const node = this.engine.getNode(nodesImported + 1); // approximate
                    subjectNodes.set(triple.subject, nodesImported + 1);
                    nodesImported++;
                }
                // Ensure object node exists (if not a literal)
                if (!triple.object.startsWith('"') && !objectNodes.has(triple.object)) {
                    this.engine.upsertNode(1, triple.object);
                    objectNodes.set(triple.object, nodesImported + 1);
                    nodesImported++;
                }
                // Create edge between subject and object (if both are nodes)
                if (!triple.object.startsWith('"') && !triple.object.startsWith('_:')) {
                    const srcId = subjectNodes.get(triple.subject);
                    const dstId = objectNodes.get(triple.object);
                    const edgeType = this.predicateToEdgeType(triple.predicate);
                    this.engine.upsertEdge(srcId, dstId, edgeType);
                    edgesImported++;
                }
            }
            catch (err) {
                errors.push(`Triple: ${err.message}`);
            }
        }
        return {
            nodesImported,
            edgesImported,
            errors: errors.slice(0, 100),
            elapsedMs: Date.now() - startTime,
        };
    }
    // ──────────────────────────────────────────
    // 解析辅助
    // ──────────────────────────────────────────
    parseNTriples(content) {
        const triples = [];
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#'))
                continue;
            // Simple N-Triples parser
            const parts = trimmed.split(/\s+/);
            if (parts.length >= 3) {
                const subject = parts[0].replace(/[<>]/g, '');
                const predicate = parts[1].replace(/[<>]/g, '');
                const object = parts[2].replace(/[<>]/g, '');
                triples.push({ subject, predicate, object });
            }
        }
        return triples;
    }
    predicateToEdgeType(predicate) {
        const known = {
            'http://www.w3.org/1999/02/22-rdf-syntax-ns#type': 10,
            'http://www.w3.org/2000/01/rdf-schema#label': 11,
            'http://www.w3.org/2000/01/rdf-schema#subClassOf': 12,
        };
        return known[predicate] ?? 100;
    }
}
exports.GraphImporter = GraphImporter;
//# sourceMappingURL=graph-import.js.map