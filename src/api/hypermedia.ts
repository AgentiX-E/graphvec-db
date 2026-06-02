/**
 * hypermedia.ts — HATEOAS 超媒体链接注入
 *
 * 在 JSON API 响应中自动注入 _links 字段，实现超媒体驱动的 REST API。
 * 遵循 HAL 规范格式：{ data: ..., _links: { self: ..., related: ... } }
 */

export interface HypermediaLink {
  href: string
  method?: string
  title?: string
}

export interface HypermediaLinks {
  self: HypermediaLink
  next?: HypermediaLink
  prev?: HypermediaLink
  related?: HypermediaLink[]
}

export interface EnrichedResponse<T = unknown> {
  data: T
  _links: HypermediaLinks
}

/** 为单节点响应注入 HATEOAS 链接 */
export function enrichNodeLinks(
  node: Record<string, unknown> | null,
  selfPath: string,
): EnrichedResponse<Record<string, unknown> | null> | Record<string, unknown> | null {
  if (!node) return node
  const nodeId = node.id
  return {
    data: node,
    _links: {
      self: { href: selfPath, method: 'GET', title: '节点详情' },
      related: [
        { href: `/api/v1/graph/edges/${nodeId}`, method: 'GET', title: '相邻边' },
        { href: '/api/v1/graph/node/neighbors', method: 'POST', title: '邻居节点' },
      ],
    },
  }
}

/** 为边列表响应注入 HATEOAS 链接 */
export function enrichEdgeLinks(
  result: Record<string, unknown>,
  selfPath: string,
  nodeId?: number | string,
): EnrichedResponse<Record<string, unknown>> {
  const links: HypermediaLinks = { self: { href: selfPath, method: 'GET', title: '边列表' } }
  if (nodeId !== undefined) {
    links.related = [{ href: `/api/v1/graph/node/${nodeId}`, method: 'GET', title: '节点详情' }]
  }
  return { data: result, _links: links }
}

/** 为列表响应注入 HATEOAS 链接 */
export function enrichListLinks<T>(
  items: T[],
  selfPath: string,
  count: number,
  extra?: Record<string, unknown>,
): EnrichedResponse<{ items: T[]; count: number } & Record<string, unknown>> {
  return {
    data: { items, count, ...(extra || {}) } as any,
    _links: { self: { href: selfPath, method: 'GET', title: '数据列表' } },
  }
}

/** 为查询结果注入 HATEOAS 链接 */
export function enrichQueryLinks<T extends Record<string, unknown>>(data: T, selfPath: string): EnrichedResponse<T> {
  return {
    data,
    _links: {
      self: { href: selfPath, method: 'POST', title: '执行查询' },
      related: [
        { href: '/api/v1/ops/slow-queries', method: 'GET', title: '查看慢查询' },
        { href: '/api/status', method: 'GET', title: '系统状态' },
      ],
    },
  }
}

/** 通用响应注入器 */
export function enrichResponse<T = unknown>(
  data: T,
  selfPath: string,
  method?: string,
  title?: string,
  relatedLinks?: HypermediaLink[],
): EnrichedResponse<T> {
  const links: HypermediaLinks = { self: { href: selfPath, method: method ?? 'GET', title: title ?? '当前资源' } }
  if (relatedLinks && relatedLinks.length > 0) links.related = relatedLinks
  return { data, _links: links }
}
