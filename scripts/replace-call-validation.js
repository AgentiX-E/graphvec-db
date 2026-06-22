const fs = require('fs');

const content = fs.readFileSync('src/query/query-engine.ts', 'utf8');

const newBlock = `    if (resolvedName) {
      const proc = _procedureRegistry.get(resolvedName)
      if (!proc) {
        throw Object.assign(new Error('ProcedureError: ProcedureNotFound (' + resolvedName + ')'), { tckError: 'ProcedureNotFound' })
      }
      const sigParens = proc.signature.match(/\\(([^)]*)\\)/)
      const sigArgs = sigParens ? sigParens[1].split(',').filter(s => s.trim().length > 0) : []
      if (resolvedArgs && resolvedArgs.length > sigArgs.length) {
        throw Object.assign(new Error('InvalidNumberOfArguments (' + resolvedName + '): expected ' + sigArgs.length + ', got ' + resolvedArgs.length), { tckError: 'InvalidNumberOfArguments' })
      }
      if (resolvedArgs && query.match(/CALL\\s+\\S+\\s*\\(/i) && resolvedArgs.length !== 0 && resolvedArgs.length < sigArgs.length) {
        throw Object.assign(new Error('InvalidNumberOfArguments (' + resolvedName + '): expected ' + sigArgs.length + ', got ' + resolvedArgs.length), { tckError: 'InvalidNumberOfArguments' })
      }
      if (resolvedArgs?.length) {
        const aggFnPattern = /^\\s*(?:collect|count|sum|avg|max|min)\\s*\\(/i
        for (const arg of resolvedArgs) {
          if (aggFnPattern.test(arg)) {
            throw Object.assign(new Error('SyntaxError: InvalidAggregation (' + arg + ')'), { tckError: 'InvalidAggregation' })
          }
        }
        // InvalidArgumentType: check literal arg types against signature
        const queryArgsArr = query.match(/CALL\\s+\\S+?\\s*\\(([^)]*)\\)/i)
        if (queryArgsArr && sigArgs.length > 0) {
          const userArgs = queryArgsArr[1].split(',').map(s => s.trim()).filter(Boolean)
          for (let ai = 0; ai < Math.min(userArgs.length, sigArgs.length); ai++) {
            const sigArg = sigArgs[ai].trim()
            const typeMatch2 = sigArg.match(/::\\s*(\\w+)/)
            if (typeMatch2) {
              const expType = typeMatch2[1].toUpperCase()
              const userArg = userArgs[ai]
              let userType
              if (userArg === 'true' || userArg === 'false') userType = 'BOOLEAN'
              else if (/^-?\\d+\\.\\d+/.test(userArg)) userType = 'FLOAT'
              else if (/^-?\\d+$/.test(userArg)) userType = 'INTEGER'
              else if (/^['"]/.test(userArg)) userType = 'STRING'
              else if (userArg === 'null') userType = 'NULL'
              else continue
              if (expType === 'INTEGER' && (userType === 'BOOLEAN' || userType === 'FLOAT')) {
                throw Object.assign(new Error('SyntaxError: InvalidArgumentType'), { tckError: 'InvalidArgumentType' })
              }
              if (expType === 'BOOLEAN' && (userType === 'INTEGER' || userType === 'FLOAT')) {
                throw Object.assign(new Error('SyntaxError: InvalidArgumentType'), { tckError: 'InvalidArgumentType' })
              }
            }
          }
        }
      }
      if (resolvedYieldItems?.length) {
        const boundVars = new Set()
        // Only scan variables before the CALL (MATCH/WITH etc., but not after)
        const beforeCall = query.slice(0, Math.max(0, query.toLowerCase().indexOf('call')))
        const matchClauses = beforeCall.matchAll(/MATCH\\s+(.*?)(?:\\s+(?:WHERE|WITH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\\s+BY|SKIP|LIMIT|INVOKE|CALL)\\s|\$)/gis)
        for (const mc of matchClauses) {
          const clause = mc[1]
          const nodeVars = clause.matchAll(/\\((\\w+)\\s*(?::|\\)|{)/g)
          for (const v of nodeVars) if (v[1]) boundVars.add(v[1])
          const edgeVars = clause.matchAll(/\\[(\\w+)\\s*(?::|\\]|\\))/g)
          for (const v of edgeVars) if (v[1]) boundVars.add(v[1])
        }
        const withClauses = beforeCall.matchAll(/WITH\\s+(.+?)(?:\\s+(?:WHERE|RETURN|MATCH|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\\s+BY|SKIP|LIMIT|CALL)\\s|\$)/gis)
        for (const wc of withClauses) {
          const clause = wc[1]
          const asAliases = clause.matchAll(/\\bAS\\s+(\\w+)/gi)
          for (const a of asAliases) boundVars.add(a[1])
          const bareVars = clause.matchAll(/\\b([a-zA-Z_]\\w*)\\b/g)
          for (const v of bareVars) {
            if (!/^(?:AS|null|true|false)\$/i.test(v[1])) boundVars.add(v[1])
          }
        }
        for (const yi of resolvedYieldItems) {
          const yieldName = yi.alias || yi.name
          if (boundVars.has(yieldName)) {
            throw Object.assign(new Error('SyntaxError: VariableAlreadyBound (' + yieldName + ')'), { tckError: 'VariableAlreadyBound' })
          }
        }
        // Check duplicate aliases within the same YIELD
        const allYieldNames = resolvedYieldItems.map(yi => yi.alias || yi.name)
        const seenNames = new Set()
        for (const yn of allYieldNames) {
          if (seenNames.has(yn)) {
            throw Object.assign(new Error('SyntaxError: VariableAlreadyBound (' + yn + ')'), { tckError: 'VariableAlreadyBound' })
          }
          seenNames.add(yn)
        }
      }
    } else {
      // In-query CALL without parentheses but with YIELD - check argument passing mode
      const bareCallMatchY = query.match(/CALL\\s+(\\S+?)\\s+YIELD\\s+/i)
      if (bareCallMatchY) {
        const bareNameY = bareCallMatchY[1].toLowerCase()
        const procY = _procedureRegistry.get(bareNameY)
        if (procY) {
          const sigParensY = procY.signature.match(/\\(([^)]*)\\)/)
          if (sigParensY) {
            const sigArgsY = sigParensY[1].split(',').filter(s => s.trim().length > 0)
            if (sigArgsY.length > 0) {
              throw Object.assign(new Error('SyntaxError: InvalidArgumentPassingMode'), { tckError: 'InvalidArgumentPassingMode' })
            }
          }
        }
      }
      const bareCallMatch = query.match(/CALL\\s+(\\S+)(?:\\s|\$)/i)
      if (bareCallMatch) {
        const bareName = bareCallMatch[1].toLowerCase()
        const proc = _procedureRegistry.get(bareName)
        if (!proc) {
          throw Object.assign(new Error('ProcedureError: ProcedureNotFound (' + bareName + ')'), { tckError: 'ProcedureNotFound' })
        }
        // MissingParameter: only throw for required non-optional params
        const sigPa = proc.signature.match(/\\(([^)]*)\\)/)
        if (sigPa) {
          const sigArgsB = sigPa[1].split(',').filter(s => s.trim().length > 0)
          if (sigArgsB.length > 0) {
            const hasRequiredParams = sigArgsB.some(a => {
              const trimmed = a.trim()
              return !trimmed.endsWith('?') && !/DEFAULT\\s/i.test(trimmed)
            })
            if (hasRequiredParams) {
              throw Object.assign(new Error('ParameterMissing'), { tckError: 'MissingParameter' })
            }
          }
        }
        // InvalidArgumentType for bare CALL with parentheses args (e.g. CALL test.my.proc(true))
        const bareCallArgs = query.match(/CALL\\s+(\\S+)\\s*\\(([^)]*)\\)/i)
        if (bareCallArgs) {
          const bareName3 = bareCallArgs[1].toLowerCase()
          const proc3 = _procedureRegistry.get(bareName3)
          if (proc3) {
            const sigPa3 = proc3.signature.match(/\\(([^)]*)\\)/)
            if (sigPa3) {
              const sigArgs3 = sigPa3[1].split(',').filter(s => s.trim().length > 0)
              const userArgs3 = bareCallArgs[2].split(',').map(s => s.trim()).filter(Boolean)
              for (let ai = 0; ai < Math.min(userArgs3.length, sigArgs3.length); ai++) {
                const sigArg = sigArgs3[ai].trim()
                const typeMatch3 = sigArg.match(/::\\s*(\\w+)/)
                if (typeMatch3) {
                  const expType = typeMatch3[1].toUpperCase()
                  const userArg = userArgs3[ai]
                  let userType
                  if (userArg === 'true' || userArg === 'false') userType = 'BOOLEAN'
                  else if (/^-?\\d+\\.\\d+/.test(userArg)) userType = 'FLOAT'
                  else if (/^-?\\d+$/.test(userArg)) userType = 'INTEGER'
                  else if (/^['"]/.test(userArg)) userType = 'STRING'
                  else if (userArg === 'null') userType = 'NULL'
                  else continue
                  if (expType === 'INTEGER' && (userType === 'BOOLEAN' || userType === 'FLOAT')) {
                    throw Object.assign(new Error('SyntaxError: InvalidArgumentType'), { tckError: 'InvalidArgumentType' })
                  }
                  if (expType === 'BOOLEAN' && (userType === 'INTEGER' || userType === 'FLOAT')) {
                    throw Object.assign(new Error('SyntaxError: InvalidArgumentType'), { tckError: 'InvalidArgumentType' })
                  }
                }
              }
            }
          }
        }
      }
    }`;

const anchorStart = '    if (resolvedName) {\n';
const anchorEnd = '  }\n\n/** 从 Cypher 查询中提取 MATCH 子句的字符串 */';

const idxStart = content.indexOf(anchorStart);
const idxEnd = content.indexOf(anchorEnd, idxStart);

if (idxStart < 0 || idxEnd < 0) {
  console.error('ERROR: anchors not found');
  process.exit(1);
}

const newContent = content.substring(0, idxStart) + newBlock + '\n' + content.substring(idxEnd);
fs.writeFileSync('src/query/query-engine.ts', newContent);
console.log(`OK: anchored at ${idxStart}-${idxEnd}, new file ${newContent.length} chars`);
