"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Subscriber = exports.Publisher = void 0;
const createMockSocket = () => ({
    bind: jest.fn().mockResolvedValue(undefined),
    connect: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn(),
    close: jest.fn(),
    send: jest.fn().mockResolvedValue(undefined),
});
class Publisher {
    bind;
    connect;
    close;
    send;
    constructor() {
        const mock = createMockSocket();
        this.bind = mock.bind;
        this.connect = mock.connect;
        this.close = mock.close;
        this.send = mock.send;
    }
}
exports.Publisher = Publisher;
class Subscriber {
    connect;
    subscribe;
    close;
    [Symbol.asyncIterator];
    constructor() {
        const mock = createMockSocket();
        this.connect = mock.connect;
        this.subscribe = mock.subscribe;
        this.close = mock.close;
        this[Symbol.asyncIterator] = () => ({
            next: jest.fn().mockResolvedValue({ done: true }),
        });
    }
}
exports.Subscriber = Subscriber;
//# sourceMappingURL=zeromq.js.map