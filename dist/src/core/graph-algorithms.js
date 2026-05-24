"use strict";
/**
 * GraphAlgorithms — 跨 Range 图算法模块
 *
 * 提供基于内存遍历的图算法实现，支持 PPR、双向 BFS、Union-Find 连通分量、Dijkstra。
 * crossRangeMode='fan-out' 时可通过 shardRouter 进行跨 Range 查询。
 *
 * 适用场景：
 * - 在单 Range 或跨 Range 模式下运行标准图算法
 * - 不依赖底层存储引擎的图算法
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GraphAlgorithms = void 0;
// ──────────────────────────────────────────
// MinHeap — 最小堆优先队列
// ──────────────────────────────────────────
class MinHeap {
    heap = [];
    size() {
        return this.heap.length;
    }
    push(node, dist) {
        this.heap.push({ node, dist });
        this._bubbleUp(this.heap.length - 1);
    }
    pop() {
        if (this.heap.length === 0)
            return undefined;
        const top = this.heap[0];
        const last = this.heap.pop();
        if (this.heap.length > 0) {
            this.heap[0] = last;
            this._sinkDown(0);
        }
        return top;
    }
    _bubbleUp(idx) {
        while (idx > 0) {
            const parent = (idx - 1) >> 1;
            if (this.heap[idx].dist >= this.heap[parent].dist)
                break;
            [this.heap[idx], this.heap[parent]] = [this.heap[parent], this.heap[idx]];
            idx = parent;
        }
    }
    _sinkDown(idx) {
        const size = this.heap.length;
        while (true) {
            let smallest = idx;
            const left = (idx << 1) + 1;
            const right = (idx << 1) + 2;
            if (left < size && this.heap[left].dist < this.heap[smallest].dist) {
                smallest = left;
            }
            if (right < size && this.heap[right].dist < this.heap[smallest].dist) {
                smallest = right;
            }
            if (smallest === idx)
                break;
            [this.heap[idx], this.heap[smallest]] = [this.heap[smallest], this.heap[idx]];
            idx = smallest;
        }
    }
}
// ──────────────────────────────────────────
// GraphAlgorithms 类
// ──────────────────────────────────────────
class GraphAlgorithms {
    engine;
    config;
    constructor(engine, config) {
        this.engine = engine;
        this.config = config;
    }
    // ──────────────────────────────────────────
    // 公共方法
    // ──────────────────────────────────────────
    /**
     * 个性化 PageRank — 从 sourceId 出发的 PPR 分数
     *
     * 使用幂迭代法计算 PPR。每次迭代收集当前可抵达的所有节点，
     * 按公式分配分数，直到收敛或达到最大迭代次数。
     *
     * @param sourceId 源节点 ID
     * @param alpha    随机游走中重置概率（默认 0.85）
     * @param topK     返回的 topK 结果数（默认 10）
     * @returns Map<nodeId, rankScore>
     * @remarks 当配置了 shardRouter 且 crossRangeMode='fan-out' 时，
     * 会通过 `_collectReachableCrossRange` 收集远程节点信息。
     * 但跨 Range 的 PPR 分数是近似值，因为幂迭代需要在所有节点间同步状态。
     * 精确的跨 Range PPR 需要后续迭代优化。
     */
    ppr(sourceId, alpha = 0.85, topK = 10) {
        const maxIter = this.config?.maxIterations ?? 100;
        const tolerance = this.config?.convergenceThreshold ?? 1e-6;
        // 使用跨 Range 收集（若配置了 fan-out 模式）
        const reachable = this._isCrossRangeEnabled()
            ? this._collectReachableCrossRange(sourceId)
            : this._collectReachable(sourceId);
        if (reachable.size === 0)
            return new Map();
        const N = reachable.size;
        const outDegree = new Map();
        // 计算每个节点的出度
        for (const nodeId of reachable) {
            const nb = this.engine.neighbors(nodeId);
            const deg = nb.filter(n => n.node !== null && reachable.has(n.node.id)).length;
            outDegree.set(nodeId, deg);
        }
        // 初始化 rank
        const rank = new Map();
        for (const nodeId of reachable) {
            rank.set(nodeId, 0);
        }
        rank.set(sourceId, 1);
        // 缓存邻居 — 邻居信息在迭代过程中不变化，只需提前计算一次
        const cachedNeighbors = new Map();
        for (const nodeId of reachable) {
            const nb = this.engine.neighbors(nodeId);
            cachedNeighbors.set(nodeId, nb.filter(n => n.node !== null && reachable.has(n.node.id)));
        }
        // 幂迭代
        for (let iter = 0; iter < maxIter; iter++) {
            const newRank = new Map();
            const base = (1 - alpha) / N;
            // 初始化新 rank 为 base
            for (const nodeId of reachable) {
                newRank.set(nodeId, base);
            }
            // 分配分数
            for (const u of reachable) {
                const ru = rank.get(u) ?? 0;
                const deg = outDegree.get(u) ?? 0;
                if (deg === 0)
                    continue;
                const contribution = (alpha * ru) / deg;
                const nb = cachedNeighbors.get(u) ?? [];
                for (const { node } of nb) {
                    if (node === null)
                        continue;
                    newRank.set(node.id, (newRank.get(node.id) ?? base) + contribution);
                }
            }
            // 检查收敛
            let diff = 0;
            for (const nodeId of reachable) {
                diff += Math.abs((newRank.get(nodeId) ?? 0) - (rank.get(nodeId) ?? 0));
            }
            for (const nodeId of reachable) {
                rank.set(nodeId, newRank.get(nodeId) ?? base);
            }
            if (diff < tolerance)
                break;
        }
        // 排序取 topK
        const sorted = [...rank.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, topK);
        return new Map(sorted);
    }
    /**
     * 双向 BFS 最短路径
     *
     * 同时从 source 和 target 出发展开搜索，每次扩展较小的 frontier，
     * 在相遇时重建完整路径。
     *
     * @param sourceId 起始节点 ID
     * @param targetId 目标节点 ID
     * @returns nodeId 数组（含两端），如不可达则返回 null
     * @remarks 当配置了 shardRouter 且 crossRangeMode='fan-out' 时，
     * 在本地 BFS 耗尽 frontier 后会 fan-out 收集远程节点的邻居。
     * 跨 Range 路径可能不是全局最优，因为远程 Range 返回的邻居信息
     * 受限于各 Range 的本地视图。
     */
    shortestPath(sourceId, targetId) {
        if (sourceId === targetId)
            return [sourceId];
        const sourceNode = this.engine.getNode(sourceId);
        const targetNode = this.engine.getNode(targetId);
        if (!sourceNode || !targetNode)
            return null;
        // 前向搜索（从 source 出发）
        const fParent = new Map();
        const fQueue = [sourceId];
        fParent.set(sourceId, sourceId);
        // 后向搜索（从 target 出发）
        const bParent = new Map();
        const bQueue = [targetId];
        bParent.set(targetId, targetId);
        // 相遇点
        let meetNode = null;
        const visited = new Set();
        while (fQueue.length > 0 && bQueue.length > 0) {
            // 扩展较小的 frontier
            if (fQueue.length <= bQueue.length) {
                meetNode = this._bfsExpand(fQueue, fParent, bParent, true, visited);
            }
            else {
                meetNode = this._bfsExpand(bQueue, bParent, fParent, false, visited);
            }
            if (meetNode !== null) {
                // 重建完整路径
                return this._reconstructPath(meetNode, fParent, bParent, sourceId, targetId);
            }
            // 跨 Range fan-out：当一方 frontier 耗尽时，尝试从引擎获取对侧 Range 的邻居
            if (this._isCrossRangeEnabled()) {
                if (fQueue.length === 0 && bQueue.length > 0) {
                    this._fanOutExpand(bQueue, fParent, bParent, fQueue, visited);
                }
                else if (bQueue.length === 0 && fQueue.length > 0) {
                    this._fanOutExpand(fQueue, bParent, fParent, bQueue, visited);
                }
                if (fQueue.length === 0 && bQueue.length === 0) {
                    break;
                }
            }
        }
        return null;
    }
    /**
     * 连通分量标记（Union-Find）
     *
     * 遍历所有节点与边，使用并查集合并同一连通分量中的节点。
     *
     * @returns Map<nodeId, componentRoot>
     */
    connectedComponents() {
        const parent = new Map();
        // Union-Find: 查找
        const find = (x) => {
            if (!parent.has(x)) {
                parent.set(x, x);
                return x;
            }
            if (parent.get(x) !== x) {
                parent.set(x, find(parent.get(x)));
            }
            return parent.get(x);
        };
        // Union-Find: 合并
        const union = (a, b) => {
            const ra = find(a);
            const rb = find(b);
            if (ra !== rb) {
                parent.set(rb, ra);
            }
        };
        // 收集所有可见节点
        let index = 0;
        while (true) {
            const node = this.engine.getNode(index);
            if (node === null)
                break;
            parent.set(node.id, node.id);
            index++;
        }
        if (index === 0)
            return new Map();
        // 对每个节点执行并查集
        for (const nodeId of parent.keys()) {
            const nb = this.engine.neighbors(nodeId);
            for (const { node } of nb) {
                if (node !== null) {
                    // 确保目标节点也在 parent 中
                    if (!parent.has(node.id)) {
                        parent.set(node.id, node.id);
                    }
                    union(nodeId, node.id);
                }
            }
        }
        // 路径压缩
        for (const nodeId of parent.keys()) {
            parent.set(nodeId, find(nodeId));
        }
        return new Map(parent);
    }
    /**
     * 单源最短路径（Dijkstra）
     *
     * 计算从 sourceId 到所有可达节点的最短路径距离。
     * 可选边权重字段。
     *
     * @param sourceId    源节点 ID
     * @param weightField 边属性中的权重字段名（可选，默认等权=1）
     * @returns Map<nodeId, { distance, path }>
     * @remarks 当配置了 shardRouter 且 crossRangeMode='fan-out' 时，
     * 会在本地松弛步骤结束后 fan-out 收集远程节点邻居信息，
     * 以支持跨 Range 最短路径发现。跨 Range 路径的构建受限于
     * 各 Range 的本地视图可见性。
     */
    dijkstra(sourceId, weightField) {
        const sourceNode = this.engine.getNode(sourceId);
        if (!sourceNode)
            return new Map();
        const distance = new Map();
        const previous = new Map();
        const settled = new Set();
        const pq = new MinHeap();
        distance.set(sourceId, 0);
        previous.set(sourceId, null);
        pq.push(sourceId, 0);
        // 跨 Range 模式：记录已被 fan-out 查询过的节点，避免重复
        const fanOutQueried = new Set();
        while (pq.size() > 0) {
            // 从优先队列中取出当前距离最小的节点
            const entry = pq.pop();
            if (entry === undefined)
                break;
            const { node: current, dist: curDist } = entry;
            // 如果该节点已被 settle，跳过（惰性删除）
            if (settled.has(current))
                continue;
            settled.add(current);
            // 如果取出的距离不是最新距离，跳过（惰性删除）
            if (curDist !== distance.get(current))
                continue;
            // 本地邻居遍历
            const nb = this.engine.neighbors(current);
            for (const { edge, node } of nb) {
                if (node === null)
                    continue;
                // 获取边权重
                let weight = 1;
                if (weightField) {
                    const props = edge.props;
                    if (props && typeof props[weightField] === 'number') {
                        weight = props[weightField];
                    }
                }
                const alt = curDist + weight;
                const existing = distance.get(node.id);
                if (existing === undefined || alt < existing) {
                    distance.set(node.id, alt);
                    previous.set(node.id, current);
                    // 惰性插入：直接 push 新距离，旧的条目会在 pop 时被跳过
                    pq.push(node.id, alt);
                }
            }
            // 跨 Range fan-out：当本地邻居遍历完后，若还有未探索的远程节点，尝试 fan-out
            if (this._isCrossRangeEnabled() && !fanOutQueried.has(current)) {
                fanOutQueried.add(current);
                // fan-out 要求引擎已经预加载了跨 Range 数据（由存储层负责）
                // 这里只是触发 shardRouter 调用（结果会反映在后续 engine.neighbors 中）
                const shardRouter = this.config.shardRouter;
                shardRouter.fanOut('neighbors', { nodeIds: [current] }).catch(() => {
                    // 异步 fan-out 失败不影响已完成的本地计算
                });
            }
            // 检查是否有未访问的远程节点需要扩展
            // （这些节点可能由外部 fan-out 回调或预加载机制注入到 engine 中）
            if (this._isCrossRangeEnabled() && pq.size() === 0) {
                // 从已知距离的节点中，尝试获取可能的新远程邻居
                for (const nodeId of distance.keys()) {
                    if (fanOutQueried.has(nodeId))
                        continue;
                    fanOutQueried.add(nodeId);
                    const rnb = this.engine.neighbors(nodeId);
                    for (const { node } of rnb) {
                        if (node !== null && !distance.has(node.id)) {
                            const alt = (distance.get(nodeId) ?? 0) + 1;
                            distance.set(node.id, alt);
                            previous.set(node.id, nodeId);
                            pq.push(node.id, alt);
                        }
                    }
                }
            }
        }
        // 重建路径
        const result = new Map();
        for (const nodeId of distance.keys()) {
            const path = this._buildPath(nodeId, previous);
            result.set(nodeId, {
                distance: distance.get(nodeId),
                path,
            });
        }
        return result;
    }
    // ──────────────────────────────────────────
    // 私有辅助方法
    // ──────────────────────────────────────────
    /** 检查是否启用了跨 Range fan-out 模式 */
    _isCrossRangeEnabled() {
        return this.config?.crossRangeMode === 'fan-out' && !!this.config?.shardRouter;
    }
    /**
     * 收集从给定节点出发可到达的所有节点（本地 BFS）
     */
    _collectReachable(sourceId) {
        const visited = new Set();
        // 如果源节点不存在，返回空集
        const sourceNode = this.engine.getNode(sourceId);
        if (!sourceNode)
            return visited;
        const queue = [sourceId];
        visited.add(sourceId);
        while (queue.length > 0) {
            const current = queue.shift();
            const nb = this.engine.neighbors(current);
            for (const { node } of nb) {
                if (node !== null && !visited.has(node.id)) {
                    visited.add(node.id);
                    queue.push(node.id);
                }
            }
        }
        return visited;
    }
    /**
     * 收集从给定节点出发可到达的所有节点（跨 Range 版本）
     *
     * 在本地 BFS 遍历完成后，通过 engine.neighbors() 再次扫描
     * 已发现的节点，以捕获通过存储层 bridge 注入的跨 Range 邻居。
     *
     * @remarks 跨 Range 节点收集是"尽力而为"的——依赖于存储层
     * 将远程邻居注入到 engine.neighbors() 返回值中。
     */
    _collectReachableCrossRange(sourceId) {
        const visited = new Set();
        // 如果源节点不存在，返回空集
        const sourceNode = this.engine.getNode(sourceId);
        if (!sourceNode)
            return visited;
        const queue = [sourceId];
        visited.add(sourceId);
        // 第一阶段：本地 BFS
        while (queue.length > 0) {
            const current = queue.shift();
            const nb = this.engine.neighbors(current);
            for (const { node } of nb) {
                if (node !== null && !visited.has(node.id)) {
                    visited.add(node.id);
                    queue.push(node.id);
                }
            }
        }
        // 第二阶段：触发跨 Range fan-out，使用返回结果扩展已发现节点集
        const localNodes = [...visited];
        const shardRouter = this.config.shardRouter;
        // 发起 fan-out 异步调用，结果由存储层注入 engine.neighbors
        shardRouter.fanOut('neighbors', { nodeIds: localNodes }).catch(() => {
            // 异步 fan-out 失败不影响后续的 engine.neighbors 扫描
        });
        // 第三阶段：再次扫描所有已发现的节点，捕获 fan-out 注入的远程邻居
        const frontier = new Set(visited); // 已经发现的节点
        for (const nodeId of localNodes) {
            const nb = this.engine.neighbors(nodeId);
            for (const { node } of nb) {
                if (node !== null && !visited.has(node.id)) {
                    visited.add(node.id);
                    frontier.add(node.id);
                }
            }
        }
        // 第四阶段：从新发现的远程节点递归探索其本地邻居（最多 2 层）
        let depth = 0;
        let currentFrontier = [...frontier].filter(id => !localNodes.includes(id));
        while (currentFrontier.length > 0 && depth < 2) {
            depth++;
            const nextFrontier = [];
            for (const nodeId of currentFrontier) {
                const nb = this.engine.neighbors(nodeId);
                for (const { node } of nb) {
                    if (node !== null && !visited.has(node.id)) {
                        visited.add(node.id);
                        nextFrontier.push(node.id);
                    }
                }
            }
            currentFrontier = nextFrontier;
        }
        return visited;
    }
    /**
     * BFS 单层扩展
     * @param queue   当前层队列
     * @param myParent 本方 parent 映射
     * @param otherParent 对方 parent 映射
     * @param isForward 是否为前向搜索
     * @param visited 全局已访问集合
     * @returns 相遇节点 ID，或 null
     */
    _bfsExpand(queue, myParent, otherParent, isForward, visited) {
        const levelSize = queue.length;
        for (let i = 0; i < levelSize; i++) {
            const current = queue.shift();
            const nb = this.engine.neighbors(current);
            for (const { node } of nb) {
                if (node === null)
                    continue;
                // 如果已被我方访问，跳过
                if (myParent.has(node.id))
                    continue;
                myParent.set(node.id, current);
                visited.add(node.id);
                // 检查是否被对方访问
                if (otherParent.has(node.id)) {
                    return node.id;
                }
                queue.push(node.id);
            }
        }
        return null;
    }
    /**
     * 跨 Range BFS 扩展
     *
     * 当一方 frontier 耗尽时，从对侧已发现的节点中取节点，
     * 通过 engine.neighbors() 获取其远程邻居（需存储层 bridge 注入），
     * 并将新节点注入到本方队列中。
     *
     * @param sourceQueue     本方的 frontier 队列（将被填充）
     * @param myParent        本方 parent 映射（将被写入）
     * @param otherParent     对方 parent 映射（用于相遇检测）
     * @param targetQueue     要填充的队列引用
     * @param visited         全局访问集合
     */
    _fanOutExpand(sourceQueue, myParent, otherParent, targetQueue, visited) {
        // 触发 shardRouter fan-out（存储层 bridge 会将结果注入 engine.neighbors）
        const shardRouter = this.config.shardRouter;
        shardRouter.fanOut('neighbors', { nodeIds: sourceQueue }).catch(() => {
            // 异步 fan-out 失败不影响后续的 engine.neighbors 扫描
        });
        // 从 sourceQueue 中的节点获取远程邻居
        const seen = new Set();
        for (const nodeId of sourceQueue) {
            if (seen.has(nodeId))
                continue;
            seen.add(nodeId);
            const nb = this.engine.neighbors(nodeId);
            for (const { node } of nb) {
                if (node === null)
                    continue;
                if (myParent.has(node.id))
                    continue;
                myParent.set(node.id, nodeId);
                visited.add(node.id);
                // 检查是否被对方访问
                if (otherParent.has(node.id)) {
                    // 相遇检测在外部 BFS 循环中处理
                    targetQueue.push(node.id);
                    return;
                }
                targetQueue.push(node.id);
            }
        }
    }
    /**
     * 重建双向 BFS 路径
     */
    _reconstructPath(meetNode, fParent, bParent, sourceId, targetId) {
        // 重建前半段（source → meet）
        const forwardPath = [];
        let current = meetNode;
        while (current !== sourceId) {
            forwardPath.unshift(current);
            const next = fParent.get(current);
            if (next === undefined || next === current)
                break;
            current = next;
        }
        forwardPath.unshift(sourceId);
        // 如果相遇点就是目标，完整路径已在 forwardPath 中
        if (meetNode === targetId) {
            return forwardPath;
        }
        // 重建后半段（meet → target），排除 meet 本身
        const backwardPath = [];
        let bCur = bParent.get(meetNode);
        if (bCur !== undefined && bCur !== meetNode) {
            while (bCur !== targetId) {
                if (bCur === undefined)
                    break;
                backwardPath.push(bCur);
                const next = bParent.get(bCur);
                if (next === undefined || next === bCur)
                    break;
                bCur = next;
            }
        }
        // 如果后半段没找到目标，说明 meet 和目标相同或相邻
        if (backwardPath.length === 0 || backwardPath[backwardPath.length - 1] !== targetId) {
            backwardPath.push(targetId);
        }
        return [...forwardPath, ...backwardPath];
    }
    /**
     * 重建 Dijkstra 路径
     */
    _buildPath(nodeId, previous) {
        const path = [];
        let current = nodeId;
        while (current !== null) {
            path.unshift(current);
            current = previous.get(current) ?? null;
        }
        return path;
    }
}
exports.GraphAlgorithms = GraphAlgorithms;
//# sourceMappingURL=graph-algorithms.js.map