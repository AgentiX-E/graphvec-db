"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * mock-timer.spec.ts — MockTimer 虚拟时钟测试
 */
const mock_timer_1 = require("./mock-timer");
describe('MockTimer', () => {
    let timer;
    beforeEach(() => {
        timer = new mock_timer_1.MockTimer();
    });
    describe('setTimeout / clearTimeout', () => {
        it('should return a unique id for each setTimeout call', () => {
            const id1 = timer.setTimeout(() => { }, 100);
            const id2 = timer.setTimeout(() => { }, 200);
            expect(id1).not.toBe(id2);
            expect(id1).toBeGreaterThan(0);
            expect(id2).toBeGreaterThan(0);
        });
        it('should not fire before the deadline', () => {
            const fn = jest.fn();
            timer.setTimeout(fn, 100);
            expect(fn).not.toHaveBeenCalled();
        });
        it('should fire when advanceTime reaches the deadline', () => {
            const fn = jest.fn();
            timer.setTimeout(fn, 100);
            timer.advanceTimeBy(100);
            expect(fn).toHaveBeenCalledTimes(1);
        });
        it('should not fire after clearTimeout', () => {
            const fn = jest.fn();
            const id = timer.setTimeout(fn, 100);
            timer.clearTimeout(id);
            timer.advanceTimeBy(200);
            expect(fn).not.toHaveBeenCalled();
        });
        it('should clearTimeout be idempotent', () => {
            const fn = jest.fn();
            const id = timer.setTimeout(fn, 100);
            timer.clearTimeout(id);
            timer.clearTimeout(id); // second clear
            timer.advanceTimeBy(200);
            expect(fn).not.toHaveBeenCalled();
        });
        it('should clearTimeout on non-existent id not throw', () => {
            expect(() => timer.clearTimeout(999)).not.toThrow();
        });
    });
    describe('advanceTimeBy', () => {
        it('should advance current time', () => {
            expect(timer.currentTime).toBe(0);
            timer.advanceTimeBy(500);
            expect(timer.currentTime).toBe(500);
        });
        it('should fire multiple timeouts in order', () => {
            const order = [];
            timer.setTimeout(() => order.push(1), 50);
            timer.setTimeout(() => order.push(2), 100);
            timer.setTimeout(() => order.push(3), 150);
            timer.advanceTimeBy(200);
            expect(order).toEqual([1, 2, 3]);
        });
        it('should fire timeouts at exact deadlines', () => {
            const timestamps = [];
            timer.setTimeout(() => timestamps.push(timer.currentTime), 100);
            timer.setTimeout(() => timestamps.push(timer.currentTime), 200);
            timer.advanceTimeBy(300);
            expect(timestamps).toEqual([100, 200]);
        });
        it('should handle zero ms timeout', () => {
            const fn = jest.fn();
            timer.setTimeout(fn, 0);
            timer.advanceTimeBy(0);
            expect(fn).toHaveBeenCalledTimes(1);
        });
        it('should skip timeouts that are not yet due', () => {
            const fn = jest.fn();
            timer.setTimeout(fn, 200);
            timer.advanceTimeBy(100); // not yet due
            expect(fn).not.toHaveBeenCalled();
        });
        it('should fire all due timeouts when advancing past multiple deadlines', () => {
            const fn1 = jest.fn();
            const fn2 = jest.fn();
            const fn3 = jest.fn();
            timer.setTimeout(fn1, 100);
            timer.setTimeout(fn2, 200);
            timer.setTimeout(fn3, 300);
            timer.advanceTimeBy(500);
            expect(fn1).toHaveBeenCalledTimes(1);
            expect(fn2).toHaveBeenCalledTimes(1);
            expect(fn3).toHaveBeenCalledTimes(1);
        });
        it('should handle callbacks that register new timeouts', () => {
            const fn = jest.fn();
            timer.setTimeout(() => {
                fn();
                timer.setTimeout(() => fn(), 50);
            }, 100);
            timer.advanceTimeBy(150);
            // First callback fires at 100, registers new 50ms from NOW(=100) → 150
            // advanceTimeBy(150) should catch the new one at 150
            expect(fn).toHaveBeenCalledTimes(2);
        });
    });
    describe('setInterval / clearInterval', () => {
        it('should fire interval repeatedly', () => {
            const fn = jest.fn();
            timer.setInterval(fn, 100);
            timer.advanceTimeBy(100);
            expect(fn).toHaveBeenCalledTimes(1);
            timer.advanceTimeBy(100);
            expect(fn).toHaveBeenCalledTimes(2);
        });
        it('should fire multiple times when advancing past multiple intervals', () => {
            const fn = jest.fn();
            timer.setInterval(fn, 100);
            timer.advanceTimeBy(500);
            // Fires at 100, 200, 300, 400, 500 = 5 times
            expect(fn).toHaveBeenCalledTimes(5);
        });
        it('should stop firing after clearInterval', () => {
            const fn = jest.fn();
            const id = timer.setInterval(fn, 100);
            timer.advanceTimeBy(200);
            expect(fn).toHaveBeenCalledTimes(2);
            timer.clearInterval(id);
            timer.advanceTimeBy(500);
            expect(fn).toHaveBeenCalledTimes(2); // no more calls
        });
        it('should clearInterval on non-existent id not throw', () => {
            expect(() => timer.clearInterval(999)).not.toThrow();
        });
    });
    describe('runAll', () => {
        it('should execute all pending timeouts', () => {
            const fn = jest.fn();
            timer.setTimeout(fn, 100);
            timer.setTimeout(fn, 200);
            timer.runAll();
            expect(fn).toHaveBeenCalledTimes(2);
            expect(timer.currentTime).toBe(200); // advanced to last deadline
        });
        it('should not affect already-cleared timeouts', () => {
            const fn = jest.fn();
            const id = timer.setTimeout(() => {
                fn();
                timer.clearTimeout(id);
            }, 100);
            timer.runAll();
            expect(fn).toHaveBeenCalledTimes(1);
        });
    });
    describe('reset', () => {
        it('should clear all timeouts', () => {
            const fn = jest.fn();
            timer.setTimeout(fn, 100);
            timer.reset();
            timer.advanceTimeBy(1000);
            expect(fn).not.toHaveBeenCalled();
        });
        it('should reset currentTime to 0', () => {
            timer.advanceTimeBy(500);
            timer.reset();
            expect(timer.currentTime).toBe(0);
        });
        it('should clear intervals', () => {
            const fn = jest.fn();
            timer.setInterval(fn, 100);
            timer.reset();
            timer.advanceTimeBy(1000);
            expect(fn).not.toHaveBeenCalled();
        });
    });
});
describe('RealTimer', () => {
    let realTimer;
    beforeEach(() => {
        realTimer = new mock_timer_1.RealTimer();
    });
    afterEach(() => {
        jest.useRealTimers();
    });
    it('should have same interface as MockTimer', () => {
        expect(typeof realTimer.setTimeout).toBe('function');
        expect(typeof realTimer.clearTimeout).toBe('function');
        expect(typeof realTimer.setInterval).toBe('function');
        expect(typeof realTimer.clearInterval).toBe('function');
    });
    it('should use real setTimeout (measure with jest fake timers)', () => {
        jest.useFakeTimers();
        const fn = jest.fn();
        realTimer.setTimeout(fn, 100);
        jest.advanceTimersByTime(100);
        expect(fn).toHaveBeenCalledTimes(1);
    });
    it('should clearTimeout with real timers', () => {
        jest.useFakeTimers();
        const fn = jest.fn();
        const id = realTimer.setTimeout(fn, 100);
        realTimer.clearTimeout(id);
        jest.advanceTimersByTime(200);
        expect(fn).not.toHaveBeenCalled();
    });
});
//# sourceMappingURL=mock-timer.spec.js.map