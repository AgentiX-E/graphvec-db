"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * raft-logic-consensus.spec.ts — RaftLogicConsensus 惰性加载测试
 *
 * 测试策略：
 * RaftLogicConsensus 真实依赖 raft-logic WASM 包（可选依赖）。
 * 测试使用 mock moduleRef 注入来验证逻辑，避免真实 WASM 加载。
 */
const raft_logic_consensus_1 = require("./raft-logic-consensus");
describe('RaftLogicConsensus', () => {
    let config;
    beforeEach(() => {
        config = {
            mode: 'raft-logic',
            nodeId: '1',
            peers: ['2', '3'],
            electionTimeoutMs: 500,
            heartbeatIntervalMs: 100,
        };
    });
    describe('construction', () => {
        it('should create without moduleRef', () => {
            const consensus = new raft_logic_consensus_1.RaftLogicConsensus(config);
            expect(consensus).toBeDefined();
            expect(consensus._isLoaded()).toBe(false);
            expect(consensus._getLoadError()).toBeNull();
        });
        it('should create with moduleRef', () => {
            const mockModule = {
                RaftNode: jest.fn(),
                SqliteStorage: jest.fn(),
                InMemoryTransport: jest.fn(),
                ready: Promise.resolve(),
            };
            const consensus = new raft_logic_consensus_1.RaftLogicConsensus(config, mockModule);
            expect(consensus).toBeDefined();
            expect(consensus._isLoaded()).toBe(false); // not loaded until init()
        });
    });
    describe('init with mock module', () => {
        it('should load mock module on init', async () => {
            const mockModule = {
                RaftNode: jest.fn(),
                SqliteStorage: jest.fn(),
                InMemoryTransport: jest.fn(),
                ready: Promise.resolve(),
            };
            const consensus = new raft_logic_consensus_1.RaftLogicConsensus(config, mockModule);
            expect(consensus._isLoaded()).toBe(false);
            await consensus.init();
            expect(consensus._isLoaded()).toBe(true);
            expect(consensus._getLoadError()).toBeNull();
        });
        it('should auto-init on start with mock module', async () => {
            const mockModule = {
                RaftNode: jest.fn().mockImplementation(() => ({
                    start: jest.fn().mockResolvedValue(undefined),
                    stop: jest.fn().mockResolvedValue(undefined),
                    clientRequest: jest.fn().mockResolvedValue({ ok: true }),
                    readIndex: jest.fn().mockResolvedValue(undefined),
                    status: jest.fn().mockReturnValue({ role: 'leader', leaderId: '1', term: 1 }),
                    waitForLeaderStable: jest.fn().mockResolvedValue(undefined),
                })),
                SqliteStorage: jest.fn().mockImplementation(() => ({
                    open: jest.fn().mockResolvedValue(undefined),
                })),
                InMemoryTransport: jest.fn(),
                ready: Promise.resolve(),
            };
            const consensus = new raft_logic_consensus_1.RaftLogicConsensus(config, mockModule);
            await consensus.start();
            expect(consensus._isLoaded()).toBe(true);
        });
    });
    describe('start/stop with mock module', () => {
        it('should start and stop without error', async () => {
            const mockModule = {
                RaftNode: jest.fn().mockImplementation(() => ({
                    start: jest.fn().mockResolvedValue(undefined),
                    stop: jest.fn().mockResolvedValue(undefined),
                    status: jest.fn().mockReturnValue({ role: 'follower', leaderId: null, term: 0 }),
                })),
                SqliteStorage: jest.fn().mockImplementation(() => ({
                    open: jest.fn().mockResolvedValue(undefined),
                })),
                InMemoryTransport: jest.fn(),
                ready: Promise.resolve(),
            };
            const consensus = new raft_logic_consensus_1.RaftLogicConsensus(config, mockModule);
            await consensus.start();
            // started — no error
            await consensus.stop();
            // stopped — no error
        });
        it('should handle double stop gracefully', async () => {
            const mockModule = {
                RaftNode: jest.fn().mockImplementation(() => ({
                    start: jest.fn().mockResolvedValue(undefined),
                    stop: jest.fn().mockResolvedValue(undefined),
                    status: jest.fn().mockReturnValue({ role: 'follower', leaderId: null, term: 0 }),
                })),
                SqliteStorage: jest.fn().mockImplementation(() => ({
                    open: jest.fn().mockResolvedValue(undefined),
                })),
                InMemoryTransport: jest.fn(),
                ready: Promise.resolve(),
            };
            const consensus = new raft_logic_consensus_1.RaftLogicConsensus(config, mockModule);
            await consensus.start();
            await consensus.stop();
            await consensus.stop(); // double stop
        });
    });
    describe('without module (raft-logic not installed)', () => {
        it('should init without error but not load module', async () => {
            const consensus = new raft_logic_consensus_1.RaftLogicConsensus(config);
            await consensus.init();
            // Without mock module, import('raft-logic') will fail
            // but init() catches the error and saves it
            expect(consensus._isLoaded()).toBe(false);
            expect(consensus._getLoadError()).not.toBeNull();
            expect(consensus._getLoadError().message).toContain('raft-logic is not installed');
        });
        it('should throw on start without module', async () => {
            const consensus = new raft_logic_consensus_1.RaftLogicConsensus(config);
            await expect(consensus.start()).rejects.toThrow(/raft-logic is not installed/);
        });
    });
    describe('propose with mock module', () => {
        it('should propose successfully', async () => {
            const mockModule = {
                RaftNode: jest.fn().mockImplementation(() => ({
                    start: jest.fn().mockResolvedValue(undefined),
                    stop: jest.fn().mockResolvedValue(undefined),
                    clientRequest: jest.fn().mockResolvedValue({ ok: true }),
                    status: jest.fn().mockReturnValue({ role: 'leader', leaderId: '1', term: 1 }),
                })),
                SqliteStorage: jest.fn().mockImplementation(() => ({
                    open: jest.fn().mockResolvedValue(undefined),
                })),
                InMemoryTransport: jest.fn(),
                ready: Promise.resolve(),
            };
            const consensus = new raft_logic_consensus_1.RaftLogicConsensus(config, mockModule);
            await consensus.start();
            const result = await consensus.propose(Buffer.from('test-data'));
            expect(result.ok).toBe(true);
        });
        it('should return ok=false from not started consensus', async () => {
            const consensus = new raft_logic_consensus_1.RaftLogicConsensus(config);
            const result = await consensus.propose(Buffer.from('test'));
            expect(result.ok).toBe(false);
        });
        it('should return ok=false when clientRequest rejects', async () => {
            const mockModule = {
                RaftNode: jest.fn().mockImplementation(() => ({
                    start: jest.fn().mockResolvedValue(undefined),
                    stop: jest.fn().mockResolvedValue(undefined),
                    clientRequest: jest.fn().mockRejectedValue(new Error('request failed')),
                    status: jest.fn().mockReturnValue({ role: 'follower', leaderId: null, term: 0 }),
                })),
                SqliteStorage: jest.fn().mockImplementation(() => ({
                    open: jest.fn().mockResolvedValue(undefined),
                })),
                InMemoryTransport: jest.fn(),
                ready: Promise.resolve(),
            };
            const consensus = new raft_logic_consensus_1.RaftLogicConsensus(config, mockModule);
            await consensus.start();
            const result = await consensus.propose(Buffer.from('test'));
            expect(result.ok).toBe(false);
        });
    });
    describe('getRole', () => {
        it('should return follower when not started', () => {
            const consensus = new raft_logic_consensus_1.RaftLogicConsensus(config);
            expect(consensus.getRole()).toBe('follower');
        });
        it('should return role from raft node status', async () => {
            const mockModule = {
                RaftNode: jest.fn().mockImplementation(() => ({
                    start: jest.fn().mockResolvedValue(undefined),
                    stop: jest.fn().mockResolvedValue(undefined),
                    status: jest.fn().mockReturnValue({ role: 'leader', leaderId: '1', term: 2 }),
                })),
                SqliteStorage: jest.fn().mockImplementation(() => ({
                    open: jest.fn().mockResolvedValue(undefined),
                })),
                InMemoryTransport: jest.fn(),
                ready: Promise.resolve(),
            };
            const consensus = new raft_logic_consensus_1.RaftLogicConsensus(config, mockModule);
            await consensus.start();
            expect(consensus.getRole()).toBe('leader');
        });
    });
    describe('getLeaderId / getTerm', () => {
        it('should return null for leader when not started', () => {
            const consensus = new raft_logic_consensus_1.RaftLogicConsensus(config);
            expect(consensus.getLeaderId()).toBeNull();
        });
        it('should return 0 for term when not started', () => {
            const consensus = new raft_logic_consensus_1.RaftLogicConsensus(config);
            expect(consensus.getTerm()).toBe(0);
        });
        it('should return values from status', async () => {
            const mockModule = {
                RaftNode: jest.fn().mockImplementation(() => ({
                    start: jest.fn().mockResolvedValue(undefined),
                    stop: jest.fn().mockResolvedValue(undefined),
                    status: jest.fn().mockReturnValue({ role: 'leader', leaderId: '42', term: 7 }),
                })),
                SqliteStorage: jest.fn().mockImplementation(() => ({
                    open: jest.fn().mockResolvedValue(undefined),
                })),
                InMemoryTransport: jest.fn(),
                ready: Promise.resolve(),
            };
            const consensus = new raft_logic_consensus_1.RaftLogicConsensus(config, mockModule);
            await consensus.start();
            expect(consensus.getLeaderId()).toBe('42');
            expect(consensus.getTerm()).toBe(7);
        });
    });
    describe('setApply', () => {
        it('should accept apply callback', () => {
            const consensus = new raft_logic_consensus_1.RaftLogicConsensus(config);
            const fn = jest.fn();
            expect(() => consensus.setApply(fn)).not.toThrow();
        });
    });
    describe('readIndex', () => {
        it('should not throw when not started', async () => {
            const consensus = new raft_logic_consensus_1.RaftLogicConsensus(config);
            await expect(consensus.readIndex()).resolves.toBeUndefined();
        });
        it('should call readIndex on raft node when started', async () => {
            const readIndexFn = jest.fn().mockResolvedValue(undefined);
            const mockModule = {
                RaftNode: jest.fn().mockImplementation(() => ({
                    start: jest.fn().mockResolvedValue(undefined),
                    stop: jest.fn().mockResolvedValue(undefined),
                    readIndex: readIndexFn,
                    status: jest.fn().mockReturnValue({ role: 'follower', leaderId: null, term: 0 }),
                })),
                SqliteStorage: jest.fn().mockImplementation(() => ({
                    open: jest.fn().mockResolvedValue(undefined),
                })),
                InMemoryTransport: jest.fn(),
                ready: Promise.resolve(),
            };
            const consensus = new raft_logic_consensus_1.RaftLogicConsensus(config, mockModule);
            await consensus.start();
            await consensus.readIndex();
            expect(readIndexFn).toHaveBeenCalled();
        });
    });
    describe('waitForLeader', () => {
        it('should throw when not started', async () => {
            const consensus = new raft_logic_consensus_1.RaftLogicConsensus(config);
            await expect(consensus.waitForLeader()).rejects.toThrow('RaftLogicConsensus not started');
        });
        it('should resolve when leader is elected', async () => {
            const mockModule = {
                RaftNode: jest.fn().mockImplementation(() => ({
                    start: jest.fn().mockResolvedValue(undefined),
                    stop: jest.fn().mockResolvedValue(undefined),
                    waitForLeaderStable: jest.fn().mockResolvedValue(undefined),
                    status: jest.fn().mockReturnValue({ role: 'leader', leaderId: '1', term: 1 }),
                })),
                SqliteStorage: jest.fn().mockImplementation(() => ({
                    open: jest.fn().mockResolvedValue(undefined),
                })),
                InMemoryTransport: jest.fn(),
                ready: Promise.resolve(),
            };
            const consensus = new raft_logic_consensus_1.RaftLogicConsensus(config, mockModule);
            await consensus.start();
            await expect(consensus.waitForLeader()).resolves.toBeUndefined();
        });
    });
});
//# sourceMappingURL=raft-logic-consensus.spec.js.map