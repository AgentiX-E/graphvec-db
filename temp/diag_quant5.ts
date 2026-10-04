import { _evalBinary } from '../src/query/expression-engine'
async function main() {
  const ctx = { list: [1,2,3] }
  console.log('_evalBinary any false =', JSON.stringify(_evalBinary('any(x IN list WHERE false)', ctx)))
  console.log('_evalBinary any x>2   =', JSON.stringify(_evalBinary('any(x IN list WHERE x > 2)', ctx)))
}
main().catch(e => console.error('ERR', e))
