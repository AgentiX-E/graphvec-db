"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RBAC = void 0;
const types_1 = require("../types");
/**
 * RBAC — 基于角色的访问控制
 *
 * 角色权限：
 * - admin: 全部权限
 * - operator: 管理操作（compact/backup/reshard）+ 读写
 * - writer: 读写数据
 * - reader: 只读
 */
class RBAC {
    static PERMISSIONS = {
        [types_1.Role.ADMIN]: new Set(['*']),
        [types_1.Role.OPERATOR]: new Set([
            'read', 'write', 'delete',
            'compact', 'backup', 'restore', 'reshard',
            'health', 'metrics', 'audit',
        ]),
        [types_1.Role.WRITER]: new Set(['read', 'write', 'delete']),
        [types_1.Role.READER]: new Set(['read']),
    };
    /**
     * 检查角色是否有权限执行操作
     * @throws { AuthError } 无权限，statusCode=403
     */
    static checkPermission(role, operation) {
        if (role === types_1.Role.ADMIN)
            return;
        const allowed = RBAC.PERMISSIONS[role];
        if (!allowed || !allowed.has(operation)) {
            throw new types_1.AuthError(`Role '${role}' does not have permission for '${operation}'`, 403);
        }
    }
    /**
     * 检查资源访问权限
     */
    static checkResourceAccess(role, resourceType) {
        // admin 可以访问任何资源
        if (role === types_1.Role.ADMIN)
            return;
        // reader 只能读
        if (role === types_1.Role.READER && resourceType.startsWith('write:')) {
            throw new types_1.AuthError('Reader cannot write resources', 403);
        }
    }
    /** 获取角色的所有权限 */
    static getPermissions(role) {
        if (role === types_1.Role.ADMIN)
            return ['* (all)'];
        return [...(RBAC.PERMISSIONS[role] || [])];
    }
}
exports.RBAC = RBAC;
//# sourceMappingURL=rbac.js.map