import { ClassicLevelStorageProvider } from "./src/core/storage-classic-level"

const s = new ClassicLevelStorageProvider()
;(s as any)._data.clear()

// Store edge 0->1 type 0
s.upsertEdge(0, 1, 0)

const data = (s as any)._data
const keys = [...data.keys()].filter((k: string) => k.startsWith("e:"))
console.log("Total edge keys:", keys.length)
console.log("Keys:", JSON.stringify(keys))
