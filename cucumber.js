module.exports = {
  default: {
    require: [
      'src/query/cypher-tck/step-definitions.ts',
    ],
    requireModule: [
      'tsx',
    ],
    format: [
      'progress-bar',
      'summary',
    ],
    publishQuiet: true,
    timeout: 30000,
  },
}
