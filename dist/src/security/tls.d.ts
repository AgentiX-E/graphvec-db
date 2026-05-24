import { AuthConfig } from '../types';
export declare class TLSConfig {
    private config;
    constructor(config: AuthConfig);
    /**
     * 获取 TLS 服务器选项
     */
    getServerOptions(): {
        key: string;
        cert: string;
        ca?: string;
        requestCert: boolean;
        rejectUnauthorized: boolean;
    };
    /**
     * 从证书 subject 中提取 CN（Common Name）
     *
     * 安全校验：
     * - 校验证书对象结构（拒绝非对象输入）
     * - CN 必须符合节点 ID 格式（字母数字中划线，1-64 字符）
     * - 无效格式返回 null 而非抛出异常
     */
    static extractCN(cert: unknown): string | null;
}
//# sourceMappingURL=tls.d.ts.map