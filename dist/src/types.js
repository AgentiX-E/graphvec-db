"use strict";
// ============================================================
// AgentiX GraphVec — 全局共享类型定义
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthError = exports.Role = exports.NodeType = exports.EdgeType = void 0;
var EdgeType;
(function (EdgeType) {
    EdgeType[EdgeType["RELATED"] = 10] = "RELATED";
    EdgeType[EdgeType["DEPENDS_ON"] = 11] = "DEPENDS_ON";
    EdgeType[EdgeType["REFERENCES"] = 12] = "REFERENCES";
    EdgeType[EdgeType["HAS_PROPERTY"] = 13] = "HAS_PROPERTY";
    EdgeType[EdgeType["SEQUENCE"] = 14] = "SEQUENCE";
    EdgeType[EdgeType["USER_DEFINED"] = 100] = "USER_DEFINED";
})(EdgeType || (exports.EdgeType = EdgeType = {}));
var NodeType;
(function (NodeType) {
    NodeType[NodeType["GENERIC"] = 1] = "GENERIC";
    NodeType[NodeType["USER"] = 2] = "USER";
    NodeType[NodeType["AGENT"] = 3] = "AGENT";
    NodeType[NodeType["CONVERSATION"] = 4] = "CONVERSATION";
    NodeType[NodeType["DOCUMENT"] = 5] = "DOCUMENT";
    NodeType[NodeType["ENTITY"] = 6] = "ENTITY";
    NodeType[NodeType["USER_DEFINED"] = 100] = "USER_DEFINED";
})(NodeType || (exports.NodeType = NodeType = {}));
// ──────────────────────────────────────────
// 安全类型
// ──────────────────────────────────────────
var Role;
(function (Role) {
    Role["ADMIN"] = "admin";
    Role["READER"] = "reader";
    Role["WRITER"] = "writer";
    Role["OPERATOR"] = "operator";
})(Role || (exports.Role = Role = {}));
class AuthError extends Error {
    statusCode;
    constructor(message, statusCode = 401) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'AuthError';
    }
}
exports.AuthError = AuthError;
//# sourceMappingURL=types.js.map