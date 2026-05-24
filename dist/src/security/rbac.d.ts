import { Role } from '../types';
/**
 * RBAC — 基于角色的访问控制
 *
 * 角色权限：
 * - admin: 全部权限
 * - operator: 管理操作（compact/backup/reshard）+ 读写
 * - writer: 读写数据
 * - reader: 只读
 */
export declare class RBAC {
    private static readonly PERMISSIONS;
    /**
     * 检查角色是否有权限执行操作
     * @throws { AuthError } 无权限，statusCode=403
     */
    static checkPermission(role: Role, operation: string): void;
    /**
     * 检查资源访问权限
     */
    static checkResourceAccess(role: Role, resourceType: string): void;
    /** 获取角色的所有权限 */
    static getPermissions(role: Role): string[];
}
//# sourceMappingURL=rbac.d.ts.map