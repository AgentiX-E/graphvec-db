import { _parseAggregate } from '../src/query/expression-engine'

async function main() {
  for (const e of ['percentileDisc(0.90, deg)', 'percentileDisc(n.price, 0.5)', 'percentileDisc(n.price, $percentile)']) {
    const r = _parseAggregate(e)
    console.log(JSON.stringify(e), '=>', JSON.stringify(r))
  }
}
main().catch(e => console.error('ERR', e))
