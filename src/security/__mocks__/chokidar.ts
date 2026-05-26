// ============================================================
// chokidar mock — 用于 jest 测试
//
// chokidar 是 ESM-only 包，jest/ts-jest 无法直接
// 在 CommonJS 模式下加载。此 mock 替代了真实实现，
// 支持测试热加载功能。
// ============================================================

class MockFSWatcher {
  private _listeners: Map<string, Set<(...args: any[]) => void>> = new Map()
  private _closed = false

  on(event: string, listener: (...args: any[]) => void): this {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set())
    }
    this._listeners.get(event)!.add(listener)
    return this
  }

  /** 模拟文件变更事件 */
  _emitChange(...args: any[]): void {
    if (this._closed) return
    const handlers = this._listeners.get('change')
    if (handlers) {
      for (const h of handlers) {
        h(...args)
      }
    }
  }

  /** 模拟错误事件 */
  _emitError(err: Error): void {
    const handlers = this._listeners.get('error')
    if (handlers) {
      for (const h of handlers) {
        h(err)
      }
    }
  }

  async close(): Promise<void> {
    this._closed = true
    this._listeners.clear()
  }
}

const watch = (paths: string | string[], _options?: any): MockFSWatcher => {
  return new MockFSWatcher()
}

export { MockFSWatcher, watch }
export default { FSWatcher: MockFSWatcher, watch }
