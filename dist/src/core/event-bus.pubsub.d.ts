/**
 * Distributed EventBus — ZeroMQ PUB/SUB 分布式事件总线
 *
 * 架构:
 *   GraphEngine emit() → EventBus → Local EventEmitter (本进程即刻响应)
 *                                  → ZeroMQ PUB socket (跨节点广播)
 *   ZeroMQ SUB socket → 接收远程事件 → Local EventEmitter (本地订阅者)
 *
 * 安全:
 *   CURVE (Curve25519) 双向认证 + 传输加密。
 *   支持 NAS 共享目录自动分发公钥：每个节点启动时将自身公钥写入 NAS 目录
 *   （文件名 = hostname），并从该目录读取其他节点的公钥。
 *
 * Raft 集群内防重复:
 *   Raft leader 节点上的事件不通过 ZeroMQ 发布/订阅（因为 Raft 日志复制
 *   已经保证所有节点最终一致）。非 Raft 节点通过 ZeroMQ 获取事件。
 */
export type GraphEventType = 'node:created' | 'node:updated' | 'node:deleted' | 'edge:created' | 'edge:updated' | 'edge:deleted' | 'backup:start' | 'backup:complete' | 'graph:cleared' | 'cluster:node-joined' | 'cluster:node-left' | 'cluster:leader-changed' | 'event:ack' | 'event:sync' | 'event:sync-batch' | 'system:shutdown';
export interface GraphEvent {
    type: GraphEventType;
    nodeId: string;
    timestamp: number;
    data: Record<string, unknown>;
}
/**
 * CURVE 密钥存储模式
 *
 * - `'explicit'`: 在配置中直接传入密钥字符串
 * - `'nas'`: 通过 NAS 共享目录自动管理公钥
 */
export type CurveKeyMode = 'explicit' | 'nas';
/**
 * CURVE 安全配置（explicit 模式）
 */
export interface CurveExplicitConfig {
    mode: 'explicit';
    server: boolean;
    secretKey: string;
    publicKey: string;
    peerKeys?: Record<string, string>;
}
/**
 * CURVE 安全配置（NAS 共享目录模式）
 *
 * 文件名格式：`{nodeId}_{port}.pub`，内容 = 一行 CURVE 公钥。
 * 每个进程启动时写入自己的文件，扫描目录中所有 `*.pub` 文件自动发现 peer。
 *
 * NAS 目录路径优先使用 `EVENTBUS_CURVE_DIR` 环境变量，未设置时回退到 `publicKeyDir`。
 */
export interface CurveNasConfig {
    mode: 'nas';
    /** 本节点 ID（唯一标识） */
    nodeId: string;
    /** 本节点 ZeroMQ PUB 监听端口 */
    port: number;
    /** 是否作为 CURVE server（PUB 端），PUB/SERVER=true，SUB/SERVER=false */
    server: boolean;
    /** NAS 共享公钥目录路径（回退值，`EVENTBUS_CURVE_DIR` 环境变量优先） */
    publicKeyDir: string;
    /**
     * NAS 目录中的公钥文件名 = `{nodeId}_{port}.pub`。
     * 当 subscribeAddress 使用 IP 而非 nodeId 时，
     * 可以通过此映射指定 IP → nodeId 的对应关系，
     * 以便 event-bus 能正确查找对应的 peer 公钥。
     *
     * 例如：`{ "10.0.0.1": "node-a", "node-a": "node-a" }`
     */
    addressHostMap?: Record<string, string>;
}
/**
 * CURVE 安全配置
 */
export type CurveConfig = CurveExplicitConfig | CurveNasConfig;
/**
 * 传输安全配置
 */
export interface EventBusSecurity {
    curve: CurveConfig;
}
/**
 * NAS 目录扫描结果：描述一个 peer 节点如何连接
 */
export interface PeerDescriptor {
    nodeId: string;
    port: number;
    address: string;
    publicKey: string;
}
export interface EventBusConfig {
    /** 本节点 ID（唯一标识） */
    nodeId: string;
    /** ZeroMQ PUB socket 监听地址（null = 不启动 PUB） */
    publishAddress?: string | null;
    /** 远程 SUB 连接地址列表（可多个节点地址） */
    subscribeAddresses?: string[];
    /** 本节点 ZeroMQ PUB 监听端口（NAS 模式时需要） */
    port?: number;
    /** 是否处于 Raft leader 角色（leader 不通过 ZMQ 收发事件） */
    isRaftLeader?: boolean;
    /** CURVE 安全配置 */
    security?: EventBusSecurity;
}
export declare class EventBus {
    private local;
    private config;
    private pubSocket;
    /** 每个远程节点一个独立的 SUB socket，方便每个连接独立设置 CURVE serverKey */
    private subSockets;
    /** 每个 SUB socket 对应的 subscribe address */
    private subAddrs;
    private running;
    /** NAS 目录路径（NAS 模式转换后会保留，供 watcher 使用） */
    private nasKeyDir;
    /** NAS 目录文件监视器（公钥变更热更） */
    private keyWatcher;
    constructor(config: EventBusConfig);
    /**
     * 生成一对 CURVE 密钥
     * 每个节点应生成自己独立的一对密钥并持久化保存
     */
    static generateCurveKeys(): {
        publicKey: string;
        secretKey: string;
    };
    /**
     * 将本机公钥写入 NAS 共享目录
     * 文件名 = `{nodeId}_{port}.pub`，内容 = 一行公钥
     *
     * @param dir       - NAS 共享目录路径
     * @param nodeId    - 本节点 ID
     * @param port      - 本节点 ZeroMQ PUB 端口
     * @param publicKey - 本机 CURVE 公钥
     */
    static writePublicKeyToDir(dir: string, nodeId: string, port: number, publicKey: string): void;
    /**
     * 扫描 NAS 目录中所有 `{nodeId}_{port}.pub` 文件，读出所有 peer 的公钥和地址。
     * 自动从文件名推导每个 peer 的 ZMQ 地址 `tcp://<host>:<port>`。
     *
     * @param dir - NAS 共享目录路径
     * @returns 节点描述数组（含 nodeId、address、publicKey）
     */
    static readAllPeerKeys(dir: string): PeerDescriptor[];
    /**
     * NAS 模式解析：自动生成本机密钥对并写入 NAS 公钥目录，
     * 读取所有 peer 的公钥重试等待（处理多节点同时启动的时序问题）
     *
     * @param security - EventBusSecurity（必须包含 curve.mode === 'nas'）
     * @returns 解析后的 CurveExplicitConfig + 自动发现的 peer 地址列表
     */
    static resolveCurveConfig(security: EventBusSecurity): Promise<{
        explicitConfig: CurveExplicitConfig;
        peerAddresses: string[];
    }>;
    /**
     * 写入本机公钥后，重试读取 peer 公钥。
     *
     * 处理多节点同时启动的竞态：写入 self.pub 后，如果其他节点尚未写
     * 入它们的 .pub 文件，会以 200ms 间隔轮询，最大等待 10 秒。
     *
     * @param dir         - NAS 目录
     * @param selfNodeId  - 本节点 ID（用于排除自己；不传则不过滤）
     * @param minPeers    - 最少需要发现的 peer 数量（默认 1）
     * @returns peer 描述数组
     */
    static waitForPeerKeys(dir: string, selfNodeId?: string, minPeers?: number): Promise<PeerDescriptor[]>;
    /**
     * 启动 EventBus，初始化 ZeroMQ PUB/SUB 连接
     *
     * 如果配置了 NAS 模式的安全，会在启动前自动执行公钥分发与读取。
     */
    start(): Promise<void>;
    /**
     * 将 CURVE 安全配置应用到 PUB socket
     */
    private _applyCurveToPublisher;
    /**
     * 将 CURVE 安全配置应用到 SUB socket。
     * 每个 SUB 只连接一个 target，根据 addr 解析对应的 server 公钥。
     * SUB socket 始终以 client 身份连接对方的 PUB server。
     *
     * NAS 模式下，peerKeys 的 key 同时包含 nodeId 和 address，
     * 确保无论用哪种 key 查找都能命中。
     */
    private _applyCurveToSubscriber;
    /**
     * 停止 EventBus，关闭所有 ZeroMQ socket 并清理本地监听器
     */
    stop(): Promise<void>;
    /**
     * 重建第 i 个 SUB socket。
     *
     * 在重连前，如果 nasKeyDir 存在，会从 NAS 目录重新读取 target hostname
     * 对应的最新公钥并更新 peerKeys 缓存，确保 CURVE 握手用最新密钥。
     *
     * @param i - subSockets / subAddrs 中的索引
     * @param retries - 重试次数（默认 4）
     */
    /** 每个 sub socket 最近一次重建的时间戳（ms），防止同一个 socket 重复重建 */
    private subLastReconnect;
    private _reconnectSub;
    /**
     * 发布一个事件
     */
    emit(event: Omit<GraphEvent, 'nodeId'>): void;
    on(type: GraphEventType, handler: (event: GraphEvent) => void): void;
    off(type: GraphEventType, handler: (event: GraphEvent) => void): void;
    clear(): void;
    /**
     * NAS 模式：启动公钥目录文件监听。
     *
     * 当任意 `*.pub` 文件变更时（某个节点重启并更新了公钥），
     * 检查是否是我连接的 peer 发生了变更。如果是，关闭原 SUB socket
     * 并用新公钥重新连接。
     */
    private _startKeyWatch;
    /**
     * 为单个 SUB socket 启动事件轮询。
     *
     * 当 receive() 抛出异常（连接断开、对端关闭等），自动触发重连。
     * 重连前会从 NAS 目录重新读取最新公钥，确保 CURVE 握手用最新密钥。
     *
     * @param sub - SUB socket
     * @param idx - subSockets 中的索引（用于 _reconnectSub）
     */
    private _startSubLoop;
}
/**
 * 初始化全局 EventBus（应在应用启动时调用）
 */
export declare function initEventBus(config: EventBusConfig): Promise<EventBus>;
/**
 * 获取全局 EventBus 实例
 */
export declare function getEventBus(): EventBus;
/**
 * 旧版全局单例（兼容之前无参数调用的代码）
 */
export declare const globalEventBus: EventBus;
//# sourceMappingURL=event-bus.pubsub.d.ts.map