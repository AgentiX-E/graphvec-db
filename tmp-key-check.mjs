// Check data keys without type-checking the import
// Just check what keys ClassicLevelStorage puts for edges
import { ClassicLevelStorageProvider } from "./src/core/storage-classic-level.ts";

const s = new ClassicLevelStorageProvider();
const { PREFIX_EDGE_OUT, PREFIX_EDGE_IN } = s as any;

// Store edge 0->1 type 0
s.putEdge(0, 1, 0, new Date().getTime());

// Now check internal data
const data = (s as any)._data;
const outKey = PREFIX_EDGE_OUT + 0 + ':0:' + 1;
const inKey = PREFIX_EDGE_IN + 1 + ':0:' + 0;

console.log("out key matches:", data.get(outKey) !== undefined);
console.log("in key matches:", data.get(inKey) !== undefined);
console.log("Total keys:", [...data.keys()].filter(k => k.startsWith('e:')).length);
console.log("Keys:", [...data.keys()].filter(k => k.startsWith('e:')));
