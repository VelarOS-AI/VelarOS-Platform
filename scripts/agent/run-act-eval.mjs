import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { ReasoningLevels } from '@velaros-ai/model/contracts'
import { createAiSdkModelDriver, createModelRuntimeComposition } from '@velaros-ai/model'
import { runActEvaluation } from './act-eval.mjs'
import { evaluationScenarios, runActEvaluationBatch } from './act-eval-batch.mjs'

// 凭据仅从明确指定的变量读取，不进入配置回显、模型上下文或归档。
export function configuredModel(input, environment) {
  const fields = [
    'provider',
    'model',
    'baseURL',
    'apiKeyEnv',
    'contextTokens',
    'inputTokens',
    'outputTokens',
  ]
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => ![...fields, 'reasoningLevel'].includes(key)) ||
    fields.some((key) => !Object.hasOwn(input, key))
  )
    throw new Error(
      '模型配置字段应为 provider/model/baseURL/apiKeyEnv/contextTokens/inputTokens/outputTokens'
    )
  for (const key of fields.slice(0, 4))
    if (typeof input[key] !== 'string' || !input[key].trim()) throw new Error(`模型配置缺少 ${key}`)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(input.apiKeyEnv))
    throw new Error('apiKeyEnv 必须是环境变量名')
  const url = new URL(input.baseURL)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Base URL 只允许不含凭据或查询参数的 HTTP(S) 地址')
  for (const key of fields.slice(4))
    if (!Number.isSafeInteger(input[key]) || input[key] < 1)
      throw new Error(`模型容量 ${key} 必须为正整数`)
  if (
    input.inputTokens > input.contextTokens ||
    input.inputTokens + input.outputTokens + 1024 > input.contextTokens
  )
    throw new Error('上下文容量需要覆盖输入、输出和 1024 token 安全余量')
  if (input.reasoningLevel !== undefined && !ReasoningLevels.includes(input.reasoningLevel))
    throw new Error('reasoningLevel 必须使用已登记的思考力度')
  const apiKey = environment[input.apiKeyEnv]
  if (typeof apiKey !== 'string' || !apiKey.trim())
    throw new Error(`指定环境变量 ${input.apiKeyEnv} 尚未设置`)
  const composition = createModelRuntimeComposition({
    environment: {},
    providerScripts: { configPaths: [] },
  })
  if (!composition.modelAdapterRegistry.supportsProvider(input.provider))
    throw new Error('该 Provider 未注册共享模型适配器')
  const factory = composition.modelAdapterRegistry.createLanguageModelFactory({
    provider: input.provider,
    apiKey,
    baseURL: input.baseURL,
    reasoningLevel: input.reasoningLevel,
  })
  const limits = {
    contextTokens: input.contextTokens,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
  }
  return {
    model: createAiSdkModelDriver({
      id: `${input.provider}/${input.model}`,
      model: factory(input.model),
      limits,
    }),
    provider: input.provider,
    configuration: {
      provider: input.provider,
      model: input.model,
      baseURL: input.baseURL,
      reasoningLevel: input.reasoningLevel ?? null,
      limits,
    },
  }
}

// CLI 只装配现有 Model/Runtime/Lab；工作目录始终是一次独占的验收目录。
export async function main(args) {
  const { values } = parseArgs({
    args,
    options: {
      scenario: { type: 'string' },
      repeat: { type: 'string' },
      'model-config': { type: 'string' },
      output: { type: 'string' },
      turns: { type: 'string' },
      'timeout-ms': { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: true,
  })
  if (values.help) {
    console.log(
      'node scripts/agent/run-act-eval.mjs --model-config /absolute/model.json --output /absolute/results [--scenario all|read-edit-observe|system-cooperation|semantic-search|reconciliation] [--repeat 3] [--turns 12] [--timeout-ms 120000]'
    )
    return
  }
  if (!values['model-config'] || !values.output)
    throw new Error('需要 --model-config 和 --output；配置不包含 API Key 正文')
  const model = configuredModel(
    JSON.parse(await readFile(resolve(values['model-config']), 'utf8')),
    process.env
  )
  const repository = fileURLToPath(new URL('../../', import.meta.url))
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim()
  const dirty = Boolean(
    execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }).trim()
  )
  const options = {
    ...model,
    scenario: values.scenario ?? 'read-edit-observe',
    configuration: { ...model.configuration, sourceDirty: dirty },
    output: values.output,
    sourceCommit,
    consumerCommit: dirty ? `${sourceCommit}:unfrozen:${randomUUID()}` : sourceCommit,
    turns: values.turns === undefined ? undefined : Number(values.turns),
    timeoutMs: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']),
  }
  if (values.repeat !== undefined || values.scenario === 'all') {
    const result = await runActEvaluationBatch({
      ...options,
      repeat: values.repeat === undefined ? 1 : Number(values.repeat),
      scenarios: values.scenario === 'all' ? evaluationScenarios : [options.scenario],
    })
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.passed ? 0 : 1
    return
  }
  const result = await runActEvaluation(options)
  console.log(JSON.stringify(result.summary, null, 2))
  process.exitCode = result.summary.passed ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
