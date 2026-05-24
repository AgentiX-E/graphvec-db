import { GraphEngine } from '../core/graph-engine';
export type ImportFormat = 'csv' | 'json' | 'graphson' | 'rdf';
export interface ImportOptions {
    format: ImportFormat;
    filePath: string;
    batchSize?: number;
    nodeType?: number;
    edgeType?: number;
    skipHeader?: boolean;
    delimiter?: string;
    onProgress?: (progress: {
        imported: number;
        total: number;
        errors: number;
    }) => void;
}
export interface ImportResult {
    nodesImported: number;
    edgesImported: number;
    errors: string[];
    elapsedMs: number;
}
export interface GraphSONElement {
    id: string | number;
    label?: string;
    type: 'vertex' | 'edge';
    properties?: Record<string, {
        value: unknown;
    }[]>;
    inVLabel?: string;
    outVLabel?: string;
    inV?: string | number;
    outV?: string | number;
}
export interface RDFTriple {
    subject: string;
    predicate: string;
    object: string;
}
export declare class GraphImporter {
    private engine;
    constructor(engine: GraphEngine);
    /**
     * 导入文件
     */
    importFile(options: ImportOptions): Promise<ImportResult>;
    private importCSV;
    private importJSON;
    private importGraphSON;
    private importRDF;
    private parseNTriples;
    private predicateToEdgeType;
}
//# sourceMappingURL=graph-import.d.ts.map