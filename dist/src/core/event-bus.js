"use strict";
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
exports.globalEventBus = exports.EventBus = void 0;
exports.initEventBus = initEventBus;
exports.getEventBus = getEventBus;
const node_events_1 = require("node:events");
const zmq = __importStar(require("zeromq"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
// ──────────────────────────────────────────
// 辅助：获取本机 hostname
// ──────────────────────────────────────────
function getHostname() {
    return os.hostname();
}
/**
 * 根据 hostname 构建 CURVE 公钥文件名
 */
function publicKeyFileForHostname(hostname) {
    return `${hostname}.pub`;
}
/**
 * 从 NAS 目录读取指定 hostname 的公钥
 *
 * @param dir  - NAS 共享目录
 * @param host - 目标节点 hostname
 * @returns 公钥字符串，或 null 如果文件不存在
 */
function readPeerPublicKey(dir, host) {
    const filePath = path.join(dir, publicKeyFileForHostname(host));
    try {
        const key = fs.readFileSync(filePath, 'utf-8').trim();
        return key.length > 0 ? key : null;
    }
    catch {
        return null;
    }
}
// ──────────────────────────────────────────
// EventBus 类
// ──────────────────────────────────────────
class EventBus {
    local = new node_events_1.EventEmitter();
    config;
    pubSocket = null;
    /** 每个远程节点一个独立的 SUB socket，方便每个连接独立设置 CURVE serverKey */
    subSockets = [];
    /** 每个 SUB socket 对应的 subscribe address */
    subAddrs = [];
    running = false;
    /** NAS 目录路径（NAS 模式转换后会保留，供 watcher 使用） */
    nasKeyDir = null;
    /** NAS 目录文件监视器（公钥变更热更） */
    keyWatcher = null;
    constructor(config) {
        this.config = {
            ...config,
            publishAddress: config.publishAddress ?? null,
            subscribeAddresses: config.subscribeAddresses ?? [],
            isRaftLeader: config.isRaftLeader ?? false,
        };
    }
    // ── CURVE 密钥生成与磁盘管理 ─────────
    /**
     * 生成一对 CURVE 密钥
     * 每个节点应生成自己独立的一对密钥并持久化保存
     */
    static generateCurveKeys() {
        return zmq.curveKeyPair();
    }
    /**
     * 将本机公钥写入 NAS 共享目录
     * 文件名 = `{hostname}.pub`，内容 = 一行公钥
     *
     * @param dir  - NAS 共享目录路径
     * @param publicKey - 本机 CURVE 公钥
     */
    static writePublicKeyToDir(dir, publicKey) {
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, publicKeyFileForHostname(getHostname()));
        fs.writeFileSync(filePath, publicKey, 'utf-8');
    }
    /**
     * 从 NAS 共享目录构建 peerKeys 映射
     * 遍历目录中所有 `*.pub` 文件，以文件名前缀（hostname）为 key
     *
     * @param dir - NAS 共享目录路径
     * @returns hostname → publicKey 的映射
     */
    static readAllPeerKeys(dir) {
        const result = {};
        let entries;
        try {
            entries = fs.readdirSync(dir);
        }
        catch {
            return result;
        }
        const suffix = '.pub';
        for (const entry of entries) {
            if (!entry.endsWith(suffix))
                continue;
            const host = entry.slice(0, -suffix.length);
            const key = readPeerPublicKey(dir, host);
            if (key)
                result[host] = key;
        }
        return result;
    }
    /**
     * NAS 模式解析：自动生成本机密钥对并写入 NAS 公钥目录，
     * 读取所有 peer 的公钥重试等待（处理多节点同时启动的时序问题）
     *
     * @param security - EventBusSecurity（必须包含 curve.mode === 'nas'）
     * @returns 解析后的 CurveExplicitConfig
     */
    static async resolveCurveConfig(security) {
        const curve = security.curve;
        // 1. 生成本机 CURVE 密钥对
        const { publicKey, secretKey } = EventBus.generateCurveKeys();
        // 2. 将本机公钥写入 NAS 目录
        EventBus.writePublicKeyToDir(curve.publicKeyDir, publicKey);
        // 3. 读取所有 peer 的公钥，重试等待缺失的文件
        const allPeers = await EventBus.waitForPeerKeys(curve.publicKeyDir, curve.server);
        // 4. 转换 peerKeys：如果提供了 addressHostMap，用地址 key 替换 hostname key
        //    这样 _applyCurveToSubscriber 在解析 subscribe address 时能直接命中
        let peerKeys;
        const map = curve.addressHostMap;
        if (map && Object.keys(map).length > 0) {
            peerKeys = {};
            for (const [addr, host] of Object.entries(map)) {
                if (allPeers[host]) {
                    peerKeys[addr] = allPeers[host];
                }
            }
            // 补充未被映射的 hostname
            for (const [host, key] of Object.entries(allPeers)) {
                if (!peerKeys[host]) {
                    peerKeys[host] = key;
                }
            }
        }
        else {
            peerKeys = allPeers;
        }
        return {
            mode: 'explicit',
            server: curve.server,
            secretKey,
            publicKey,
            peerKeys,
        };
    }
    /**
     * 写入本机公钥后，重试读取 peer 公钥。
     *
     * 处理多节点同时启动的竞态：写入 self.pub 后，如果其他节点尚未写
     * 入它们的 .pub 文件，会以 200ms 间隔轮询，最大等待 5 秒。
     *
     * 非 server 节点（SUB-only）会等待至少检到 server 的公钥。
     *
     * @param dir        - NAS 目录
     * @param isServer   - 当前节点是否 server
     * @returns hostname → publicKey 的映射
     */
    static async waitForPeerKeys(dir, isServer) {
        const start = Date.now();
        const deadline = start + 5000;
        const hostname = getHostname();
        let lastKeys = {};
        while (Date.now() < deadline) {
            try {
                lastKeys = EventBus.readAllPeerKeys(dir);
            }
            catch {
                // 目录可能尚未完全就绪
            }
            // 删除自己
            const keys = { ...lastKeys };
            delete keys[hostname];
            if (!isServer) {
                // SUB-only 节点：至少需要一个 server 的公钥才能连接
                if (Object.keys(keys).length > 0)
                    return keys;
            }
            else if (isServer) {
                // PUB node：如果有任何 peer 即可返回，没有也能工作（只绑定不连接）
                if (Object.keys(keys).length > 0)
                    return keys;
            }
            // 还没发现任何 peer → 等一会再试
            try {
                // 使用同步 sleep 避免引入额外的状态管理
                await new Promise(r => setTimeout(r, 200));
            }
            catch {
                // SharedArrayBuffer 可能受限，改用 busy-poll
                const t = Date.now() + 200;
                while (Date.now() < t) { /* yield */ }
            }
        }
        return lastKeys;
    }
    // ── 生命周期 ─────────────────────────
    /**
     * 启动 EventBus，初始化 ZeroMQ PUB/SUB 连接
     *
     * 如果配置了 NAS 模式的安全，会在启动前自动执行公钥分发与读取。
     */
    async start() {
        if (this.running)
            return;
        this.running = true;
        // CURVE 是强制安全机制：有 PUB 或 SUB 连接时必须配置 security
        const hasPubSub = (!this.config.isRaftLeader && this.config.publishAddress) ||
            (this.config.subscribeAddresses.length > 0);
        if (hasPubSub && !this.config.security?.curve) {
            throw new Error('EventBus: CURVE security is required when using PUB or SUB. ' +
                'Provide a `security.curve` config, or use `initEventBus()` with proper keys.');
        }
        // NAS 模式：自动生成密钥对 + 公钥分发
        if (this.config.security?.curve?.mode === 'nas') {
            this.nasKeyDir = this.config.security.curve.publicKeyDir;
            const resolved = await EventBus.resolveCurveConfig(this.config.security);
            this.config = { ...this.config, security: { curve: resolved } };
        }
        // 非 leader 时启动 PUB
        if (!this.config.isRaftLeader && this.config.publishAddress) {
            this.pubSocket = new zmq.Publisher();
            this._applyCurveToPublisher(this.pubSocket);
            await this.pubSocket.bind(this.config.publishAddress);
            console.log(`EventBus PUB bound to ${this.config.publishAddress}`);
        }
        // 启动 SUB — 每个远程地址一个独立的 SUB socket
        // 这样每个连接都可以独立设置 CURVE serverKey（因为每个 PUB 节点各有不同公钥）
        if (this.config.subscribeAddresses.length > 0) {
            for (const addr of this.config.subscribeAddresses) {
                const sub = new zmq.Subscriber();
                this._applyCurveToSubscriber(sub, addr);
                await sub.connect(addr);
                // 订阅所有事件
                sub.subscribe(Buffer.alloc(0));
                this.subSockets.push(sub);
                this.subAddrs.push(addr);
                this._startSubLoop(sub, this.subAddrs.length - 1);
                console.log(`EventBus SUB connected to ${addr}`);
            }
        }
        // NAS 模式：启动公钥目录监听，热更 peer 公钥变更
        this._startKeyWatch();
    }
    /**
     * 将 CURVE 安全配置应用到 PUB socket
     */
    _applyCurveToPublisher(socket) {
        const curve = this.config.security?.curve;
        if (!curve)
            return;
        if (curve.mode === 'explicit') {
            const s = socket;
            s.curveServer = curve.server;
            s.curveSecretKey = curve.secretKey;
            s.curvePublicKey = curve.publicKey;
        }
    }
    /**
     * 将 CURVE 安全配置应用到 SUB socket。
     * 每个 SUB 只连接一个 target，所以可以根据 addr 解析对应的 server 公钥。
     * SUB socket 始终以 client 身份连接对方的 PUB server。
     */
    _applyCurveToSubscriber(socket, addr) {
        const curve = this.config.security?.curve;
        if (!curve)
            return;
        if (curve.mode === 'explicit') {
            const s = socket;
            // SUB socket 始终是 CURVE client：需要对方（PUB）的公钥才能连接
            s.curvePublicKey = curve.publicKey;
            s.curveSecretKey = curve.secretKey;
            if (curve.peerKeys) {
                // 从地址中提取 hostname
                const parsedHost = _extractHostname(addr);
                // 精确匹配 hostname
                if (parsedHost && curve.peerKeys[parsedHost]) {
                    s.curveServerKey = curve.peerKeys[parsedHost];
                }
                else {
                    // fallback：取第一个非本机的公钥（单 PUB 多 SUB 场景）
                    const firstPeer = Object.entries(curve.peerKeys).find(([h]) => h !== getHostname());
                    if (firstPeer)
                        s.curveServerKey = firstPeer[1];
                }
            }
        }
    }
    /**
     * 停止 EventBus，关闭所有 ZeroMQ socket 并清理本地监听器
     */
    async stop() {
        this.running = false;
        if (this.keyWatcher) {
            this.keyWatcher.close();
            this.keyWatcher = null;
        }
        if (this.pubSocket) {
            this.pubSocket.close();
            this.pubSocket = null;
        }
        for (const sub of this.subSockets) {
            sub.close();
        }
        this.subSockets = [];
        this.subAddrs = [];
        this.local.removeAllListeners();
    }
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
    subLastReconnect = [];
    async _reconnectSub(i, retries = 4, reason) {
        if (!this.running || i >= this.subSockets.length)
            return;
        const addr = this.subAddrs[i];
        // 防重复重建：同一 socket 在 5 秒内只能重建一次
        const now = Date.now();
        if (this.subLastReconnect[i] && (now - this.subLastReconnect[i]) < 5000) {
            return;
        }
        this.subLastReconnect[i] = now;
        // 重连前从 NAS 目录重新读取最新公钥（如果有 NAS 目录）
        if (this.nasKeyDir) {
            const addrHost = _extractHostname(addr);
            // 从当前 peerKeys 找出这个地址对应的 hostname
            let peerHost = null;
            const cfgCurve = this.config.security?.curve;
            if (cfgCurve && cfgCurve.mode === 'explicit' && addrHost && cfgCurve.peerKeys) {
                for (const [h, k] of Object.entries(cfgCurve.peerKeys)) {
                    if (k === cfgCurve.peerKeys[addrHost]) {
                        peerHost = h;
                        break;
                    }
                }
                // 从 NAS 读取最新公钥并更新 peerKeys
                const latestKey = readPeerPublicKey(this.nasKeyDir, peerHost || addrHost);
                if (latestKey) {
                    cfgCurve.peerKeys[addrHost] = latestKey;
                    if (peerHost)
                        cfgCurve.peerKeys[peerHost] = latestKey;
                }
            }
        }
        // 关闭旧 socket
        const oldSub = this.subSockets[i];
        if (oldSub) {
            try {
                oldSub.close();
            }
            catch { /* ignore */ }
        }
        // 用（最新）密钥重建连接
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const newSub = new zmq.Subscriber();
                this._applyCurveToSubscriber(newSub, addr);
                await newSub.connect(addr);
                newSub.subscribe(Buffer.alloc(0));
                if (this.running) {
                    this.subSockets[i] = newSub;
                    this._startSubLoop(newSub, i);
                    console.log(`EventBus SUB reconnected to ${addr}${reason ? ` (${reason})` : ''}`);
                }
                else {
                    newSub.close();
                }
                return;
            }
            catch (err) {
                if (attempt < retries - 1) {
                    await new Promise(r => setTimeout(r, 800));
                }
                else {
                    console.warn(`EventBus SUB reconnect failed for ${addr}: ${err.message}`);
                }
            }
        }
    }
    // ── 事件发布 ─────────────────────────
    /**
     * 发布一个事件
     */
    emit(event) {
        const fullEvent = {
            ...event,
            nodeId: this.config.nodeId,
        };
        this.local.emit(event.type, fullEvent);
        if (this.pubSocket) {
            const msg = JSON.stringify(fullEvent);
            this.pubSocket.send([Buffer.from(msg)]).catch((err) => {
                console.warn(`EventBus PUB send error: ${err.message}`);
            });
        }
    }
    // ── 本地订阅 ─────────────────────────
    on(type, handler) {
        this.local.on(type, handler);
    }
    off(type, handler) {
        this.local.off(type, handler);
    }
    clear() {
        this.local.removeAllListeners();
    }
    // ── 内部 ─────────────────────────────
    /**
     * NAS 模式：启动公钥目录文件监听。
     *
     * 当任意 `*.pub` 文件变更时（某个节点重启并更新了公钥），
     * 检查是否是我连接的 peer 发生了变更。如果是，关闭原 SUB socket
     * 并用新公钥重新连接。
     */
    _startKeyWatch() {
        const dir = this.nasKeyDir;
        if (!dir || !fs.existsSync(dir))
            return;
        this.keyWatcher = fs.watch(dir, async (eventType, filename) => {
            if (!this.running || !filename)
                return;
            if (!filename.endsWith('.pub'))
                return;
            const peerHost = filename.slice(0, -4);
            if (peerHost === getHostname())
                return;
            // 读取最新的 peer 公钥
            const newKeyContent = readPeerPublicKey(dir, peerHost);
            if (!newKeyContent)
                return;
            // 遍历所有 sub socket，判断是否有 socket 需要更新
            for (let i = 0; i < this.subAddrs.length; i++) {
                const addr = this.subAddrs[i];
                const addrHost = _extractHostname(addr);
                if (addrHost === null)
                    continue;
                const cfgCurve = this.config.security?.curve;
                if (!cfgCurve || cfgCurve.mode !== 'explicit')
                    continue;
                const currentPeerKey = cfgCurve.peerKeys?.[addrHost];
                // 如果这个地址对应的 peerKey 不存在或没变，跳过
                if (!currentPeerKey || currentPeerKey === newKeyContent)
                    continue;
                // 检查这个地址是否确实对应变更的 peer：
                // 如果 peerKeys 中有 addrHost 映射，且对应的公钥内容就是变更的内容，才重建
                const isAddrMappedToPeer = cfgCurve.peerKeys[addrHost] !== undefined;
                if (!isAddrMappedToPeer)
                    continue;
                // 更新 peerKeys
                cfgCurve.peerKeys[addrHost] = newKeyContent;
                // 也更新 hostname 索引
                cfgCurve.peerKeys[peerHost] = newKeyContent;
                // 关闭旧 socket + 用 `_reconnectSub` 重建（会读最新公钥 + 自动重试）
                const oldSub = this.subSockets[i];
                if (oldSub) {
                    try {
                        oldSub.close();
                    }
                    catch { /* ignore */ }
                }
                this.subSockets[i] = null;
                this._reconnectSub(i, 4, `key updated for ${peerHost}`);
                break;
            }
        });
    }
    /**
     * 为单个 SUB socket 启动事件轮询。
     *
     * 当 receive() 抛出异常（连接断开、对端关闭等），自动触发重连。
     * 重连前会从 NAS 目录重新读取最新公钥，确保 CURVE 握手用最新密钥。
     *
     * @param sub - SUB socket
     * @param idx - subSockets 中的索引（用于 _reconnectSub）
     */
    _startSubLoop(sub, idx) {
        const poll = async () => {
            while (this.running) {
                try {
                    if (sub.closed)
                        break;
                    const [raw] = await sub.receive();
                    if (!this.running)
                        break;
                    const text = Buffer.from(raw).toString('utf-8');
                    let event;
                    try {
                        event = JSON.parse(text);
                    }
                    catch {
                        continue;
                    }
                    if (event.nodeId === this.config.nodeId)
                        continue;
                    this.local.emit(event.type, event);
                }
                catch (err) {
                    if (!this.running)
                        break;
                    console.warn(`EventBus SUB error: ${err.message}`);
                    // 自动重连：断开后尝试重建，重连前会读取最新公钥
                    await this._reconnectSub(idx, 4, 'auto-reconnect after error');
                    break; // 已创建新 sub loop，旧 loop 终止
                }
            }
        };
        poll();
    }
}
exports.EventBus = EventBus;
// ── 辅助函数 ─────────────────────────
/**
 * 从 ZeroMQ 地址中提取 hostname（去除协议前缀和端口）
 *
 * "tcp://node-a.example.com:5555"  → "node-a.example.com"
 * "tcp://10.0.0.1:5555"            → "10.0.0.1"
 * "node-a"                         → "node-a"
 */
function _extractHostname(addr) {
    if (!addr)
        return null;
    // 去掉协议前缀
    const afterProto = addr.includes('://') ? addr.split('://')[1] : addr;
    // 去掉端口
    const host = afterProto.includes(':') ? afterProto.split(':')[0] : afterProto;
    return host || null;
}
// ── 全局单例（需配置后使用） ──────────
let _instance = null;
/**
 * 初始化全局 EventBus（应在应用启动时调用）
 */
async function initEventBus(config) {
    if (_instance) {
        await _instance.stop().catch(() => { });
    }
    _instance = new EventBus(config);
    await _instance.start().catch((err) => {
        console.error(`EventBus init error: ${err.message}`);
    });
    return _instance;
}
/**
 * 获取全局 EventBus 实例
 */
function getEventBus() {
    if (!_instance) {
        throw new Error('EventBus not initialized. Call initEventBus(config) first.');
    }
    return _instance;
}
/**
 * 旧版全局单例（兼容之前无参数调用的代码）
 */
exports.globalEventBus = new Proxy({}, {
    get(_target, prop) {
        if (!_instance) {
            _instance = new EventBus({
                nodeId: 'default',
                publishAddress: null,
                subscribeAddresses: [],
                isRaftLeader: false,
            });
            _instance.start().catch(() => { });
        }
        const val = _instance[prop];
        return typeof val === 'function' ? val.bind(_instance) : val;
    },
});
//# sourceMappingURL=event-bus.js.map