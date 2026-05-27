import { vi } from 'vitest'

type AsyncIteratorResult<T> = { done: boolean; value?: T }

const createMockSocket = () => ({
  bind: vi.fn().mockResolvedValue(undefined),
  connect: vi.fn().mockResolvedValue(undefined),
  subscribe: vi.fn(),
  close: vi.fn(),
  send: vi.fn().mockResolvedValue(undefined),
})

export class Publisher {
  bind: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  constructor() {
    const mock = createMockSocket()
    this.bind = mock.bind
    this.connect = mock.connect
    this.close = mock.close
    this.send = mock.send
  }
}

export class Subscriber {
  connect: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  [Symbol.asyncIterator]!: () => AsyncIterator<unknown>
  constructor() {
    const mock = createMockSocket()
    this.connect = mock.connect
    this.subscribe = mock.subscribe
    this.close = mock.close
    this[Symbol.asyncIterator] = () => ({
      next: vi.fn().mockResolvedValue({ done: true } as AsyncIteratorResult<unknown>),
    })
  }
}

/** Mock Dealer socket — used by EventBus for outbound connections */
export class Dealer {
  connect: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  constructor() {
    const mock = createMockSocket()
    this.connect = mock.connect
    this.close = mock.close
    this.send = mock.send
  }
}

/** Mock Router socket — used by EventBus for inbound connections */
export class Router {
  bind: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  receive: ReturnType<typeof vi.fn>
  constructor() {
    const mock = createMockSocket()
    this.bind = mock.bind
    this.close = mock.close
    this.receive = vi.fn()
  }
}

/** Mock curveKeyPair */
export function curveKeyPair(): { publicKey: string; secretKey: string } {
  return {
    publicKey: 'mock-pub-key-abcdef1234567890abcdef1234567890abcdef1234567890abc',
    secretKey: 'mock-sec-key-abcdef1234567890abcdef1234567890abcdef1234567890abc',
  }
}

// 兼容 require('zeromq')
module.exports = {
  Publisher,
  Subscriber,
  Dealer,
  Router,
  curveKeyPair,
}
