type AsyncIteratorResult<T> = { done: boolean; value?: T }

const createMockSocket = () => ({
  bind: jest.fn().mockResolvedValue(undefined),
  connect: jest.fn().mockResolvedValue(undefined),
  subscribe: jest.fn(),
  close: jest.fn(),
  send: jest.fn().mockResolvedValue(undefined),
})

export class Publisher {
  bind: jest.Mock
  connect: jest.Mock
  close: jest.Mock
  send: jest.Mock
  constructor() {
    const mock = createMockSocket()
    this.bind = mock.bind
    this.connect = mock.connect
    this.close = mock.close
    this.send = mock.send
  }
}

export class Subscriber {
  connect: jest.Mock
  subscribe: jest.Mock
  close: jest.Mock
  [Symbol.asyncIterator]!: () => AsyncIterator<unknown>
  constructor() {
    const mock = createMockSocket()
    this.connect = mock.connect
    this.subscribe = mock.subscribe
    this.close = mock.close
    this[Symbol.asyncIterator] = () => ({
      next: jest.fn().mockResolvedValue({ done: true } as AsyncIteratorResult<unknown>),
    })
  }
}
