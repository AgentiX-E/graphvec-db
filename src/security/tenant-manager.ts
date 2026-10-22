// ============================================================
// tenant-manager.ts — Tenant/Subgraph CRUD Manager
//
// Provides the storage and management layer for tenants (subgraphs).
// Tenants are named namespaces that isolate graph data — each tenant
// maps to a subgraph that controls access via RBAC ACLs.
//
// Used by the REST API endpoints for tenant management (GAP-54).
// ============================================================

import { RBAC } from '../security/auth'
import type { Role } from '../types'

// ──────────────────────────────────────────
// Types
// ──────────────────────────────────────────

export interface Tenant {
  /** Unique tenant name (also used as subgraph resourceId) */
  name: string
  /** Human-readable label */
  displayName: string
  /** Optional description */
  description?: string
  /** Creation timestamp (epoch ms) */
  createdAt: number
  /** Last modification timestamp */
  updatedAt: number
  /** Whether the tenant is active */
  active: boolean
  /** Metadata key-value pairs */
  metadata?: Record<string, string>
}

export interface TenantCreateRequest {
  name: string
  displayName?: string
  description?: string
  metadata?: Record<string, string>
}

export interface TenantUpdateRequest {
  displayName?: string
  description?: string
  active?: boolean
  metadata?: Record<string, string>
}

export interface TenantConfig {
  /** Default actions to grant to the creating role (default: ['read', 'write']) */
  defaultActions?: string[]
}

// ──────────────────────────────────────────
// TenantManager
// ──────────────────────────────────────────

export class TenantManager {
  private tenants: Map<string, Tenant> = new Map()
  private defaultActions: string[]

  constructor(config?: TenantConfig) {
    this.defaultActions = config?.defaultActions ?? ['read', 'write']
  }

  /**
   * Create a new tenant (subgraph).
   * Automatically grants the creating role access via ACL.
   *
   * @returns The created tenant
   * @throws Error if tenant already exists
   */
  createTenant(request: TenantCreateRequest, creatorRole?: string): Tenant {
    const name = request.name.trim()
    if (!name) {
      throw new Error('Tenant name is required')
    }
    if (this.tenants.has(name)) {
      throw new Error(`Tenant '${name}' already exists`)
    }

    const now = Date.now()
    const tenant: Tenant = {
      name,
      displayName: request.displayName?.trim() || name,
      description: request.description?.trim(),
      createdAt: now,
      updatedAt: now,
      active: true,
      metadata: request.metadata,
    }

    this.tenants.set(name, tenant)

    // Automatically create subgraph ACL entries
    RBAC.addAcl({
      role: creatorRole || '*',
      resource: 'subgraph',
      resourceId: name,
      actions: this.defaultActions as any,
    })

    return tenant
  }

  /**
   * Get a tenant by name
   */
  getTenant(name: string): Tenant | undefined {
    return this.tenants.get(name)
  }

  /**
   * List all tenants, optionally filtered by active status
   */
  listTenants(activeOnly?: boolean): Tenant[] {
    const all = Array.from(this.tenants.values())
    if (activeOnly) {
      return all.filter(t => t.active)
    }
    return all
  }

  /**
   * Update a tenant's properties
   *
   * @returns The updated tenant
   * @throws Error if tenant does not exist
   */
  updateTenant(name: string, request: TenantUpdateRequest): Tenant {
    const tenant = this.tenants.get(name)
    if (!tenant) {
      throw new Error(`Tenant '${name}' not found`)
    }

    if (request.displayName !== undefined) {
      tenant.displayName = request.displayName.trim() || name
    }
    if (request.description !== undefined) {
      tenant.description = request.description.trim()
    }
    if (request.active !== undefined) {
      tenant.active = request.active
      // If deactivating, remove ALL subgraph ACLs for this tenant
      if (!request.active) {
        _removeAllTenantAcls(name)
      }
    }
    if (request.metadata !== undefined) {
      tenant.metadata = request.metadata
    }

    tenant.updatedAt = Date.now()
    return { ...tenant }
  }

  /**
   * Delete a tenant and its subgraph ACLs
   *
   * @returns true if deleted, false if not found
   */
  deleteTenant(name: string): boolean {
    if (!this.tenants.has(name)) {
      return false
    }
    this.tenants.delete(name)
    // Remove ALL subgraph ACLs for this tenant (regardless of role)
    _removeAllTenantAcls(name)
    return true
  }

  /**
   * Grant a role access to a tenant (subgraph)
   */
  grantAccess(tenantName: string, role: string, actions: string[]): void {
    if (!this.tenants.has(tenantName)) {
      throw new Error(`Tenant '${tenantName}' not found`)
    }
    RBAC.addAcl({
      role,
      resource: 'subgraph',
      resourceId: tenantName,
      actions: actions as any,
    })
  }

  /**
   * Revoke a role's access to a tenant (subgraph)
   */
  revokeAccess(tenantName: string, role: string): boolean {
    if (!this.tenants.has(tenantName)) {
      return false
    }
    return RBAC.removeAcl(role, 'subgraph', tenantName)
  }

  /**
   * List all roles that have access to a tenant
   */
  listAccess(tenantName: string): Array<{ role: string; actions: string[] }> {
    const acls = RBAC.getAcls()
    return acls
      .filter(e => e.resource === 'subgraph' && e.resourceId === tenantName)
      .map(e => ({ role: e.role, actions: e.actions as string[] }))
  }

  /**
   * Get RBAC subgraph permission checker
   */
  checkPermission(role: string, subgraph: string, action: string): void {
    RBAC.checkSubgraphPermission(role as Role, subgraph, action)
  }

  /**
   * Get number of tenants
   */
  get count(): number {
    return this.tenants.size
  }

  /**
   * Check if a tenant exists
   */
  exists(name: string): boolean {
    return this.tenants.has(name)
  }

  /**
   * Reset all tenants (for testing)
   */
  reset(): void {
    // Remove ALL subgraph ACLs (iterate to handle any role)
    const acls = RBAC.getAcls()
    for (const entry of acls) {
      if (entry.resource === 'subgraph') {
        RBAC.removeAcl(entry.role, 'subgraph', entry.resourceId)
      }
    }
    this.tenants.clear()
  }
}

/**
 * 移除指定租户的所有 ACL（遍历所有角色）。
 * 由于 ACL 创建角色可能是任意值，不能只按 '*' 删除。
 */
function _removeAllTenantAcls(tenantName: string): void {
  const acls = RBAC.getAcls()
  for (const entry of acls) {
    if (entry.resource === 'subgraph' && entry.resourceId === tenantName) {
      RBAC.removeAcl(entry.role, 'subgraph', tenantName)
    }
  }
}

// ──────────────────────────────────────────
// Default singleton instance
// ──────────────────────────────────────────

/** Global TenantManager instance (singleton for the process) */
let _defaultTenantManager: TenantManager | null = null

/**
 * Get or create the default TenantManager singleton
 */
export function getDefaultTenantManager(): TenantManager {
  if (!_defaultTenantManager) {
    _defaultTenantManager = new TenantManager()
  }
  return _defaultTenantManager
}

/**
 * Set the default TenantManager (useful for dependency injection / testing)
 */
export function setDefaultTenantManager(mgr: TenantManager): void {
  _defaultTenantManager = mgr
}

/**
 * Clear the default TenantManager (for testing reset)
 */
export function clearDefaultTenantManager(): void {
  _defaultTenantManager = null
}
