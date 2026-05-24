/**
 * transport.ts — Transport 接口层
 *
 * 定义 Raft 协议核心 RPC 和传输抽象。
 * 实现可选用：内存 MockTransport（测试）、TCP、gRPC 等。
 */
import { LogEntry } from './wal';
export type RaftMessageType = 'AppendEntries' | 'RequestVote' | 'AppendEntriesResponse' | 'RequestVoteResponse' | 'InstallSnapshot' | 'InstallSnapshotResponse' | 'PreVote' | 'PreVoteResponse' | 'MembershipChange';
export interface RaftMessage {
    type: RaftMessageType;
    term: number;
    from: string;
    to: string;
    data: unknown;
}
export interface AppendEntriesRequest {
    term: number;
    leaderId: string;
    prevLogIndex: number;
    prevLogTerm: number;
    entries: LogEntry[];
    leaderCommit: number;
}
export interface AppendEntriesResponse {
    term: number;
    success: boolean;
    lastLogIndex: number;
    /** 如果 success=false，返回引起冲突的 term（Raft 论文 §5.3 优化） */
    conflictingTerm?: number;
    /** 如果 success=false，返回 conflictingTerm 的第一条 log index */
    conflictingIndex?: number;
}
export interface RequestVoteRequest {
    term: number;
    candidateId: string;
    lastLogIndex: number;
    lastLogTerm: number;
}
export interface RequestVoteResponse {
    term: number;
    voteGranted: boolean;
}
export interface InstallSnapshotRequest {
    term: number;
    leaderId: string;
    lastIncludedIndex: number;
    lastIncludedTerm: number;
    data: Uint8Array;
    done: boolean;
}
export interface InstallSnapshotResponse {
    term: number;
    success: boolean;
}
export interface Transport {
    /** 发送 AppendEntries RPC */
    appendEntries?(to: string, entries: AppendEntriesRequest): Promise<AppendEntriesResponse>;
    /** 发送 RequestVote RPC */
    requestVote?(to: string, req: RequestVoteRequest): Promise<RequestVoteResponse>;
    /** 发送 PreVote RPC */
    preVote?(to: string, req: RequestVoteRequest): Promise<RequestVoteResponse>;
    /** 发送 InstallSnapshot RPC */
    installSnapshot?(to: string, snapshot: InstallSnapshotRequest): Promise<InstallSnapshotResponse>;
    /** 启动传输层 */
    start(): Promise<void>;
    /** 停止传输层 */
    stop(): Promise<void>;
    /** 设置消息处理器 */
    onMessage(handler: (from: string, msg: RaftMessage) => void): void;
}
/**
 * MockTransport — 内存同步消息传递的 Transport 实现
 *
 * 请求-响应模式：
 *   1. 发起方调用 appendEntries(to, req)
 *   2. MockTransport 将 AppendEntries 消息投递给目标节点的 onMessage
 *   3. 目标节点 RaftCore 的 _handleMessage 处理请求
 *   4. RaftCore 调用 MockTransport.sendResponse 发送响应
 *   5. sendResponse 查找发起方节点注册的 pending response 回调并 resolve
 */
interface PendingResponse {
    from: string;
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timeout: NodeJS.Timeout;
}
interface NodeHandlers {
    onMessage?: (from: string, msg: RaftMessage) => void;
    pendingResponses: PendingResponse[];
}
export declare class MockTransport implements Transport {
    private nodeId;
    private handler;
    private _started;
    constructor(nodeId?: string);
    setNodeId(id: string): void;
    onMessage(handler: (from: string, msg: RaftMessage) => void): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    /**
     * 发送响应消息到指定节点
     * 将响应投递给发起方节点注册的 pending response 回调
     */
    static sendResponse(to: string, from: string, msg: RaftMessage): void;
    /**
     * AppendEntries RPC
     */
    appendEntries(to: string, req: AppendEntriesRequest): Promise<AppendEntriesResponse>;
    /**
     * RequestVote RPC
     */
    requestVote(to: string, req: RequestVoteRequest): Promise<RequestVoteResponse>;
    /**
     * PreVote RPC
     */
    preVote(to: string, req: RequestVoteRequest): Promise<RequestVoteResponse>;
    installSnapshot(to: string, snapshot: InstallSnapshotRequest): Promise<InstallSnapshotResponse>;
    /**
     * 通用 RPC 发送
     */
    private _sendInternal;
    private _defaultResponse;
    /** 获取已注册节点数量 */
    static get registeredCount(): number;
    /** 获取指定节点的注册条目（导出给测试用） */
    static getRegistryEntry(nodeId: string): NodeHandlers | undefined;
    /** 重置全局注册表 */
    static reset(): void;
}
/**
 * TcpTransport — 生产环境 TCP 传输层
 *
 * 使用 Node.js 内置 `net` 模块，零外部依赖。
 * 消息协议：4-byte big-endian length prefix + UTF-8 JSON。
 */
export declare class TcpTransport {
    private nodeId;
    private port;
    private handler;
    private server;
    private connections;
    private peerAddresses;
    private listenAddress;
    constructor(nodeId?: string, port?: number);
    setNodeId(id: string): void;
    setMessageHandler(handler: (from: string, msg: Uint8Array) => void): void;
    connectTo(peerAddress: string): boolean;
    sendTo(peerId: string, msg: Uint8Array): boolean;
    broadcast(msg: Uint8Array): void;
    start(): void;
    stop(): void;
    static register(port: number): void;
    static reset(): void;
    getPort(): number;
    getListenAddress(): string;
    private _writeFrame;
    private _handleConnection;
    private _connectToPeer;
    private _getLocalIp;
}
export {};
//# sourceMappingURL=transport.d.ts.map