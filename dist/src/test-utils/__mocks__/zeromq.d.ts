export declare class Publisher {
    bind: jest.Mock;
    connect: jest.Mock;
    close: jest.Mock;
    send: jest.Mock;
    constructor();
}
export declare class Subscriber {
    connect: jest.Mock;
    subscribe: jest.Mock;
    close: jest.Mock;
    [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
    constructor();
}
//# sourceMappingURL=zeromq.d.ts.map