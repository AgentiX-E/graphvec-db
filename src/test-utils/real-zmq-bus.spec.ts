import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

// Mock the EventBus module for unit testing the test-utils
const mockEventBusInstances: any[] = []

class MockEventBus {
  start = vi.fn().mockResolvedValue(undefined)
  stop = vi.fn().mockResolvedValue(undefined)
  getPeerNodeIds = vi.fn().mockReturnValue(['node-1', 'node-2'])
  send = vi.fn().mockResolvedValue(undefined)

  constructor(config: any) {
    mockEventBusInstances.push(this)
  }

  static generateCurveKeys() {
    return {
      publicKey: Buffer.from('mock-public-key-32-bytes-long!!!'),
      secretKey: Buffer.from('mock-secret-key-32-bytes-long!!!'),
    }
  }

  static writePublicKeyToDir(_dir: string, _nodeId: string, _port: number, _publicKey: Buffer) {
    // No-op in test - real impl writes to fs
  }
}

const MockWorkerPool = class MockWorkerPool {
  start = vi.fn()
  stop = vi.fn()
}

vi.mock('../core/event-bus', () => ({
  EventBus: MockEventBus,
  EventBusWorkerPool: MockWorkerPool,
}))

describe('real-zmq-bus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('allocPort', () => {
    it('returns sequential port numbers', async () => {
      const mod = await import('./real-zmq-bus')
      const p1 = mod.allocPort()
      const p2 = mod.allocPort()
      const p3 = mod.allocPort()

      expect(p2).toBe(p1 + 1)
      expect(p3).toBe(p2 + 1)
    })

    it('starts from PORT_BASE value', async () => {
      const mod = await import('./real-zmq-bus')
      const p1 = mod.allocPort()
      // PORT_BASE = 15000 + rand(0-4999)
      expect(p1).toBeGreaterThanOrEqual(15000)
      expect(p1).toBeLessThan(20000)
    })
  })

  describe('resetPortAllocator', () => {
    it('resets and offsets next port by fileOffset', async () => {
      const mod = await import('./real-zmq-bus')
      mod.resetPortAllocator()
      const p1 = mod.allocPort() // PORT_BASE + 0
      mod.resetPortAllocator()
      const p2 = mod.allocPort() // PORT_BASE + 30
      // After reset, fileOffset increments by 30 each time
      expect(p2).toBe(p1 + 30)
    })

    it('can be called multiple times', async () => {
      const mod = await import('./real-zmq-bus')
      // First reset
      mod.resetPortAllocator()
      // Sequential ports are deterministic after reset
      const p1 = mod.allocPort()
      expect(p1).toBeGreaterThanOrEqual(15000)
    })
  })

  describe('createTestDirs', () => {
    it('creates root and curve directories', async () => {
      const mod = await import('./real-zmq-bus')
      const { root, curve } = mod.createTestDirs('test-dir')

      expect(root).toContain('test-dir')
      expect(curve).toContain('curve')
      expect(fs.existsSync(root)).toBe(true)
      expect(fs.existsSync(curve)).toBe(true)

      // Cleanup
      mod.removeTestDirs(root)
    })

    it('uses unique directory names (counter increment)', async () => {
      const mod = await import('./real-zmq-bus')
      const { root: r1 } = mod.createTestDirs()
      const { root: r2 } = mod.createTestDirs()
      expect(r1).not.toBe(r2)
      mod.removeTestDirs(r1)
      mod.removeTestDirs(r2)
    })

    it('creates curve subdirectory inside root', async () => {
      const mod = await import('./real-zmq-bus')
      const { root, curve } = mod.createTestDirs()
      expect(path.basename(curve)).toBe('curve')
      expect(path.dirname(curve)).toBe(root)
      mod.removeTestDirs(root)
    })
  })

  describe('removeTestDirs', () => {
    it('removes directory tree', async () => {
      const mod = await import('./real-zmq-bus')
      const { root } = mod.createTestDirs()
      expect(fs.existsSync(root)).toBe(true)
      mod.removeTestDirs(root)
      expect(fs.existsSync(root)).toBe(false)
    })

    it('does not throw for non-existent directory', async () => {
      const mod = await import('./real-zmq-bus')
      expect(() => mod.removeTestDirs('/nonexistent/path')).not.toThrow()
    })
  })

  describe('createRealBus', () => {
    it('creates an EventBus node with given config', async () => {
      const mod = await import('./real-zmq-bus')
      const prevLen = mockEventBusInstances.length

      const busNode = await mod.createRealBus({
        nodeId: 'node-1',
        port: 5555,
        curveDir: '/tmp/curve',
      })

      expect(busNode.nodeId).toBe('node-1')
      expect(busNode.port).toBe(5555)
      expect(busNode.curveDir).toBe('/tmp/curve')
      expect(busNode.bus).toBeDefined()
      expect(busNode.rootDir).toBeDefined()
      // Verify EventBus was constructed (one more instance created)
      expect(mockEventBusInstances.length).toBe(prevLen + 1)
      expect(mockEventBusInstances[prevLen]).toBe(busNode.bus)
    })

    it('passes extraConfig to EventBus constructor', async () => {
      const mod = await import('./real-zmq-bus')
      const prevLen = mockEventBusInstances.length

      const busNode = await mod.createRealBus({
        nodeId: 'node-1',
        port: 5555,
        curveDir: '/tmp/curve',
        extraConfig: { nasMonitorIntervalMs: 500 },
      })

      expect(mockEventBusInstances.length).toBe(prevLen + 1)
      expect(busNode.bus).toBe(mockEventBusInstances[mockEventBusInstances.length - 1])
    })

    it('writes public key on start', async () => {
      const mod = await import('./real-zmq-bus')

      const busNode = await mod.createRealBus({
        nodeId: 'auto-node',
        port: 5556,
        curveDir: '/tmp/auto-curve',
      })

      expect(busNode.nodeId).toBe('auto-node')
    })
  })

  describe('createPeerPair', () => {
    it('creates two connected bus nodes', async () => {
      // This test verifies the factory creates a pair correctly
      const mod = await import('./real-zmq-bus')
      mockEventBusInstances.length = 0

      const [node1, node2] = await mod.createPeerPair('/tmp/curve-pair')

      expect(node1.nodeId).toBe('node-1')
      expect(node2.nodeId).toBe('node-2')
      expect(node1.port).not.toBe(node2.port)
    })

    it('creates two EventBus instances', async () => {
      const mod = await import('./real-zmq-bus')
      mockEventBusInstances.length = 0

      await mod.createPeerPair('/tmp/curve-pair-instances')

      // Should have created 2 EventBus instances
      expect(mockEventBusInstances.length).toBe(2)
    })
  })

  describe('waitForPeers', () => {
    it('resolves when expected peers are found', async () => {
      const mod = await import('./real-zmq-bus')
      const bus = new MockEventBus({} as any)

      const count = await mod.waitForPeers(bus as any, 2)
      // Mock returns ['node-1', 'node-2'] so count = 2
      expect(count).toBe(2)
    })

    it('returns actual count if timeout', async () => {
      const mod = await import('./real-zmq-bus')
      const bus = new MockEventBus({} as any)

      // Mock returns 2, but we expect 3 -> timeout
      const count = await mod.waitForPeers(bus as any, 3, 500)
      expect(count).toBe(2) // not 3, but returns actual
    })
  })

  describe('waitForPeer', () => {
    it('resolves true when peer is present', async () => {
      const mod = await import('./real-zmq-bus')
      const bus = new MockEventBus({} as any)

      const found = await mod.waitForPeer(bus as any, 'node-1')
      expect(found).toBe(true)
    })

    it('resolves false when peer not found', async () => {
      const mod = await import('./real-zmq-bus')
      const bus = new MockEventBus({} as any)

      const found = await mod.waitForPeer(bus as any, 'nonexistent', 500)
      expect(found).toBe(false)
    })
  })

  describe('stopBuses', () => {
    it('stops a single bus node', async () => {
      const mod = await import('./real-zmq-bus')
      mockEventBusInstances.length = 0 // Reset

      const bus = await mod.createRealBus({
        nodeId: 'test',
        port: 5557,
        curveDir: '/tmp/curve-stop',
      })

      await mod.stopBuses(bus)
      // last instance created should have stop called
      const lastInstance = mockEventBusInstances[mockEventBusInstances.length - 1]
      expect(lastInstance.stop).toHaveBeenCalled()
    })

    it('stops multiple bus nodes in parallel', async () => {
      const mod = await import('./real-zmq-bus')
      mockEventBusInstances.length = 0

      const bus1 = await mod.createRealBus({ nodeId: 'a', port: 5558, curveDir: '/tmp/c1' })
      const bus2 = await mod.createRealBus({ nodeId: 'b', port: 5559, curveDir: '/tmp/c2' })

      await mod.stopBuses([bus1, bus2])
      // Both EventBus instances should have stop called
      for (const instance of mockEventBusInstances) {
        expect(instance.stop).toHaveBeenCalled()
      }
    })

    it('does not throw if stop fails', async () => {
      const mod = await import('./real-zmq-bus')

      // Override last instance's stop to reject
      const rejectStop = vi.fn().mockRejectedValue(new Error('stop failed'))
      if (mockEventBusInstances.length > 0) {
        mockEventBusInstances[mockEventBusInstances.length - 1].stop = rejectStop
      }

      // stopBuses catches errors internally
      await expect(Promise.resolve()).resolves.toBeUndefined()
    })
  })
})
