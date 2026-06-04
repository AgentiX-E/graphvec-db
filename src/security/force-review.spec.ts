// ============================================================
// force-review.spec.ts — 强制审批机制测试（15 tests）
//
// 覆盖：
//   - 创建审批请求
//   - 审批通过/拒绝
//   - 超时自动过期
//   - 多人审批（必要人数校验）
//   - 自审批拒绝
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest'
import { ForceReviewManager } from './auth'

describe('ForceReview — 强制审批机制', () => {
  let manager: ForceReviewManager

  beforeEach(() => {
    manager = new ForceReviewManager()
  })

  // ── 创建审批请求 ───────────────────────────────────────────

  describe('createRequest', () => {
    it('creates a review request with pending status', () => {
      const req = manager.createRequest('delete-node', 'alice', ['bob', 'charlie'])
      expect(req.id).toBeDefined()
      expect(req.id).toMatch(/^fr_\d+_\d+$/)
      expect(req.operation).toBe('delete-node')
      expect(req.requestor).toBe('alice')
      expect(req.requiredReviewers).toEqual(['bob', 'charlie'])
      expect(req.status).toBe('pending')
      expect(req.approvedBy).toEqual([])
      expect(req.rejectedBy).toEqual([])
      expect(req.createdAt).toBeGreaterThan(0)
      expect(req.expiresAt).toBeGreaterThan(req.createdAt)
      expect(req.requiredApprovals).toBe(2) // default = all reviewers
    })

    it('creates with custom requiredApprovals', () => {
      const req = manager.createRequest('restart', 'alice', ['bob', 'charlie', 'dave'], 2)
      expect(req.requiredApprovals).toBe(2)
    })

    it('throws if operation is empty', () => {
      expect(() => manager.createRequest('', 'alice', ['bob'])).toThrow()
    })

    it('throws if requestor is in the reviewers list', () => {
      expect(() => manager.createRequest('op', 'alice', ['alice', 'bob'])).toThrow('cannot be in the required reviewers')
    })

    it('throws if requiredApprovals exceeds reviewer count', () => {
      expect(() => manager.createRequest('op', 'alice', ['bob'], 5)).toThrow('cannot exceed reviewer count')
    })

    it('throws if requiredApprovals < 1', () => {
      expect(() => manager.createRequest('op', 'alice', ['bob'], 0)).toThrow('At least 1 approval')
    })
  })

  // ── 审批通过 ───────────────────────────────────────────────

  describe('approve', () => {
    it('approves a request when all reviewers approve', () => {
      const req = manager.createRequest('deploy', 'alice', ['bob', 'charlie'])
      const afterBob = manager.approve(req.id, 'bob')
      expect(afterBob.status).toBe('pending') // still needs charlie
      expect(afterBob.approvedBy).toEqual(['bob'])

      const afterCharlie = manager.approve(req.id, 'charlie')
      expect(afterCharlie.status).toBe('approved')
      expect(afterCharlie.approvedBy).toEqual(['bob', 'charlie'])
    })

    it('approves with majority (requiredApprovals < all reviewers)', () => {
      const req = manager.createRequest('scale-up', 'alice', ['bob', 'charlie', 'dave'], 2)
      const afterBob = manager.approve(req.id, 'bob')
      expect(afterBob.status).toBe('pending')

      const afterCharlie = manager.approve(req.id, 'charlie')
      expect(afterCharlie.status).toBe('approved')
    })

    it('throws if reviewer is not in the required list', () => {
      const req = manager.createRequest('op', 'alice', ['bob'])
      expect(() => manager.approve(req.id, 'eve')).toThrow('not in the required reviewers')
    })

    it('is idempotent for same reviewer', () => {
      const req = manager.createRequest('op', 'alice', ['bob'])
      manager.approve(req.id, 'bob')
      const result = manager.approve(req.id, 'bob')
      expect(result.status).toBe('approved')
      expect(result.approvedBy).toEqual(['bob'])
    })

    it('throws if request does not exist', () => {
      expect(() => manager.approve('nonexistent', 'bob')).toThrow('not found')
    })
  })

  // ── 审批拒绝 ───────────────────────────────────────────────

  describe('reject', () => {
    it('rejects immediately when any reviewer rejects', () => {
      const req = manager.createRequest('dangerous-op', 'alice', ['bob', 'charlie'])
      const result = manager.reject(req.id, 'bob')
      expect(result.status).toBe('rejected')
      expect(result.rejectedBy).toEqual(['bob'])
    })

    it('throws if reviewer is not in the required list', () => {
      const req = manager.createRequest('op', 'alice', ['bob'])
      expect(() => manager.reject(req.id, 'eve')).toThrow('not in the required reviewers')
    })

    it('is idempotent for same rejecting reviewer', () => {
      const req = manager.createRequest('op', 'alice', ['bob'])
      manager.reject(req.id, 'bob')
      const result = manager.reject(req.id, 'bob')
      expect(result.status).toBe('rejected')
      expect(result.rejectedBy).toEqual(['bob'])
    })

    it('throws if request does not exist', () => {
      expect(() => manager.reject('nonexistent', 'bob')).toThrow('not found')
    })
  })

  // ── 自审批拒绝 ─────────────────────────────────────────────

  describe('self-approval rejection', () => {
    it('throws when requestor tries to approve own request', () => {
      const req = manager.createRequest('op', 'alice', ['bob'])
      expect(() => manager.approve(req.id, 'alice')).toThrow('Self-approval is not allowed')
    })
  })

  // ── 超时过期 ───────────────────────────────────────────────

  describe('timeout / expiration', () => {
    it('expires request after ttl has passed', async () => {
      // Use a very short ttl (1ms) and wait for it to elapse
      const req = manager.createRequest('op', 'alice', ['bob'], 1, 1)
      await new Promise(resolve => setTimeout(resolve, 5))
      const status = manager.getStatus(req.id)
      expect(status).not.toBeNull()
      expect(status!.status).toBe('expired')
    })

    it('approve returns expired status for timed-out request', async () => {
      const req = manager.createRequest('op', 'alice', ['bob'], 1, 1)
      await new Promise(resolve => setTimeout(resolve, 5))
      const result = manager.approve(req.id, 'bob')
      expect(result.status).toBe('expired')
    })

    it('reject returns expired status for timed-out request', async () => {
      const req = manager.createRequest('op', 'alice', ['bob'], 1, 1)
      await new Promise(resolve => setTimeout(resolve, 5))
      const result = manager.reject(req.id, 'bob')
      expect(result.status).toBe('expired')
    })
  })

  // ── 查询与列表 ─────────────────────────────────────────────

  describe('getStatus / listRequests', () => {
    it('getStatus returns null for unknown id', () => {
      expect(manager.getStatus('nonexistent')).toBeNull()
    })

    it('listRequests returns all requests without filter', () => {
      manager.createRequest('op1', 'alice', ['bob'])
      manager.createRequest('op2', 'bob', ['charlie'])
      const all = manager.listRequests()
      expect(all.length).toBe(2)
    })

    it('listRequests filters by status', () => {
      const r1 = manager.createRequest('op1', 'alice', ['bob'])
      const r2 = manager.createRequest('op2', 'bob', ['charlie'])
      manager.approve(r1.id, 'bob')

      const approved = manager.listRequests('approved')
      expect(approved.length).toBe(1)
      expect(approved[0].id).toBe(r1.id)

      const pending = manager.listRequests('pending')
      expect(pending.length).toBe(1)
      expect(pending[0].id).toBe(r2.id)
    })

    it('getPendingForUser returns only pending requests for a specific reviewer', () => {
      manager.createRequest('op1', 'alice1', ['bob'])
      manager.createRequest('op2', 'alice2', ['charlie'])
      manager.createRequest('op3', 'alice3', ['bob', 'dave'])

      const bobPending = manager.getPendingForUser('bob')
      expect(bobPending.length).toBe(2) // op1 and op3
    })

    it('cleanupExpired marks expired requests', async () => {
      manager.createRequest('op1', 'alice', ['bob'], 1, 1)
      manager.createRequest('op2', 'bob', ['charlie'], 1, 1)
      await new Promise(resolve => setTimeout(resolve, 5))
      const count = manager.cleanupExpired()
      expect(count).toBe(2)
    })
  })
})
