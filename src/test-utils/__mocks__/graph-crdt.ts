class Graph {
  private state: Record<string, any> = {}

  merge(change: any): any {
    if (change?.nodes) {
      Object.assign(this.state, change.nodes)
    }
    return change
  }

  delta(): any {
    const result = { nodes: { ...this.state } }
    return result
  }

  getState(): Record<string, any> {
    return { ...this.state }
  }

  clear(): void {
    this.state = {}
  }
}

export default Graph
