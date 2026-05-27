import { describe, it, expect, vi } from 'vitest'
import { AppHeartbeatManager } from './app-heartbeat-manager'

function makePeers(ids: string[]): Array<{ nodeId: string; addr: string }> {
  return ids.map(id => ({
    nodeId: id,
    addr: `tcp://127.0.0.1:${3000 + Number(id.slice(-1))}`,
  }))
}

describe('isolated suspect test 2', () => {
  it('should return correct counts with suspects - V2', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000000000000)

    const transport = {
      send: async () => {},
    }
    const mgr = new AppHeartbeatManager({
      nodeId: 'node-1',
      peers: makePeers(['node-1', 'node-2', 'node-3']),
      transport,
      pingIntervalMs: 100,
      suspectThreshold: 3,
      recoveryThreshold: 3,
      onMajorityChange: () => {},
    })

    mgr.start()

    // Call directly - test that _tick sets suspect
    // Actually we know from debug-trace that advanceTimersByTimeAsync works
    await vi.advanceTimersByTimeAsync(400)
    
    const stats = mgr.getStats()
    console.log('stats:', stats)
    console.log('suspects:', Array.from(mgr.getSuspects().entries()))
    console.log('time now:', Date.now())

    expect(stats.suspect).toBe(2)
    
    vi.useRealTimers()
  })

  it('should detect suspect after suspectThreshold - direct call', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000000000000)

    const transport = { send: async () => {} }
    const mgr = new AppHeartbeatManager({
      nodeId: 'node-1',
      peers: makePeers(['node-1', 'node-2']),
      transport,
      pingIntervalMs: 100,
      suspectThreshold: 3,
      recoveryThreshold: 3,
      onMajorityChange: () => {},
    })

    mgr.start()

    // Instead of relying on interval, call sendPings after advancing system time
    // This simulates what _tick does internally
    
    // First, advance system time by 350ms (past 300ms threshold)
    vi.setSystemTime(Date.now() + 350)
    
    // Now call sendPings - but this only sends, doesn't check timeout.
    // The timeout check is in _tick after sendPings.
    // Let's just manually verify that advancing Date.now() works
    console.log('Date.now() after +350:', Date.now())
    
    // Hmm, sendPings doesn't check timeout. _tick does.
    // We can only trigger suspect by letting _tick run via interval.
    
    // Actually, let's try the approach of calling _tick() indirectly
    // by advancing the interval timer
    
    await vi.advanceTimersByTimeAsync(0) // Process any pending microtasks first
    console.log('Ping cycle 0:', mgr.getStats())
    
    // Clear the interval based on real time...
    // The setInterval created during start() with interval 100ms
    // Each call to _tick checks elapsed = Date.now() - lastReceived
    
    // With vi.useFakeTimers, the interval fires at fake interval rates
    // But the Date.now() is also faked via vi.setSystemTime
    // They should be in sync
    
    await vi.advanceTimersByTimeAsync(100)
    console.log('Ping at 100ms:', mgr.getStats(), 'time:', Date.now())
    
    await vi.advanceTimersByTimeAsync(100)
    console.log('Ping at 200ms:', mgr.getStats(), 'time:', Date.now())
    
    await vi.advanceTimersByTimeAsync(100) 
    console.log('Ping at 300ms:', mgr.getStats(), 'time:', Date.now(), 'elapsed:', Date.now() - 1000000000000)
    
    await vi.advanceTimersByTimeAsync(50)
    console.log('Ping at 350ms:', mgr.getStats(), 'time:', Date.now(), 'elapsed:', Date.now() - 1000000000000)
    
    const suspects = mgr.getSuspects()
    console.log('suspects:', Array.from(suspects.entries()))
    expect(suspects.get('node-2')).toBe(true)
    
    vi.useRealTimers()
  })
})
