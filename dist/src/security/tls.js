"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TLSConfig = void 0;
/**
 * TLS — mTLS 配置管理
 *
 * 生产环境应使用真实的 CA 签名证书
 * 开发环境可使用自签名证书
 */
// 受信任的节点 ID 模式：字母数字中划线，1-64 字符
const NODE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
class TLSConfig {
    config;
    constructor(config) {
        this.config = config;
    }
    /**
     * 获取 TLS 服务器选项
     */
    getServerOptions() {
        if (!this.config.tlsCert || !this.config.tlsKey) {
            throw new Error('TLS: cert and key must be configured for server mode');
        }
        return {
            key: this.config.tlsKey,
            cert: this.config.tlsCert,
            ca: this.config.tlsCA,
            requestCert: this.config.mode === 'mtls',
            rejectUnauthorized: this.config.mode === 'mtls',
        };
    }
    /**
     * 从证书 subject 中提取 CN（Common Name）
     *
     * 安全校验：
     * - 校验证书对象结构（拒绝非对象输入）
     * - CN 必须符合节点 ID 格式（字母数字中划线，1-64 字符）
     * - 无效格式返回 null 而非抛出异常
     */
    static extractCN(cert) {
        if (!cert || typeof cert !== 'object')
            return null;
        try {
            const subject = cert.subject;
            if (!subject || typeof subject !== 'object')
                return null;
            const rawCN = subject.CN ?? subject.commonName;
            if (typeof rawCN !== 'string' || !rawCN)
                return null;
            if (!NODE_ID_PATTERN.test(rawCN))
                return null;
            return rawCN;
        }
        catch {
            return null;
        }
    }
}
exports.TLSConfig = TLSConfig;
//# sourceMappingURL=tls.js.map