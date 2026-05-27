/**
 * Integration tests for R18: ZMQ dealer connection readiness probe.
 *
 * Design:
 *   Before sending Outbox messages, PerPeerWorker checks whether the ZMQ
 *   DEALER connection to the peer is actually ready via isPeerReady().
 *   Currently it only checks if the peer's .pub key file exists (post-failure
 *   detection). This test verifies the pre-send probe.
 *
 * Requirements:
 *   R18.1: Initial state with .pub files → peer is ready
 *   R18.2: Remove .pub file → probe returns not ready
 *   R18.3: Re-add .pub file → probe returns ready
 *   R18.4: Recent successful send (< 30s) skips file probe
 *
 * See: temp/code-design-audit-final.md §R18, Execution Plan §3.1
 *
 * Patterns:
 *   - import (not require)
 *   - async/await (not done())
 *   - Independent temp dirs (not shared state)
 *   - Cleanup in finally blocks
 *   - TestTimeout: 30000
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { OutboxReplicationManager } from '../../src/core/outbox-replication'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(label: string): string {
  const ts = Date.now()
  return path.join('/tmp', `agentiX-readiness-${label}-${ts}`)
}

function cleanDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}

function writePubKey(curveDir: string, nodeId: string, port: number, key: string): void {
  const filePath = path.join(curveDir, `${nodeId}_${port}.pub`)
  fs.writeFileSync(filePath, key, 'utf-8')
}

function removePubKey(curveDir: string, nodeId: string, port: number): void {
  const filePath = path.join(curveDir, `${nodeId}_${port}.pub`)
  try { fs.unlinkSync(filePath) } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('R18: ZMQ dealer connection readiness probe', () => {

  it('R18.1: Initially both peers have .pub files → both ready', async () => {
    const baseDir = tmpDir('r181')
    const curveDir = path.join(baseDir, 'curve')
    fs.mkdirSync(curveDir, { recursive: true })

    // Create .pub files for both peers
    writePubKey(curveDir, 'peer-a', 5555, 'PUBKEY_A')
    writePubKey(curveDir, 'peer-b', 5556, 'PUBKEY_B')

    const rm = new OutboxReplicationManager({
      nodeId: 'self-node',
      peers: [
        { nodeId: 'peer-a', addr: 'inproc://peer-a' },
        { nodeId: 'peer-b', addr: 'inproc://peer-b' },
      ],
      curveDir,
      dbPath: path.join(baseDir, 'outbox.db'),
      tickMs: 100,
      maxBackoffSeconds: 1,
      eventBus: {
        send: async (_peerId: string, _msg: any) => {},
        _recoverDealerByNodeId: async (_peerId: string) => {},
      },
    })

    rm.start()

    try {
      // Give the workers a tick to initialize
      await new Promise(r => setTimeout(r, 200))

      const workerA = rm.getWorker('peer-a')
      const workerB = rm.getWorker('peer-b')

      expect(workerA).toBeDefined()
      expect(workerB).toBeDefined()

      // Both should be ready since .pub files exist
      expect(workerA!.isPeerReady('peer-a')).toBe(true)
      expect(workerB!.isPeerReady('peer-b')).toBe(true)
    } finally {
      rm.stop()
      cleanDir(baseDir)
    }
  }, 30000)

  it('R18.2: Remove one peer\'s .pub file → probe returns not ready', async () => {
    const baseDir = tmpDir('r182')
    const curveDir = path.join(baseDir, 'curve')
    fs.mkdirSync(curveDir, { recursive: true })

    // Create .pub files for both peers initially
    writePubKey(curveDir, 'peer-a', 5555, 'PUBKEY_A')
    writePubKey(curveDir, 'peer-b', 5556, 'PUBKEY_B')

    const rm = new OutboxReplicationManager({
      nodeId: 'self-node',
      peers: [
        { nodeId: 'peer-a', addr: 'inproc://peer-a' },
        { nodeId: 'peer-b', addr: 'inproc://peer-b' },
      ],
      curveDir,
      dbPath: path.join(baseDir, 'outbox.db'),
      tickMs: 100,
      maxBackoffSeconds: 1,
      eventBus: {
        send: async (_peerId: string, _msg: any) => {},
        _recoverDealerByNodeId: async (_peerId: string) => {},
      },
    })

    rm.start()

    try {
      // Let workers start
      await new Promise(r => setTimeout(r, 200))

      const workerA = rm.getWorker('peer-a')
      expect(workerA).toBeDefined()

      // Initially ready
      expect(workerA!.isPeerReady('peer-a')).toBe(true)

      // Remove peer-a's .pub file
      removePubKey(curveDir, 'peer-a', 5555)

      // Also clear the lastSuccessfulSend to force a recheck
      // (simulate no recent success)
      await new Promise(r => setTimeout(r, 50))

      // After removal, probe should return not ready
      expect(workerA!.isPeerReady('peer-a')).toBe(false)
    } finally {
      rm.stop()
      cleanDir(baseDir)
    }
  }, 30000)

  it('R18.3: Re-add .pub file → probe returns ready', async () => {
    const baseDir = tmpDir('r183')
    const curveDir = path.join(baseDir, 'curve')
    fs.mkdirSync(curveDir, { recursive: true })

    // Start with no pub file for peer-a
    writePubKey(curveDir, 'peer-b', 5556, 'PUBKEY_B')

    const rm = new OutboxReplicationManager({
      nodeId: 'self-node',
      peers: [
        { nodeId: 'peer-a', addr: 'inproc://peer-a' },
        { nodeId: 'peer-b', addr: 'inproc://peer-b' },
      ],
      curveDir,
      dbPath: path.join(baseDir, 'outbox.db'),
      tickMs: 100,
      maxBackoffSeconds: 1,
      eventBus: {
        send: async (_peerId: string, _msg: any) => {},
        _recoverDealerByNodeId: async (_peerId: string) => {},
      },
    })

    rm.start()

    try {
      await new Promise(r => setTimeout(r, 200))

      const workerA = rm.getWorker('peer-a')
      expect(workerA).toBeDefined()

      // Without .pub file, peer-a should not be ready
      expect(workerA!.isPeerReady('peer-a')).toBe(false)

      // Re-add peer-a's .pub file
      writePubKey(curveDir, 'peer-a', 5555, 'PUBKEY_A')

      // Now probe should return ready
      expect(workerA!.isPeerReady('peer-a')).toBe(true)
    } finally {
      rm.stop()
      cleanDir(baseDir)
    }
  }, 30000)

  it('R18.4: Recent successful send (< 30s) skips file probe', async () => {
    const baseDir = tmpDir('r184')
    const curveDir = path.join(baseDir, 'curve')
    fs.mkdirSync(curveDir, { recursive: true })

    // Create .pub files initially
    writePubKey(curveDir, 'peer-a', 5555, 'PUBKEY_A')
    writePubKey(curveDir, 'peer-b', 5556, 'PUBKEY_B')

    let sendCalled = false

    const rm = new OutboxReplicationManager({
      nodeId: 'self-node',
      peers: [
        { nodeId: 'peer-a', addr: 'inproc://peer-a' },
        { nodeId: 'peer-b', addr: 'inproc://peer-b' },
      ],
      curveDir,
      dbPath: path.join(baseDir, 'outbox.db'),
      tickMs: 50,
      maxBackoffSeconds: 1,
      batchSize: 100,
      eventBus: {
        send: async (peerId: string, _msg: any) => {
          if (peerId === 'peer-a') {
            sendCalled = true
          }
        },
        batchSend: async (_peerId: string, _msgs: any[]) => {},
        _recoverDealerByNodeId: async (_peerId: string) => {},
      },
    })

    rm.start()

    try {
      await new Promise(r => setTimeout(r, 150))

      const workerA = rm.getWorker('peer-a')
      expect(workerA).toBeDefined()

      // Send a message to set a recent successful send timestamp
      rm.addMessage('node:created', { id: 1, msgId: 'r184-001' })

      // Wait for the send to complete
      await new Promise(r => setTimeout(r, 300))

      // Now remove .pub file
      removePubKey(curveDir, 'peer-a', 5555)

      // isPeerReady should still return true because of recent success (< 30s)
      // Access the private field via isPeerReady public method
      expect(workerA!.isPeerReady('peer-a')).toBe(true)
    } finally {
      rm.stop()
      cleanDir(baseDir)
    }
  }, 30000)
})
