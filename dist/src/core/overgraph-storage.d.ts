import { StorageProvider, StorageConfig, StorageStats, NeighborsOptions, NeighborEntry } from './storage-provider';
import { NodeId, UpsertNodeOptions } from '../types';
export declare class OverGraphStorage implements StorageProvider {
    private _db;
    private _isOpen;
    get isOpen(): boolean;
    open(config: StorageConfig): void;
    close(): void;
    upsertNode(typeId: number, name: string, opts?: UpsertNodeOptions): NodeId;
    getNode(id: NodeId, includeProps: boolean): {
        id: NodeId;
        typeId: number;
        key: string;
        props?: Record<string, unknown>;
        createdAt: number;
    } | null;
    deleteNode(id: NodeId): boolean;
    batchUpsertNodes(inputs: Array<{
        typeId: number;
        name: string;
        key: string;
        props?: Record<string, unknown>;
        denseVector?: Float32Array;
        temporalValidity?: {
            start?: number;
            end?: number;
        };
    }>): NodeId[];
    degrees(id: NodeId): {
        inDegree: number;
        outDegree: number;
    };
    upsertEdge(src: NodeId, dst: NodeId, typeId: number, opts?: {
        props?: Record<string, unknown>;
        temporalValidity?: {
            start?: number;
            end?: number;
        };
        weight?: number;
    }): void;
    getEdge(src: NodeId, dst: NodeId, typeId: number): {
        from: NodeId;
        to: NodeId;
        typeId: number;
        props?: Record<string, unknown>;
        createdAt: number;
    } | null;
    deleteEdge(src: NodeId, dst: NodeId, typeId: number): boolean;
    neighbors(id: NodeId, opts?: NeighborsOptions): NeighborEntry[];
    vectorSearch(searchQuery: string): Array<{
        id: NodeId;
        score: number;
        distance: number;
    }>;
    personalizedPageRank(opts: {
        sourceNode: NodeId;
        maxIter: number;
        alpha: number;
        tolerance: number;
        topK: number;
    }): {
        nodeId: NodeId;
        score: number;
    }[];
    allShortestPaths(opts: {
        source: NodeId;
        target: NodeId;
        maxDepth: number;
    }): {
        path: NodeId[];
        cost: number;
    }[];
    connectedComponents(opts?: {
        edgeTypeFilter?: number[];
    }): NodeId[][];
    queryPattern(opts: {
        sourceNodeId?: NodeId;
        sourceTypeId?: number;
        depth: number;
        edgeTypeFilter?: number[][];
        nodeTypeFilter?: number[][];
        limit: number;
    }): Array<{
        id: NodeId;
        typeId: number;
        key: string;
        props?: Record<string, unknown>;
        createdAt: number;
    }>;
    compact(): void;
    stats(): StorageStats;
    exportSnapshot(): Buffer;
    importSnapshot(data: Buffer): void;
}
//# sourceMappingURL=overgraph-storage.d.ts.map