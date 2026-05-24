import * as http from 'http';
import { ShardManager } from '../shard/shard-manager';
export interface RestApiConfig {
    port: number;
    host: string;
    adminToken?: string;
    bodySizeLimit?: number;
    enableCors?: boolean;
    enableRatelimit?: boolean;
    enableAuth?: boolean;
}
export interface RestApiServer {
    start(): Promise<void>;
    stop(): Promise<void>;
    getPort(): number;
}
export declare function parseBody(req: http.IncomingMessage): Promise<unknown>;
/**
 * 发送 JSON 响应
 */
export declare function jsonResponse(res: http.ServerResponse, statusCode: number, data: unknown): void;
export declare function createRestApiServer(shardManager: ShardManager, config: RestApiConfig): RestApiServer;
//# sourceMappingURL=rest.d.ts.map