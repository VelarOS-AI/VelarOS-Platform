#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, appendFile, cp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import * as defaultSuite from './cases.mjs'

const execute = promisify(execFile)
const [
  snapshotArg,
  outputArg,
  credentialsPath,
  split = 'validation',
  repetitionsArg = '2',
  modelId = 'gpt-5.6-sol',
  caseFile,
] = process.argv.slice(2)
assert(
  snapshotArg && outputArg && credentialsPath,
  'Usage: run.mjs <frozen-runtime> <new-output> <settings.json> [development|validation] [repetitions] [model]'
)
assert(['development', 'validation'].includes(split))
const snapshot = resolve(snapshotArg)
const output = resolve(outputArg)
const repetitions = Number(repetitionsArg)
assert(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 5)
const credentials = JSON.parse(await readFile(credentialsPath, 'utf8')).chat
assert(credentials.apiKey && credentials.baseURL)
const redact = (value) => String(value).replaceAll(credentials.apiKey, '[redacted]')
const imported = (path) => import(pathToFileURL(join(snapshot, 'packages', path)).href)
const { createRuntime, createNodeExecutionEnvironment } = await imported(
  'velaros/dist/act/runtime/index.js'
)
const { createLocalShellHost } = await imported('velaros/dist/execution/local.js')
const { createModelRuntimeComposition, createAiSdkModelDriver } =
  await imported('model/dist/index.js')
const composition = createModelRuntimeComposition({
  environment: {},
  providerScripts: { configPaths: [] },
})
const provider = composition.agentModelRuntime.createAgentProvider({
  provider: 'openai',
  apiKey: credentials.apiKey,
  baseURL: credentials.baseURL,
  reasoningLevel: 'high',
})
const { cases, development, suiteHash } = caseFile
  ? await import(pathToFileURL(resolve(caseFile)).href)
  : defaultSuite
const selectedCases = split === 'development' ? [development] : cases
await mkdir(output)
const manifest = {
  createdAt: new Date().toISOString(),
  suiteHash,
  split,
  repetitions,
  model: modelId,
  reasoning: 'high',
  snapshotManifestSha256: createHash('sha256')
    .update(await readFile(join(snapshot, 'manifest.json')))
    .digest('hex'),
  contextTokens: 128000,
  inputWindowTokens: 100000,
  outputTokens: 12000,
  maxRequests: 12,
  timeoutMs: 300000,
  // 固定参考价用于比较总资源成本，不声明等同供应商账单或当前官方价格。
  referencePricing: {
    inputPerMillion: 4,
    outputPerMillion: 20,
    cacheReadPerMillion: 0.4,
    currency: 'USD',
    kind: 'fixed-comparison-reference',
  },
  cases: selectedCases,
}
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
await writeFile(
  join(output, 'score-policy.json'),
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      excludedTasks: [],
      primaryOrder: ['task correctness', 'complete reference cost', 'requests', 'elapsed time'],
      billing: 'Fixed reference prices, not provider invoice.',
    },
    null,
    2
  )
)
// 验收脚本先作语法核对，再开始任何付费请求。
for (const item of selectedCases) {
  const path = join(output, `grade-${item.id}.mjs`)
  await writeFile(path, item.grade)
  await execute(process.execPath, ['--check', path])
}
const results = []
async function attempt(item, transport, repeat) {
  const directory = join(output, `${item.id}-${repeat}-${transport}`)
  const workspace = join(directory, 'workspace')
  await mkdir(workspace, { recursive: true })
  for (const [path, content] of Object.entries(item.files)) {
    await mkdir(resolve(workspace, path, '..'), { recursive: true })
    await writeFile(join(workspace, path), content)
  }
  const host = createLocalShellHost({ cwd: workspace })
  const driver = createAiSdkModelDriver({
    id: modelId,
    model: provider(modelId),
    limits: {
      contextTokens: manifest.contextTokens,
      inputTokens: manifest.inputWindowTokens,
      outputTokens: manifest.outputTokens,
    },
  })
  let runtime,
    status = 'starting',
    failure = null,
    gradeError = null,
    requestCount = 0,
    wireCount = 0
  const requests = [],
    events = []
  const network = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(credentials.baseURL) && typeof init?.body === 'string') {
      wireCount++
      await writeFile(join(directory, `wire-${wireCount}.json`), init.body)
    }
    return network(url, init)
  }
  const startedAt = Date.now()
  try {
    runtime = await createRuntime({
      workspace,
      dataDir: join(directory, 'state'),
      node: createNodeExecutionEnvironment({
        cwd: workspace,
        directory: join(directory, 'node'),
        host,
      }),
      model: {
        id: driver.id,
        nativeTools: driver.nativeTools,
        limits: driver.limits,
        estimate: (request) => driver.estimate(request),
        async *stream(request, signal) {
          requestCount++
          if (requestCount > manifest.maxRequests) throw new Error('Evaluation request limit')
          const row = { sequence: requestCount, startedAt: Date.now(), request, deltas: [] }
          requests.push(row)
          const path = join(directory, `request-${requestCount}.json`)
          await writeFile(path, JSON.stringify(row))
          try {
            for await (const delta of driver.stream(request, signal)) {
              row.deltas.push(delta)
              yield delta
            }
          } catch (error) {
            row.error = redact(error)
            throw error
          } finally {
            row.finishedAt = Date.now()
            await writeFile(path, JSON.stringify(row))
          }
        },
      },
      protocol: { transport },
      project: false,
      agents: false,
      search: false,
      memory: false,
      context: { maintenance: false, policy: { windowTokens: manifest.inputWindowTokens } },
      limits: {
        turns: manifest.maxRequests,
        timeoutMs: manifest.timeoutMs,
        outputTokens: manifest.outputTokens,
        safetyTokens: 4096,
      },
    })
    const session = await runtime.openSession(`${item.id}-${repeat}`)
    for await (const event of session.submit(
      item.prompt,
      AbortSignal.timeout(manifest.timeoutMs)
    )) {
      events.push(event)
      await appendFile(join(directory, 'events.jsonl'), JSON.stringify(event) + '\n')
      if (event.type === 'state') status = event.status
      if (event.type === 'error') failure = event.message
      if (event.type === 'accepted') failure = null
      if (event.type === 'interaction') {
        failure = 'Unattended task requested input'
        session.cancel()
      }
    }
    await writeFile(
      join(directory, 'trace.json'),
      JSON.stringify(await runtime.trace(session.id, { fullContent: true }), null, 2)
    )
  } catch (error) {
    failure = redact(error)
    status = 'failed'
  } finally {
    try {
      await runtime?.close()
    } catch (error) {
      failure ??= redact(error)
    }
    await host.dispose()
    globalThis.fetch = network
  }
  const elapsedMs = Date.now() - startedAt
  const gradingWorkspace = join(directory, 'grading-workspace')
  await cp(workspace, gradingWorkspace, { recursive: true })
  try {
    await execute(process.execPath, [join(output, `grade-${item.id}.mjs`), gradingWorkspace], {
      timeout: 20000,
    })
    for (const path of item.preserve ?? [])
      assert.equal(
        await readFile(join(workspace, path), 'utf8'),
        item.files[path],
        `${path} must be preserved`
      )
    for (const path of item.rerun ?? []) {
      await execute(process.execPath, [path], { cwd: gradingWorkspace, timeout: 20000 })
      await execute(process.execPath, [join(output, `grade-${item.id}.mjs`), gradingWorkspace], {
        timeout: 20000,
      })
    }
    if (item.requireObservation)
      assert(
        events.some(
          (event) => event.type === 'program' && event.kind === 'observe' && event.phase === 'end'
        ),
        'Continuous observation must be registered'
      )
    if (item.requireAsync)
      assert(
        requests.some(
          (row) =>
            row.deltas.some(
              (delta) => delta.type === 'tool-call' && delta.value.input?.options?.async === true
            ) ||
            /async\s*:\s*true/u.test(
              row.deltas
                .filter((delta) => delta.type === 'text')
                .map((delta) => delta.text)
                .join('')
            )
        ),
        'Background execution must be requested'
      )
  } catch (error) {
    gradeError = redact(error.message)
  }
  const usage = requests
    .map((row) => row.deltas.find((delta) => delta.type === 'usage'))
    .filter(Boolean)
  const sum = (key) => usage.reduce((total, value) => total + (value[key] ?? 0), 0)
  const completeUsage = usage.length === requests.length && wireCount === requests.length
  const cacheComplete = completeUsage && usage.every((row) => Number.isFinite(row.cacheReadTokens))
  const inputTokens = sum('inputTokens'),
    outputTokens = sum('outputTokens'),
    cacheReadTokens = sum('cacheReadTokens')
  const result = {
    task: item.id,
    transport,
    repeat,
    status,
    success: status === 'completed' && !failure && !gradeError,
    failure,
    gradeError,
    requestCount,
    wireCount,
    elapsedMs,
    repairErrors: events.filter((event) => event.type === 'error').map((event) => event.message),
    completeUsage,
    cacheComplete,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    referenceUncachedUsd: completeUsage ? (inputTokens * 4 + outputTokens * 20) / 1e6 : null,
    referenceCachedUsd: cacheComplete
      ? ((inputTokens - cacheReadTokens) * 4 + cacheReadTokens * 0.4 + outputTokens * 20) / 1e6
      : null,
  }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2))
  results.push(result)
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify(result))
}
for (let repeat = 1; repeat <= repetitions; repeat++)
  for (const [index, item] of selectedCases.entries()) {
    const order = (index + repeat) % 2 ? ['text', 'tools'] : ['tools', 'text']
    for (const transport of order) await attempt(item, transport, repeat)
  }
