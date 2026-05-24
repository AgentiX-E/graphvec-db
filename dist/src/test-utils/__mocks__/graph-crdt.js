"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class Graph {
    state = {};
    merge(change) {
        if (change?.nodes) {
            Object.assign(this.state, change.nodes);
        }
        return change;
    }
    delta() {
        const result = { nodes: { ...this.state } };
        return result;
    }
    getState() {
        return { ...this.state };
    }
    clear() {
        this.state = {};
    }
}
exports.default = Graph;
//# sourceMappingURL=graph-crdt.js.map