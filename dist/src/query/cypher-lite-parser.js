"use strict";
/**
 * cypher-lite-parser.ts — Wrapper for the Peggy-generated parser
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parser = void 0;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const peggy = require('./cypher-lite-parser-gen.js');
exports.parser = {
    parse(input) {
        return peggy.parse(input);
    },
};
//# sourceMappingURL=cypher-lite-parser.js.map