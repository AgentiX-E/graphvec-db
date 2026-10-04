import { parseQuery } from '../src/query/query-parser'
import { _resolveUnwindList } from '../src/query/query-parser'

async function main() {
  const plan = parseQuery(`UNWIND ['a', 'b', 'c'] AS c CREATE ({name: c})`) as any
  const _uwAll = (plan.unwinds?.length ? plan.unwinds : (plan.unwind ? [plan.unwind] : [])) as any[]
  const resolvedLists = _uwAll.map(u => _resolveUnwindList({ list: u.list || [], var: u.var, name: u.name || '' } as any, {}))
  console.log('resolvedLists =', JSON.stringify(resolvedLists))
  // 模拟 binding
  const binding = new Map()
  _uwAll.forEach((u, li) => { if (u.name) binding.set(u.name, resolvedLists[li][0]) })
  console.log("binding.get('c') =", JSON.stringify(binding.get('c')))
}
main().catch(e => console.error('ERR', e))
