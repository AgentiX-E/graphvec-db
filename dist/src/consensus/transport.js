"use strict";
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
exports.TcpTransport = exports.MockTransport = void 0;
const net = __importStar(require("node:net"));
const os = __importStar(require("node:os"));
const globalRegistry = new Map();
class MockTransport {
    nodeId;
    handler = null;
    _started = false;
    constructor(nodeId) {
        this.nodeId = nodeId || 'mock-transport';
    }
    setNodeId(id) {
        this.nodeId = id;
    }
    onMessage(handler) {
        this.handler = handler;
    }
    async start() {
        if (this._started)
            return;
        this._started = true;
        const entry = {
            onMessage: (from, msg) => {
                if (this.handler) {
                    this.handler(from, msg);
                }
            },
            pendingResponses: [],
        };
        globalRegistry.set(this.nodeId, entry);
    }
    async stop() {
        this._started = false;
        // Clean up any pending responses
        const entry = globalRegistry.get(this.nodeId);
        if (entry) {
            for (const p of entry.pendingResponses) {
                clearTimeout(p.timeout);
                p.reject(new Error('Transport stopped'));
            }
        }
        globalRegistry.delete(this.nodeId);
        this.handler = null;
    }
    /**
     * 发送响应消息到指定节点
     * 将响应投递给发起方节点注册的 pending response 回调
     */
    static sendResponse(to, from, msg) {
        setImmediate(() => {
            const entry = globalRegistry.get(to);
            if (!entry)
                return;
            // Check pending response handlers
            const pendingIdx = entry.pendingResponses.findIndex(p => p.from === from &&
                (p.from === msg.from || msg.from === from));
            if (pendingIdx >= 0) {
                const pending = entry.pendingResponses[pendingIdx];
                clearTimeout(pending.timeout);
                entry.pendingResponses.splice(pendingIdx, 1);
                pending.resolve(msg.data);
            }
            else {
                // If no pending handler, deliver as a normal message
                if (entry.onMessage) {
                    entry.onMessage(from, msg);
                }
            }
        });
    }
    /**
     * AppendEntries RPC
     */
    async appendEntries(to, req) {
        return this._sendInternal(to, req, 'AppendEntries', 'AppendEntriesResponse');
    }
    /**
     * RequestVote RPC
     */
    async requestVote(to, req) {
        return this._sendInternal(to, req, 'RequestVote', 'RequestVoteResponse');
    }
    /**
     * PreVote RPC
     */
    async preVote(to, req) {
        return this._sendInternal(to, req, 'PreVote', 'PreVoteResponse');
    }
    async installSnapshot(to, snapshot) {
        return { term: snapshot.term, success: true };
    }
    /**
     * 通用 RPC 发送
     */
    _sendInternal(to, data, requestType, responseType) {
        const responseFullType = responseType === 'AppendEntriesResponse'
            ? 'AppendEntriesResponse'
            : 'RequestVoteResponse';
        return new Promise((resolve, reject) => {
            // Register pending response
            const entry = globalRegistry.get(this.nodeId);
            if (!entry) {
                resolve(this._defaultResponse(responseFullType));
                return;
            }
            const timeout = setTimeout(() => {
                const idx = entry.pendingResponses.findIndex(p => p.from === to);
                if (idx >= 0) {
                    entry.pendingResponses.splice(idx, 1);
                    resolve(this._defaultResponse(responseFullType));
                }
            }, 5000);
            entry.pendingResponses.push({
                from: to,
                resolve,
                reject,
                timeout,
            });
            // Deliver request message
            const targetEntry = globalRegistry.get(to);
            if (targetEntry && targetEntry.onMessage) {
                setImmediate(() => {
                    targetEntry.onMessage(this.nodeId, {
                        type: requestType,
                        term: data.term,
                        from: this.nodeId,
                        to,
                        data,
                    });
                });
            }
            else {
                // Target not found, resolve with default
                const idx = entry.pendingResponses.findIndex(p => p.from === to);
                if (idx >= 0) {
                    clearTimeout(entry.pendingResponses[idx].timeout);
                    entry.pendingResponses.splice(idx, 1);
                    resolve(this._defaultResponse(responseFullType));
                }
            }
        });
    }
    _defaultResponse(type) {
        if (type === 'AppendEntriesResponse') {
            return { term: 0, success: false, lastLogIndex: 0 };
        }
        if (type === 'PreVoteResponse') {
            return { term: 0, voteGranted: false };
        }
        return { term: 0, voteGranted: false };
    }
    /** 获取已注册节点数量 */
    static get registeredCount() {
        return globalRegistry.size;
    }
    /** 获取指定节点的注册条目（导出给测试用） */
    static getRegistryEntry(nodeId) {
        return globalRegistry.get(nodeId);
    }
    /** 重置全局注册表 */
    static reset() {
        globalRegistry.clear();
    }
}
exports.MockTransport = MockTransport;
/** 全局 TCP 端口注册表（用于测试和集群管理等场景） */
const globalTcpPorts = new Map(); // nodeId → port
/**
 * TcpTransport — 生产环境 TCP 传输层
 *
 * 使用 Node.js 内置 `net` 模块，零外部依赖。
 * 消息协议：4-byte big-endian length prefix + UTF-8 JSON。
 */
class TcpTransport {
    nodeId;
    port;
    handler = null;
    server = null;
    connections = new Map();
    peerAddresses = new Map();
    listenAddress = '';
    constructor(nodeId, port) {
        this.nodeId = nodeId || `tcp-${process.pid}`;
        this.port = port ?? 0;
    }
    setNodeId(id) {
        this.nodeId = id;
    }
    setMessageHandler(handler) {
        this.handler = handler;
    }
    connectTo(peerAddress) {
        const parts = peerAddress.split(':');
        if (parts.length < 2)
            return false;
        let peerId;
        let host = '';
        let port = 0;
        if (parts.length >= 3) {
            peerId = parts[0];
            host = parts[1];
            port = parseInt(parts[2], 10);
        }
        else {
            host = parts[0];
            port = parseInt(parts[1], 10);
            peerId = `${host}:${port}`;
        }
        if (isNaN(port))
            return false;
        this.peerAddresses.set(peerId, `${host}:${port}`);
        this._connectToPeer(peerId, host, port, 1);
        return true;
    }
    sendTo(peerId, msg) {
        const socket = this.connections.get(peerId);
        if (!socket || socket.destroyed || !socket.writable) {
            const addr = this.peerAddresses.get(peerId);
            if (addr) {
                const [host, portStr] = addr.split(':');
                const p = parseInt(portStr, 10);
                if (!isNaN(p)) {
                    this._connectToPeer(peerId, host, p, 1);
                }
            }
            return false;
        }
        try {
            this._writeFrame(socket, msg);
            return true;
        }
        catch {
            return false;
        }
    }
    broadcast(msg) {
        for (const peerId of this.connections.keys()) {
            this.sendTo(peerId, msg);
        }
    }
    start() {
        if (this.server)
            return;
        this.server = net.createServer((socket) => {
            this._handleConnection(socket);
        });
        this.server.listen(this.port);
        const addr = this.server.address();
        if (addr && typeof addr === 'object') {
            this.port = addr.port;
        }
        this.listenAddress = `${this._getLocalIp()}:${this.port}`;
        globalTcpPorts.set(this.nodeId, this.port);
    }
    stop() {
        for (const [, socket] of this.connections) {
            socket.destroy();
        }
        this.connections.clear();
        this.peerAddresses.clear();
        if (this.server) {
            this.server.close();
            this.server = null;
        }
        globalTcpPorts.delete(this.nodeId);
    }
    static register(port) {
        process.env.TCP_TRANSPORT_PORT = String(port);
    }
    static reset() {
        globalTcpPorts.clear();
    }
    getPort() {
        return this.port;
    }
    getListenAddress() {
        return this.listenAddress;
    }
    _writeFrame(socket, msg) {
        const base64Data = Buffer.from(msg).toString('base64');
        const frame = { from: this.nodeId, data: base64Data, type: 'raft' };
        const json = JSON.stringify(frame);
        const jsonBuf = Buffer.from(json, 'utf-8');
        const header = Buffer.alloc(4);
        header.writeUInt32BE(jsonBuf.length, 0);
        socket.write(Buffer.concat([header, jsonBuf]));
    }
    _handleConnection(socket) {
        socket.setKeepAlive(true, 5000);
        let buffer = Buffer.alloc(0);
        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 4) {
                const frameLen = buffer.readUInt32BE(0);
                const totalLen = 4 + frameLen;
                if (buffer.length < totalLen)
                    break;
                const frameJson = buffer.subarray(4, totalLen).toString('utf-8');
                buffer = buffer.subarray(totalLen);
                try {
                    const frame = JSON.parse(frameJson);
                    if (frame.from && frame.data) {
                        this.handler?.(frame.from, Buffer.from(frame.data, 'base64'));
                    }
                }
                catch { /* ignore */ }
            }
        });
        socket.on('close', () => {
            for (const [peerId, s] of this.connections) {
                if (s === socket) {
                    this.connections.delete(peerId);
                    break;
                }
            }
        });
        socket.on('error', () => socket.destroy());
    }
    _connectToPeer(peerId, host, port, attempt) {
        if (this.connections.has(peerId))
            return;
        const socket = new net.Socket();
        const cleanup = () => { this.connections.delete(peerId); };
        socket.on('connect', () => {
            socket.setKeepAlive(true, 5000);
            this.connections.set(peerId, socket);
        });
        socket.on('close', cleanup);
        socket.on('error', () => { cleanup(); socket.destroy(); });
        const maxAttempts = 3;
        socket.connect(port, host, () => { this._handleConnection(socket); });
        socket.on('error', () => {
            if (attempt < maxAttempts) {
                const delay = Math.min(1000 * Math.pow(2, attempt - 1), 4000);
                setTimeout(() => this._connectToPeer(peerId, host, port, attempt + 1), delay);
            }
        });
    }
    _getLocalIp() {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            const ifaces = interfaces[name];
            if (!ifaces)
                continue;
            for (const iface of ifaces) {
                if (iface.family === 'IPv4' && !iface.internal)
                    return iface.address;
            }
        }
        return '127.0.0.1';
    }
}
exports.TcpTransport = TcpTransport;
//# sourceMappingURL=transport.js.map