/**
 * tck-parser.ts — openCypher TCK Gherkin .feature 文件解析器
 *
 * 解析 Cucumber/Gherkin 格式的 TCK 测试场景文件。
 * TCK 格式示例：
 *
 *   Feature: Match
 *
 *   Scenario: Match any node
 *     Given an empty graph
 *     When executing query:
 *       """
 *       MATCH (n) RETURN n
 *       """
 *     Then the result should be empty
 *
 *   Scenario Outline: Match with label
 *     Given an empty graph
 *     When executing query:
 *       """
 *       MATCH (n:<label>) RETURN n
 *       """
 *     Then the result should be empty
 *
 *     Examples:
 *       | label    |
 *       | Person   |
 *       | Company  |
 *
 * 支持：
 * - Feature / Scenario / Scenario Outline
 * - Given / When / Then 步骤
 * - 文档字符串 ("""...""")
 * - DataTable
 * - Examples 表格（参数化场景）
 * - Tags (@tag)
 */

import { TCKTestCase, TCKStep, TCKResult } from './tck-adapter'

// ── 解析后的结构定义 ─────────────────────────────────────

/** 单个 TCK Feature */
export interface TCKFeature {
  name: string
  scenarios: TCKScenario[]
  tags: string[]
}

/** 单个 TCK Scenario */
export interface TCKScenario {
  type: 'scenario' | 'scenario_outline'
  name: string
  steps: TCKParseStep[]
  tags: string[]
  examples?: Record<string, string[]>[]
}

/** 解析后的步骤 */
export interface TCKParseStep {
  keyword: 'Given' | 'When' | 'Then' | 'And' | 'But'
  text: string
  docString?: string
  dataTable?: string[][]
}

// ── 解析器实现 ───────────────────────────────────────────

/**
 * 将 Gherkin .feature 内容解析为 TCKFeature[]。
 */
export function parseFeatureFile(content: string): TCKFeature[] {
  const lines = content.split('\n')
  const features: TCKFeature[] = []
  let currentFeature: TCKFeature | null = null
  let currentScenario: TCKScenario | null = null
  let currentSteps: TCKParseStep[] = []
  let docString: string | null = null
  let inDocString = false
  let dataTable: string[][] | null = null
  let inDataTable = false
  let inExamples = false
  let currentExamples: Record<string, string[]>[] = []
  let examplesHeaders: string[] = []
  let currentTags: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    const trimLine = rawLine.trim()

    // Skip empty lines
    if (!trimLine) {
      // 如果 data table 正在收集，空行不算结束
      continue
    }

    // Tags
    if (trimLine.startsWith('@')) {
      const tags = trimLine.split(/\s+/).filter(t => t.startsWith('@'))
      currentTags = tags
      continue
    }

    // DocString (triple quotes)
    if (trimLine.startsWith('"""')) {
      if (!inDocString) {
        inDocString = true
        docString = ''
        continue
      } else {
        inDocString = false
        // 将 docString 关联到最后一步
        if (currentSteps.length > 0) {
          currentSteps[currentSteps.length - 1].docString = docString
        }
        docString = null
        continue
      }
    }

    if (inDocString) {
      docString += (docString ? '\n' : '') + trimLine
      continue
    }

    // DataTable
    if (trimLine.startsWith('|')) {
      const cells = trimLine
        .split('|')
        .filter(c => c.trim() !== '')
        .map(c => c.trim())

      if (!inDataTable) {
        inDataTable = true
        if (inExamples) {
          examplesHeaders = cells
        } else {
          dataTable = [cells]
        }
      } else {
        if (inExamples) {
          // 添加到 examples
          if (cells.length === examplesHeaders.length) {
            const entry: Record<string, string> = {}
            examplesHeaders.forEach((h, idx) => {
              entry[h] = cells[idx]
            })
            currentExamples.push(entry)
          }
        } else if (dataTable) {
          dataTable.push(cells)
        }
      }
      continue
    } else {
      if (inDataTable && !inExamples) {
        // DataTable 结束，关联到最后一步
        if (currentSteps.length > 0 && dataTable) {
          currentSteps[currentSteps.length - 1].dataTable = dataTable
        }
        dataTable = null
        inDataTable = false
      }
      if (inExamples && trimLine !== 'Examples:' && !trimLine.startsWith('|')) {
        // Examples 结束
        if (currentScenario) {
          currentScenario.examples = currentExamples
        }
        currentExamples = []
        examplesHeaders = []
        inExamples = false
      }
    }

    // Feature
    const featureMatch = trimLine.match(/^Feature:\s*(.+)/i)
    if (featureMatch) {
      // 保存之前的 scenario
      if (currentFeature && currentScenario) {
        currentScenario.steps = currentSteps
        currentFeature.scenarios.push(currentScenario)
        currentScenario = null
        currentSteps = []
      }

      currentFeature = {
        name: featureMatch[1].trim(),
        scenarios: [],
        tags: [...currentTags],
      }
      features.push(currentFeature)
      currentTags = []
      continue
    }

    // Scenario / Scenario Outline
    const scenarioMatch = trimLine.match(/^(?:Scenario Outline|Scenario):\s*(.+)/i)
    if (scenarioMatch) {
      // 保存之前的 scenario
      if (currentFeature && currentScenario) {
        currentScenario.steps = currentSteps
        currentFeature.scenarios.push(currentScenario)
      }

      currentExamples = []
      examplesHeaders = []
      inExamples = false

      const isOutline = rawLine.trim().startsWith('Scenario Outline')
      currentScenario = {
        type: isOutline ? 'scenario_outline' : 'scenario',
        name: scenarioMatch[1].trim(),
        steps: [],
        tags: [...currentTags],
      }
      currentSteps = []
      currentTags = []
      continue
    }

    // Examples:
    if (trimLine.startsWith('Examples:')) {
      inExamples = true
      currentExamples = []
      examplesHeaders = []
      inDataTable = false
      continue
    }

    // Given / When / Then / And / But
    const stepMatch = trimLine.match(/^(Given|When|Then|And|But)\s+(.*)/i)
    if (stepMatch) {
      if (currentSteps.length > 0 && dataTable) {
        currentSteps[currentSteps.length - 1].dataTable = dataTable
        dataTable = null
        inDataTable = false
      }

      currentSteps.push({
        keyword: stepMatch[1] as 'Given' | 'When' | 'Then' | 'And' | 'But',
        text: stepMatch[2].trim(),
      })
      inDataTable = false
      continue
    }
  }

  // Save last scenario
  if (currentFeature && currentScenario) {
    currentScenario.steps = currentSteps
    currentFeature.scenarios.push(currentScenario)
  }

  return features
}

// ── TCK 步骤 → 测试用例转换 ─────────────────────────────

/**
 * 将解析出的 TCKFeature 转换为 TCKTestCase[]。
 * 处理 Scenario Outline 的参数化展开。
 */
export function featureToTestCases(features: TCKFeature[]): TCKTestCase[] {
  const testCases: TCKTestCase[] = []

  for (const feature of features) {
    for (const scenario of feature.scenarios) {
      if (scenario.type === 'scenario_outline' && scenario.examples && scenario.examples.length > 0) {
        // 每个 examples 行生成一个测试
        for (const example of scenario.examples) {
          testCases.push({
            feature: feature.name,
            scenario: `${scenario.name} (${Object.entries(example).map(([k, v]) => `${k}=${v}`).join(', ')})`,
            steps: substituteSteps(scenario.steps, example),
            tags: [...feature.tags, ...scenario.tags],
          })
        }
      } else {
        testCases.push({
          feature: feature.name,
          scenario: scenario.name,
          steps: substituteSteps(scenario.steps, {}),
          tags: [...feature.tags, ...scenario.tags],
        })
      }
    }
  }

  return testCases
}

/**
 * 将参数替换到步骤中（处理 Scenario Outline）。
 */
function substituteSteps(steps: TCKParseStep[], params: Record<string, string>): TCKStep[] {
  const result: TCKStep[] = []

  for (const step of steps) {
    let text = step.text
    let docString = step.docString
    let dataTable = step.dataTable

    // 替换 <param> 占位符
    for (const [key, value] of Object.entries(params)) {
      const pattern = new RegExp(`<${key}>`, 'g')
      text = text.replace(pattern, value)
      if (docString) {
        docString = docString.replace(pattern, value)
      }
      if (dataTable) {
        dataTable = dataTable.map(row => row.map(cell => cell.replace(pattern, value)))
      }
    }

    const tckStep: TCKStep = {
      type: step.keyword.toLowerCase() as 'given' | 'when' | 'then',
      query: docString || text,
    }

    result.push(tckStep)
  }

  return result
}

/**
 * 从 Gherkin 文本内容直接解析出 TCKTestCase[]。
 * 这是最常用的入口点。
 */
export function parseTCK(content: string): TCKTestCase[] {
  const features = parseFeatureFile(content)
  return featureToTestCases(features)
}

/**
 * 从 .feature 文件路径读取并解析。
 */
export function parseTCKFile(filePath: string): TCKTestCase[] {
  const fs = require('fs')
  const content = fs.readFileSync(filePath, 'utf-8')
  return parseTCK(content)
}
