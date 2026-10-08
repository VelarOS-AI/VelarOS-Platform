// 同一正式 Runtime 上对照动作接口、模型辅助整理和独立复核；完整保留失败、用量及费用覆盖。
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { appendFile, cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { BudgetLedger, budgetServer } from '../harbor/budget-proxy.mjs'
import { attemptCredential } from '../harbor/request-identity.mjs'
import { campaignModelDriver } from '../long-tasks/model-driver.mjs'
import { runCapturedCommand } from '../long-tasks/command-output.mjs'
import {
  acquireTaskResources,
  archiveTaskResources,
  checkTaskResourceBudget,
  monitorTaskResources,
  registerTaskResources,
} from '../long-tasks/resource-lifecycle.mjs'
import { actionAdapter } from './action-adapter.mjs'
import { cases, development, suiteHash } from './cases.mjs'
import { awaitGatewaySettlement } from './settlement.mjs'

const execute = promisify(execFile)
const [snapshotArg, artifactSourceArg, outputArg, credentialsPath, split = 'validation'] =
  process.argv.slice(2)
assert(snapshotArg && artifactSourceArg && outputArg && credentialsPath)
assert(['development', 'validation'].includes(split))
const snapshot = await realpath(resolve(snapshotArg)),
  output = resolve(outputArg)
const artifactSourcePath = await realpath(resolve(artifactSourceArg))
const imported = (path) => import(pathToFileURL(join(snapshot, 'packages', path)).href)
const { createRuntime, createNodeExecutionEnvironment } = await imported(
  'velaros/dist/act/runtime/index.js'
)
const { createLocalShellHost } = await imported('velaros/dist/execution/local.js')
const modelPackage = await imported('model/dist/index.js')
const { WorkspaceCompletionArtifacts } = await import(pathToFileURL(artifactSourcePath).href)
const credentials = JSON.parse(await readFile(credentialsPath, 'utf8')).chat
assert(credentials.apiKey && credentials.baseURL)
const redact = (error) => String(error).replaceAll(credentials.apiKey, '[redacted]')
await mkdir(output)
const config = {
  model: 'gpt-5.6-sol',
  contextTokens: 32768,
  inputWindowTokens: 16000,
  outputTokens: 6000,
  maxRequests: 48,
  timeoutMs: 480000,
  budgetUsd: 100,
  perAttemptBudgetUsd: 60,
  providerCapabilities: { openaiExplicitCacheBreakpoints: false },
}
const arms = [
  { id: 'script-full', action: 'script', maintenance: true, review: true },
  { id: 'tools-full', action: 'tools', maintenance: true, review: true },
  { id: 'script-no-model-maintenance', action: 'script', maintenance: false, review: true },
  { id: 'script-no-review', action: 'script', maintenance: true, review: false },
]
const selected = split === 'development' ? [development] : cases
const repetitions = split === 'development' ? 1 : 2
const order = []
for (let repeat = 1; repeat <= repetitions; repeat++) {
  const tasks = repeat % 2 ? selected : [...selected].reverse()
  for (const [index, item] of tasks.entries()) {
    const shift = ((repeat - 1) * selected.length + index) % arms.length
    for (let offset = 0; offset < arms.length; offset++)
      order.push({ task: item.id, repeat, arm: arms[(shift + offset) % arms.length].id })
  }
}
const hash = (value) => createHash('sha256').update(value).digest('hex')
const frozen = JSON.parse(await readFile(join(snapshot, 'manifest.json'), 'utf8'))
async function verifyFrozen() {
  for (const [path, expected] of Object.entries(frozen.files))
    assert.equal(
      hash(await readFile(join(snapshot, path))),
      expected,
      `Frozen runtime changed: ${path}`
    )
}
await verifyFrozen()
const manifest = {
  at: new Date().toISOString(),
  split,
  suiteHash,
  config,
  arms,
  order,
  snapshotManifestSha256: hash(await readFile(join(snapshot, 'manifest.json'))),
  artifactSourceSha256: hash(await readFile(artifactSourcePath)),
  cases: selected.map(({ control, ...item }) => item),
  scorePolicy: {
    primary: [
      'functional correctness at every phase',
      'manual original requirement coverage',
      'all-request reference cost',
      'decision requests',
      'elapsed time',
    ],
    excludedTasks: [],
    failures: 'retain every attempt; no best-of selection',
    referencePricing: {
      inputPerMillion: 4,
      cacheReadPerMillion: 0.4,
      cacheWritePerMillion: 5,
      outputPerMillion: 20,
      basis: 'fixed comparison reference matching the gateway ledger; not provider invoice',
    },
    maintenanceAblation:
      'model-assisted maintenance disabled; deterministic reference fallback remains',
    limits: [
      'Small authored task suite, two repetitions; not a public benchmark or general superiority proof.',
      'Individual tools mechanically execute in the same Runtime; runCommand can use scripts and batching.',
      'Individual tool history retains Runtime audit wrappers; the tool interface instructions differ by necessity.',
      'Each phase has held-out functional grading plus a separately reported manual delivery audit.',
      'Other local workloads, including durability fixtures, may affect wall time.',
    ],
  },
}
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
for (const item of selected) {
  await writeFile(join(output, `grade-${item.id}.mjs`), item.grade)
  await execute(process.execPath, ['--check', join(output, `grade-${item.id}.mjs`)])
}
const ledger = new BudgetLedger(join(output, 'gateway'), config.budgetUsd, {
  model: config.model,
  reasoningEffort: 'high',
  maxRequestsPerAttempt: config.maxRequests,
  perAttemptBudgetUsd: config.perAttemptBudgetUsd,
  pricing: {
    input: 4,
    cached: 0.4,
    write: 5,
    output: 20,
    longThreshold: 272000,
    longInputMultiplier: 2,
    longOutputMultiplier: 1.5,
  },
  pricingRef: 'fixed-experiment-reference-20261008',
  pricingBasis: {
    kind: 'reference_only',
    source: 'Frozen comparison rates, not a provider invoice',
  },
})
const token = randomBytes(32).toString('hex')
const gateway = budgetServer({
  ledger,
  apiKey: credentials.apiKey,
  token,
  upstream: credentials.baseURL,
  requireIdentity: true,
  maxConcurrency: 2,
  perAttemptConcurrency: 2,
  generationPolicy: {
    maxOutputTokens: config.outputTokens,
    reasoningContext: 'all_turns',
    reasoningSummary: 'auto',
    textVerbosity: 'medium',
  },
})
await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
const baseURL = `http://127.0.0.1:${gateway.address().port}/v1`
const cancellation = new AbortController()
const cancel = () => cancellation.abort(new Error('Mechanism campaign interrupted'))
process.on('SIGTERM', cancel)
process.on('SIGINT', cancel)
const results = []

async function attempt(item, arm, repeat) {
  cancellation.signal.throwIfAborted()
  const id = `${item.id}-${repeat}-${arm.id}`,
    directory = join(output, id)
  await mkdir(directory)
  const root = await realpath(await mkdtemp('/tmp/vlr-mechanism-')),
    workspace = join(root, 'workspace')
  await mkdir(workspace)
  await mkdir(join(root, 'tmp'))
  const resources = await registerTaskResources(root, directory, { maxTaskBytes: 2 * 1024 ** 3 })
  const release = await acquireTaskResources(resources)
  const controller = new AbortController()
  const signal = AbortSignal.any([
    cancellation.signal,
    controller.signal,
    AbortSignal.timeout(config.timeoutMs),
  ])
  const stopMonitor = monitorTaskResources(resources, (error) => controller.abort(error))
  const oldTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
  Object.assign(process.env, {
    TMPDIR: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
    TEMP: join(root, 'tmp'),
  })
  const identity = {
    campaignId: 'mechanism-20261008',
    candidateId: manifest.snapshotManifestSha256.slice(0, 16),
    participantId: arm.id,
    taskId: item.id,
    attemptId: id,
    jobId: split,
    phase: 'source',
  }
  const credential = attemptCredential(identity, token)
  const base = campaignModelDriver(modelPackage, { ...config, apiKey: credential, baseURL })
  const requests = [],
    events = [],
    grades = []
  const audited = {
    id: base.id,
    nativeTools: base.nativeTools,
    limits: base.limits,
    estimate: (request) => base.estimate(request),
    async *stream(request, requestSignal) {
      const phase =
        request.materials.find(
          (material) =>
            material.origin.startsWith('completion-') || material.origin === 'context-narration'
        )?.origin ?? 'business'
      const row = { id: requests.length + 1, phase, startedAt: Date.now(), request, deltas: [] }
      requests.push(row)
      const path = join(directory, `request-${row.id}.json`)
      await writeFile(path, JSON.stringify(row))
      try {
        for await (const delta of base.stream(request, requestSignal)) {
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
  }
  const driver = actionAdapter(audited, arm.action)
  const host = createLocalShellHost({ cwd: workspace })
  let runtime,
    status = 'starting',
    failure = null,
    session
  const startedAt = Date.now()
  try {
    await checkTaskResourceBudget(resources)
    for (const [path, content] of Object.entries(item.files)) {
      await mkdir(dirname(join(workspace, path)), { recursive: true })
      await writeFile(join(workspace, path), content)
    }
    runtime = await createRuntime({
      workspace,
      dataDir: join(root, 'state'),
      node: createNodeExecutionEnvironment({ cwd: workspace, directory: join(root, 'node'), host }),
      model: driver,
      protocol: { transport: 'tools', allowed: ['execute', 'done'] },
      project: false,
      agents: false,
      search: false,
      memory: false,
      context: {
        ...(arm.maintenance ? {} : { maintenance: false }),
        policy: { windowTokens: config.inputWindowTokens },
        ...(arm.review
          ? {
              completion: {
                kind: 'model-review',
                artifacts: new WorkspaceCompletionArtifacts(workspace),
              },
            }
          : {}),
      },
      limits: {
        turns: config.maxRequests,
        timeoutMs: config.timeoutMs,
        outputTokens: config.outputTokens,
        safetyTokens: 4096,
      },
    })
    session = await runtime.openSession(id + '-' + randomUUID())
    for (const [index, prompt] of item.prompts.entries()) {
      status = 'starting'
      for await (const event of session.submit(prompt, signal)) {
        events.push(event)
        await appendFile(
          join(directory, 'events.jsonl'),
          JSON.stringify({ phase: index + 1, event }) + '\n'
        )
        if (event.type === 'state') status = event.status
        if (event.type === 'interaction') {
          failure = 'Unattended task requested user input'
          session.cancel()
        }
      }
      const gradeRoot = join(root, `grading-${index + 1}`)
      await cp(workspace, gradeRoot, { recursive: true, verbatimSymlinks: true })
      const grading = await runCapturedCommand(
        process.execPath,
        [join(output, `grade-${item.id}.mjs`), gradeRoot, String(index + 1)],
        { cwd: gradeRoot, timeout: 30000, maxBuffer: 2_000_000 }
      )
      const result = {
        passed: grading.exitCode === 0,
        stdout: grading.stdout,
        stderr: grading.stderr,
        ...(grading.exitCode === 0
          ? {}
          : { error: redact(grading.error ?? `Grader exited ${grading.exitCode}`) }),
      }
      for (const path of item.preserve ?? [])
        if ((await readFile(join(workspace, path), 'utf8')) !== item.files[path]) {
          result.passed = false
          result.error = `Original input changed: ${path}`
        }
      grades.push({ phase: index + 1, status, ...result })
      await writeFile(
        join(directory, `grade-phase-${index + 1}.json`),
        JSON.stringify(grades.at(-1), null, 2)
      )
      if (status !== 'completed') break
    }
    await writeFile(
      join(directory, 'trace.json'),
      JSON.stringify(await runtime.trace(session.id, { fullContent: true }))
    )
  } catch (error) {
    failure = redact(error)
    status = 'failed'
  } finally {
    try {
      await runtime?.close()
      await host.dispose()
    } catch (error) {
      failure ??= redact(error)
    }
    await stopMonitor()
    for (const [key, value] of Object.entries(oldTmp)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await release()
  }
  const executionElapsedMs = Date.now() - startedAt
  await cp(workspace, join(directory, 'final-artifacts'), {
    recursive: true,
    verbatimSymlinks: true,
  })
  await archiveTaskResources(resources)
  let settlement
  try {
    settlement = await awaitGatewaySettlement(baseURL, credential)
  } catch (error) {
    await writeFile(
      join(directory, 'gateway-settlement.json'),
      JSON.stringify({ status: 'failed', error: redact(error) }, null, 2)
    )
    throw error
  }
  await writeFile(join(directory, 'gateway-settlement.json'), JSON.stringify(settlement, null, 2))
  const wires = ledger.state.requests.filter((row) => row.identity?.attemptId === id)
  const usageRows = wires.filter((row) => row.usage)
  const sum = (pick) => usageRows.reduce((total, row) => total + (pick(row.usage) ?? 0), 0)
  const inputTokens = sum((u) => u.input_tokens ?? u.prompt_tokens),
    outputTokens = sum((u) => u.output_tokens ?? u.completion_tokens),
    cacheReadTokens = sum((u) => (u.input_tokens_details ?? u.prompt_tokens_details)?.cached_tokens)
  const completeUsage = usageRows.length === wires.length && wires.length > 0
  const completeCache = completeUsage && usageRows.every((row) => Number.isFinite(row.estimatedUsd))
  const result = {
    id,
    task: item.id,
    repeat,
    arm: arm.id,
    status,
    success:
      status === 'completed' &&
      !failure &&
      grades.length === item.prompts.length &&
      grades.every((grade) => grade.passed),
    failure,
    grades: grades.map(({ phase, status, passed, error }) => ({ phase, status, passed, error })),
    elapsedMs: executionElapsedMs,
    settlementWaitMs: settlement.waitedMs,
    requests: requests.length,
    wireRequests: wires.length,
    rejectedBeforeDispatch: ledger.summary(identity).rejectedRequests,
    businessRequests: requests.filter((row) => row.phase === 'business').length,
    reviewRequests: requests.filter((row) => row.phase.startsWith('completion-')).length,
    maintenanceRequests: requests.filter((row) => row.phase === 'context-narration').length,
    unknownUsage: wires.length - usageRows.length,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    referenceUncachedUsd: completeUsage ? (inputTokens * 4 + outputTokens * 20) / 1e6 : null,
    referenceCachedUsd: completeCache
      ? usageRows.reduce((total, row) => total + row.estimatedUsd, 0)
      : null,
    completeUsage,
    completeCache,
    manualCoverage: 'pending',
  }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2))
  results.push(result)
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify(result))
}

try {
  for (const entry of order)
    await attempt(
      selected.find((item) => item.id === entry.task),
      arms.find((arm) => arm.id === entry.arm),
      entry.repeat
    )
} finally {
  gateway.closeAllConnections()
  await new Promise((resolve) => gateway.close(resolve))
  ledger.close()
  process.off('SIGTERM', cancel)
  process.off('SIGINT', cancel)
  await writeFile(
    join(output, 'campaign-summary.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        attempts: results.length,
        planned: order.length,
        successes: results.filter((result) => result.success).length,
        cancelled: cancellation.signal.aborted,
        budget: ledger.summary(),
      },
      null,
      2
    )
  )
  await verifyFrozen()
}
