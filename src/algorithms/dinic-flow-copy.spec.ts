import { maxFlow } from './dinic-flow'

test('max flow diamond', () => {
  const r = maxFlow([1,2,3,4], [
    {src:1,dst:2,capacity:10},{src:1,dst:3,capacity:10},
    {src:2,dst:4,capacity:10},{src:3,dst:4,capacity:10},
  ], 1, 4)
  expect(r.maxFlow).toBe(20)
})

test('max flow no path', () => {
  const r = maxFlow([1,2,3], [{src:1,dst:2,capacity:5}], 1, 3)
  expect(r.maxFlow).toBe(0)
})

test('max flow source=sink', () => {
  const r = maxFlow([1], [], 1, 1)
  expect(r.maxFlow).toBe(0)
})
