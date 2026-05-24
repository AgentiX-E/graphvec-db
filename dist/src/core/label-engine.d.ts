import { NodeId } from '../types';
export interface LabelStats {
    types: number;
    totalNodes: number;
    typeCounts: Record<number, number>;
}
export declare class LabelEngine {
    private index;
    /** 添加节点到指定类型 */
    addNode(type: number, nodeId: NodeId): void;
    /** 从指定类型移除节点 */
    removeNode(type: number, nodeId: NodeId): boolean;
    /** 获取指定类型的所有节点 ID */
    getNodeIds(type: number): NodeId[];
    /** 获取统计数据 */
    stats(): LabelStats;
    /** 清理所有数据 */
    clear(): void;
    /** 重置到初始状态（同 clear） */
    reset(): void;
}
//# sourceMappingURL=label-engine.d.ts.map