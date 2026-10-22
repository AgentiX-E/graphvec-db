// ============================================================
// RBAC (Role-Based Access Control) with ACL (Access Control Lists)
//
// Extends the role-level RBAC with fine-grained resource-level ACL.
// Resource types: database, graph_node, graph_edge, query
// Actions: create, read, update, delete, query, admin
//
// Backward compatible: if no ACLs defined, falls back to role-based defaults.
// ============================================================

import { Role, AuthError } from '../types'

// ──────────────────────────────────────────
// Types
// ──────────────────────────────────────────

export type AclResourceType = 'database' | 'graph_node' | 'graph_edge' | 'query' | 'subgraph'
export type AclAction = 'create' | 'read' | 'update' | 'delete' | 'query' | 'admin'

export interface AclEntry {
  role: string
  resource: AclResourceType
  resourceId?: string
  actions: AclAction[]
}

export interface AclStore {
  addAcl(entry: AclEntry): void
  removeAcl(role: string, resource: string, resourceId?: string): boolean
  checkPermission(role: string, action: string, resource?: string, resourceId?: string): boolean
  getAcls(role?: string): AclEntry[]
}

// ──────────────────────────────────────────
// Default permission map (role-based fallback)
// ──────────────────────────────────────────

const ROLE_ACTION_MAP: Record<string, string[]> = {
  [Role.ADMIN]: ['create', 'read', 'update', 'delete', 'query', 'admin', 'write'],
  [Role.OPERATOR]: ['create', 'read', 'update', 'delete', 'query', 'write'],
  [Role.WRITER]: ['create', 'read', 'update', 'delete', 'query', 'write'],
  [Role.READER]: ['read', 'query'],
}

// ──────────────────────────────────────────
// In-memory ACL Implementation
// ──────────────────────────────────────────

class MemoryAclStore implements AclStore {
  private acls: AclEntry[] = []

  addAcl(entry: AclEntry): void {
    // Remove any existing ACL for the same (role, resource, resourceId) first
    this.acls = this.acls.filter(
      (e) => !(e.role === entry.role && e.resource === entry.resource && e.resourceId === entry.resourceId),
    )
    this.acls.push({ ...entry })
  }

  removeAcl(role: string, resource: string, resourceId?: string): boolean {
    const before = this.acls.length
    this.acls = this.acls.filter(
      (e) => !(e.role === role && e.resource === resource && e.resourceId === resourceId),
    )
    return this.acls.length < before
  }

  checkPermission(role: string, action: string, resource?: string, resourceId?: string): boolean {
    // Admin always has access
    if (role === Role.ADMIN) return true

    // If ACLs are defined, use them
    if (this.acls.length > 0) {
      // Check for matching ACLs with wildcard resource mathcing
      const matching = this.acls.filter((e) => {
        if (e.role !== role) return false
        if (e.resource === resource || resource === undefined) return true
        if ((e.resource as string) === '*' || resource === '*') return true
        return false
      })

      // If we have specific resource ACLs, they take priority
      const specificAcls = matching.filter((e) => e.resourceId !== undefined)
      const wildcardAcls = matching.filter((e) => e.resourceId === undefined)

      // Check specific entries first (resourceId match), then wildcard
      if (resourceId !== undefined) {
        for (const acl of specificAcls) {
          if (acl.resourceId === resourceId || acl.resourceId === '*') {
            if (acl.actions.includes(action as AclAction) || acl.actions.includes('admin')) {
              return true
            }
          }
        }
      }

      // Fall back to wildcard resource ACLs (no resourceId)
      for (const acl of wildcardAcls) {
        if (acl.actions.includes(action as AclAction) || acl.actions.includes('admin')) {
          return true
        }
      }
      // Also check specific non-wildcard acls where resourceId matches
      for (const acl of specificAcls) {
        if (resourceId !== undefined && acl.resourceId === undefined) continue
        if (resourceId === undefined && acl.resourceId !== undefined) continue
        if (acl.resourceId !== undefined && acl.resourceId !== resourceId) continue
        if (acl.actions.includes(action as AclAction) || acl.actions.includes('admin')) {
          return true
        }
      }
      return false
    }

    // Fall back to role-based defaults
    const allowed = ROLE_ACTION_MAP[role]
    if (!allowed) return false
    return allowed.includes(action) || allowed.includes('admin')
  }

  getAcls(role?: string): AclEntry[] {
    if (role !== undefined) {
      return this.acls.filter((e) => e.role === role)
    }
    return [...this.acls]
  }

  clear(): void {
    this.acls = []
  }
}

// ──────────────────────────────────────────
// RBAC class with ACL support
// ──────────────────────────────────────────

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

  /** Shared ACL store (shared across all instances in the process) */
  private static aclStore: MemoryAclStore = new MemoryAclStore()

  /**
   * Check if a role has permission for an operation (legacy permission check)
   * @throws { AuthError } if not authorized (statusCode=403)
   */
  static checkPermission(role: Role, operation: string): void {
    if (role === Role.ADMIN) return

    const allowed = RBAC.PERMISSIONS[role]
    if (!allowed || !allowed.has(operation)) {
      throw new AuthError(
        `Role '${role}' does not have permission for '${operation}'`,
        403,
      )
    }
  }

  /**
   * ACL-aware permission check.
   * First checks ACLs; if no ACLs are defined, falls back to role-based defaults.
   *
   * @param role User's role
   * @param action The action being performed (create, read, update, delete, query, admin)
   * @param resource Optional resource type
   * @param resourceId Optional resource ID
   * @throws { AuthError } if not authorized (statusCode=403)
   */
  static checkAclPermission(
    role: Role,
    action: string,
    resource?: AclResourceType | string,
    resourceId?: string,
  ): void {
    const hasPermission = RBAC.aclStore.checkPermission(role, action, resource, resourceId)
    if (!hasPermission) {
      let detail = `Role '${role}' does not have '${action}' permission`
      if (resource) detail += ` on '${resource}'`
      if (resourceId) detail += ` (id: ${resourceId})`
      throw new AuthError(detail, 403)
    }
  }

  /**
   * Add an ACL entry
   */
  static addAcl(entry: AclEntry): void {
    RBAC.aclStore.addAcl(entry)
  }

  /**
   * Remove ACL entries matching the given criteria
   * @returns true if any entries were removed
   */
  static removeAcl(role: string, resource: string, resourceId?: string): boolean {
    return RBAC.aclStore.removeAcl(role, resource, resourceId)
  }

  /**
   * Check if an ACL allows the action for the given role/resource/resourceId.
   * Unlike checkAclPermission, this does NOT throw — it returns a boolean.
   */
  static aclAllows(role: string, action: string, resource?: string, resourceId?: string): boolean {
    return RBAC.aclStore.checkPermission(role, action, resource, resourceId)
  }

  /**
   * Get all ACL entries, optionally filtered by role
   */
  static getAcls(role?: string): AclEntry[] {
    return RBAC.aclStore.getAcls(role)
  }

  /**
   * Clear all ACL entries (useful for testing)
   */
  static clearAcls(): void {
    RBAC.aclStore.clear()
  }

  /**
   * Check if a role has permission to perform an action on a subgraph.
   * Subgraph ACLs use resource type 'subgraph' with resourceId as the subgraph name.
   *
   * Unlike checkAclPermission, this does NOT fall back to role-based defaults —
   * subgraph access must be explicitly granted via ACLs.
   *
   * @param role User's role
   * @param subgraph Subgraph name
   * @param action Action to check (read, write, admin)
   * @throws { AuthError } if not authorized (statusCode=403)
   */
  static checkSubgraphPermission(
    role: Role | string,
    subgraph: string,
    action: string,
  ): void {
    if (role === Role.ADMIN) return

    // Check if there are any subgraph ACLs defined
    const allSubgraphAcls = RBAC.aclStore.getAcls().filter(e => e.resource === 'subgraph')
    if (allSubgraphAcls.length === 0) {
      throw new AuthError(
        `Role '${role}' does not have '${action}' permission on subgraph '${subgraph}' — no subgraph ACLs defined`,
        403,
      )
    }

    // Check specific subgraph ACL
    const matching = allSubgraphAcls.filter(e => e.resourceId === subgraph)
    if (matching.length === 0) {
      throw new AuthError(
        `Role '${role}' does not have '${action}' permission on subgraph '${subgraph}' — no ACLs for this subgraph`,
        403,
      )
    }

    // Check role has the action in this subgraph's ACLs
    for (const acl of matching) {
      if (acl.role !== role && acl.role !== '*') continue
      if (acl.actions.includes(action as AclAction) || acl.actions.includes('admin')) {
        return
      }
    }

    throw new AuthError(
      `Role '${role}' does not have '${action}' permission on subgraph '${subgraph}'`,
      403,
    )
  }

  /**
   * Get ACL entries for a specific subgraph (debug/audit).
   * Returns all roles that have access to the given subgraph.
   */
  static getSubgraphAcls(subgraph: string): AclEntry[] {
    return RBAC.aclStore.getAcls().filter(e => e.resource === 'subgraph' && e.resourceId === subgraph)
  }

  /**
   * Get detailed permissions for a role
   */
  static getPermissions(role: Role): string[] {
    if (role === Role.ADMIN) return ['* (all)']
    return [...(RBAC.PERMISSIONS[role] || [])]
  }

  /**
   * (Legacy) Check if a role can access a database
   */
  static checkDatabaseAccess(role: Role, databases: string[] | undefined, database: string): void {
    if (role === Role.ADMIN) return
    if (!databases || databases.length === 0) return
    if (databases.includes(database)) return
    throw new AuthError(`Access denied to database '${database}'`, 403)
  }

  /**
   * (Legacy) Check resource access
   */
  static checkResourceAccess(role: Role, resourceType: string): void {
    if (role === Role.ADMIN) return
    if (role === Role.READER && resourceType.startsWith('write:')) {
      throw new AuthError('Reader cannot write resources', 403)
    }
  }
}
