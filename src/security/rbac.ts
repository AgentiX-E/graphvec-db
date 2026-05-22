import { Role, AuthError } from '../types'

/**
 * RBAC — 基于角色的访问控制
 *
 * 角色权限：
 * - admin: 全部权限
 * - operator: 管理操作（compact/backup/reshard）+ 读写
 * - writer: 读写数据
 * - reader: 只读
 */
export class RBAC {
  private static readonly PERMISSIONS: Record<Role, Set<string>> = {
    [Role.ADMIN]: new Set(['*']),
    [Role.OPERATOR]: new Set([
      'read', 'write', 'delete',
      'compact', 'backup', 'restore', 'reshard',
      'health', 'metrics', 'audit',
    ]),
    [Role.WRITER]: new Set(['read', 'write', 'delete']),
    [Role.READER]: new Set(['read']),
  }

  /**
   * 检查角色是否有权限执行操作
   * @throws { AuthError } 无权限，statusCode=403
   */
  static checkPermission(role: Role, operation: string): void {
    if (role === Role.ADMIN) return

    const allowed = RBAC.PERMISSIONS[role]
    if (!allowed || !allowed.has(operation)) {
      throw new AuthError(
        `Role '${role}' does not have permission for '${operation}'`,
        403
      )
    }
  }

  /**
   * 检查资源访问权限
   */
  static checkResourceAccess(role: Role, resourceType: string): void {
    // admin 可以访问任何资源
    if (role === Role.ADMIN) return

    // reader 只能读
    if (role === Role.READER && resourceType.startsWith('write:')) {
      throw new AuthError('Reader cannot write resources', 403)
    }
  }

  /** 获取角色的所有权限 */
  static getPermissions(role: Role): string[] {
    if (role === Role.ADMIN) return ['* (all)']
    return [...(RBAC.PERMISSIONS[role] || [])]
  }
}
