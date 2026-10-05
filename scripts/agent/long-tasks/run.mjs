#!/usr/bin/env node
// 同一冻结任务先跑正式 ScriptAct，再跑本机 Codex；模型请求、整理、支线和验收分别留证。
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFile, cp, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { BudgetLedger, budgetServer } from '../harbor/budget-proxy.mjs'
import { attemptCredential } from '../harbor/request-identity.mjs'
import { createTraceExporter, snapshot } from '../harbor/trace-export.mjs'
import { readTraceArtifact } from '../harbor/trace-artifact.mjs'
import { toTrajectory } from '../harbor/atif.mjs'
import { runCodex } from '../native-desktop/codex.mjs'
import { campaignModelDriver } from './model-driver.mjs'
import { readPytestReport, regressionVerdict } from './regression.mjs'
import { runtimeCapabilityOptions } from './runtime-capabilities.mjs'
import {
  pythonTaskPath,
  regressionArguments,
  restoreTaskPaths,
  taskEnvironment,
} from './task-environment.mjs'

const execute = promisify(execFile)
const directory = resolve(process.argv[2])
const manifest = JSON.parse(await readFile(join(directory, 'freeze.json'), 'utf8'))
const capabilities = runtimeCapabilityOptions(manifest.scriptactCapabilities)
const scriptactSessionId = manifest.scriptactSessionId ?? 'development'
const environment = taskEnvironment(manifest.task)
assert.deepEqual(environment, manifest.environment)
assert.equal(
  import.meta.filename,
  manifest.controller ?? import.meta.filename,
  'Run the frozen controller path printed by prepare.mjs'
)
const recovery =
  process.argv[3] === '--resume-codex'
    ? JSON.parse(await readFile(join(directory, 'recovery.json'), 'utf8'))
    : null
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const candidate = manifest.candidate
const importAt = (file) => import(pathToFileURL(join(candidate, 'packages', file)))
const { createRuntime, createShellNodeEnvironment } = await importAt(
  'velaros/dist/act/runtime/index.js'
)
const { createLocalShellHost } = await importAt('velaros/dist/shell/local.js')
const modelPackage = await importAt('model/dist/index.js')
const credentials = JSON.parse(await readFile(manifest.credentials, 'utf8')).chat
const redact = (error) => String(error).replaceAll(credentials.apiKey, '[redacted]')
const identity = {
  taskId: manifest.task.id,
  sourceCommit: manifest.candidateSourceCommit ?? manifest.candidateId.split('-')[0],
  bundleFingerprint: manifest.candidateId,
  reasoningEffort: 'high',
}

async function verifyFrozen() {
  for (const [path, hash] of Object.entries(manifest.files)) {
    const replacement = recovery?.files[path]
    if (replacement) {
      assert.equal(path, import.meta.filename, 'Recovery may only repair this controller')
      assert.equal(replacement.originalSha256, hash)
      assert.equal(sha256(await readFile(join(directory, 'recovery/original-run.mjs'))), hash)
    }
    assert.equal(
      sha256(await readFile(path)),
      replacement?.sha256 ?? hash,
      `Frozen input changed: ${path}`
    )
  }
  const files = JSON.parse(await readFile(join(candidate, 'manifest.json'), 'utf8')).files
  for (const [path, hash] of Object.entries(files))
    assert.equal(sha256(await readFile(join(candidate, path))), hash, `Candidate changed: ${path}`)
  const commit = (
    await execute('git', ['rev-parse', 'HEAD'], { cwd: manifest.source })
  ).stdout.trim()
  assert.equal(commit, manifest.task.commit)
  assert.equal(
    (await execute('git', ['status', '--porcelain'], { cwd: manifest.source })).stdout.trim(),
    ''
  )
  assert.equal(
    (await execute(manifest.python, ['-m', 'pip', 'freeze'])).stdout,
    manifest.dependencyLock,
    'Frozen Python dependencies changed'
  )
}

const activity = async (value) => {
  const event = { at: new Date().toISOString(), ...value }
  await appendFile(join(directory, 'activity.jsonl'), JSON.stringify(event) + '\n')
  console.log(JSON.stringify(event))
}

async function copySource(destination) {
  await cp(manifest.source, destination, {
    recursive: true,
    filter: (path) => !['.git', '.pytest_cache', '__pycache__'].includes(path.split('/').at(-1)),
  })
  await execute('git', ['init', '-q'], { cwd: destination })
  await execute('git', ['add', '.'], { cwd: destination })
  await execute(
    'git',
    [
      '-c',
      'user.name=Evaluation',
      '-c',
      'user.email=evaluation@localhost',
      'commit',
      '-qm',
      'Frozen task baseline',
    ],
    { cwd: destination }
  )
}

async function check(command, args, cwd, name, output) {
  let result
  try {
    const value = await execute(command, args, {
      cwd,
      timeout: 180000,
      maxBuffer: 8_000_000,
      env: { ...process.env, PYTHONPATH: pythonTaskPath(cwd), PYTHONDONTWRITEBYTECODE: '1' },
    })
    result = { exitCode: 0, stdout: value.stdout, stderr: value.stderr }
  } catch (error) {
    result = {
      exitCode: error.code ?? null,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      error: redact(error),
      timedOut: error.killed ?? false,
    }
  }
  await snapshot(join(output, name + '.json'), result)
  return { exitCode: result.exitCode, output: name + '.json' }
}

async function grade(workspace, output) {
  // 验收复制真实产物；原项目测试从冻结源码恢复，防止删测试制造通过。
  const judge = join(manifest.taskRoot, `judge-${output.split('/').at(-1)}`)
  await cp(workspace, judge, {
    recursive: true,
    filter: (path) => !['.git', '.pytest_cache', '__pycache__'].includes(path.split('/').at(-1)),
  })
  await restoreTaskPaths(manifest.source, judge, environment.preserve)
  const acceptance = await check(
    manifest.python,
    ['-m', 'pytest', '-q', '--tb=short', '-p', 'no:cacheprovider', manifest.grader],
    judge,
    'acceptance',
    output
  )
  const regression = await check(
    manifest.python,
    regressionArguments(environment, join(output, 'regression.xml')),
    judge,
    'regression',
    output
  )
  if (environment.regressionRunner === 'pytest') {
    const result = JSON.parse(await readFile(join(output, 'regression.json'), 'utf8'))
    try {
      result.cases = await readPytestReport(manifest.python, join(output, 'regression.xml'))
      result.verdict = regressionVerdict(
        result,
        environment.baselineIssues,
        manifest.baselineRegression?.cases
      )
    } catch (error) {
      result.verdict = {
        baselineCompatible: false,
        suitePassed: false,
        knownFailures: [],
        unexpected: [String(error)],
      }
    }
    regression.verdict = result.verdict
    await snapshot(join(output, 'regression.json'), result)
  }
  const diff = await execute('git', ['diff', '--numstat'], { cwd: workspace })
  const untracked = await execute('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: workspace,
  })
  return {
    acceptance,
    regression,
    passed:
      acceptance.exitCode === 0 && (regression.verdict?.suitePassed ?? regression.exitCode === 0),
    featureCompleteWithoutNewRegressions:
      acceptance.exitCode === 0 &&
      (regression.verdict?.baselineCompatible ?? regression.exitCode === 0),
    changed: diff.stdout,
    created: untracked.stdout,
  }
}

async function scriptAct({ workspace, output, apiKey, baseURL, signal, python, prompt }) {
  const host = createLocalShellHost({ cwd: workspace })
  let runtime,
    session,
    exporter,
    requestCount = 0,
    status = 'starting',
    failure = null
  await mkdir(join(output, 'requests'))
  const transport = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url) === `${baseURL}/responses` && typeof init?.body === 'string') {
      const id = randomBytes(6).toString('hex')
      await snapshot(join(output, 'requests', `wire-${id}.json`), JSON.parse(init.body))
    }
    return transport(url, init)
  }
  const driver = campaignModelDriver(modelPackage, { ...manifest, apiKey, baseURL })
  const model = {
    id: driver.id,
    nativeTools: driver.nativeTools,
    limits: driver.limits,
    estimate: (request) => driver.estimate(request),
    async *stream(request, requestSignal) {
      const sequence = ++requestCount
      if (manifest.maxRequests != null && sequence > manifest.maxRequests)
        throw new Error('Evaluation request limit')
      const result = { sequence, startedAt: Date.now(), request, deltas: [] }
      const path = join(output, 'requests', `${String(sequence).padStart(4, '0')}.json`)
      await snapshot(path, result)
      await activity({ participant: 'scriptact', request: sequence })
      try {
        for await (const delta of driver.stream(request, requestSignal)) {
          result.deltas.push(delta)
          yield delta
        }
      } catch (error) {
        result.error = redact(error)
        throw error
      } finally {
        result.finishedAt = Date.now()
        await snapshot(path, result)
      }
    },
  }
  try {
    runtime = await createRuntime({
      workspace,
      dataDir: join(output, 'state'),
      model,
      memory: false,
      ...capabilities,
      node: createShellNodeEnvironment({
        cwd: workspace,
        directory: join(output, 'node'),
        shell: host,
      }),
      modelTools: { concurrency: manifest.concurrency },
      context: { policy: { windowTokens: manifest.inputWindowTokens } },
      environment: () => ({ cwd: workspace, python }),
      limits: {
        turns: manifest.maxRequests ?? 10000,
        timeoutMs: manifest.timeoutMs,
        outputTokens: manifest.outputTokens,
        safetyTokens: 4096,
      },
    })
    session = await runtime.openSession(scriptactSessionId)
    exporter = createTraceExporter({
      trace: (query) => runtime.trace(session.id, query),
      output,
      sessionId: session.id,
      instruction: prompt,
      identity,
      model: manifest.model,
    })
    for await (const event of session.submit(prompt, signal)) {
      await appendFile(join(output, 'events.jsonl'), JSON.stringify(event) + '\n')
      if (event.type === 'state') status = event.status
      if (event.type === 'error') failure = event.message
      if (event.type === 'interaction') {
        failure = 'Unattended task requested input'
        session.cancel()
      }
      if (event.type === 'turn') await exporter.export({ status, failure })
    }
  } catch (error) {
    failure = redact(error)
    status = 'failed'
  } finally {
    globalThis.fetch = transport
    try {
      await session?.close()
      await exporter?.export({ final: true, status, failure })
    } finally {
      await runtime?.close()
      await host.dispose()
    }
  }
  return { status, failure, requestCount }
}

await verifyFrozen()
if (recovery) {
  const output = join(directory, 'scriptact')
  const events = (await readFile(join(output, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
  assert.equal(events.at(-1).type, 'state')
  assert.equal(events.at(-1).status, recovery.terminalStatus)
  const trace = await readTraceArtifact(join(output, 'traces.json'))
  await snapshot(
    join(output, 'trajectory.json'),
    toTrajectory({
      sessionId: scriptactSessionId,
      instruction: manifest.executionEnvironments?.scriptact?.prompt ?? manifest.prompt,
      ...trace,
      identity,
      model: manifest.model,
    })
  )
  await snapshot(join(output, 'solve.json'), {
    status: recovery.terminalStatus,
    startedAt: recovery.startedAt,
    finishedAt: recovery.finishedAt,
    solveMs: recovery.finishedAt - recovery.startedAt,
    evaluatorRecovery: recovery.reason,
    timingSource: recovery.timingSource,
  })
  await snapshot(
    join(output, 'grade.json'),
    await grade(join(manifest.taskRoot, 'scriptact', environment.project), output)
  )
  await activity({ participant: 'scriptact', state: 'evidence-recovered', modelRerun: false })
}
const ledger = new BudgetLedger(join(directory, 'gateway'), 'unlimited', manifest.accounting)
const token = randomBytes(32).toString('hex')
const server = budgetServer({
  ledger,
  apiKey: credentials.apiKey,
  token,
  upstream: credentials.baseURL,
  requireIdentity: true,
  maxConcurrency: manifest.concurrency,
  perAttemptConcurrency: manifest.concurrency,
  generationPolicy: manifest.generationPolicy,
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseURL = `http://127.0.0.1:${server.address().port}/v1`
const cancellation = new AbortController()
const cancel = () => cancellation.abort(new Error('Controller interrupted'))
process.once('SIGINT', cancel)
process.once('SIGTERM', cancel)
try {
  for (const participant of recovery
    ? ['codex']
    : (manifest.participants ?? ['scriptact', 'codex'])) {
    cancellation.signal.throwIfAborted()
    await verifyFrozen()
    const output = join(directory, participant)
    await mkdir(output)
    const { python, prompt } = manifest.executionEnvironments?.[participant] ?? manifest
    assert.equal(
      (await execute(python, ['-m', 'pip', 'freeze'])).stdout,
      manifest.dependencyLock,
      'Participant must start with the frozen dependencies'
    )
    const workspace = join(manifest.taskRoot, participant, environment.project)
    await copySource(workspace)
    const apiKey = attemptCredential(
      {
        campaignId: 'long-runtime-20261004',
        candidateId: manifest.candidateId,
        participantId: participant,
        taskId: manifest.task.id,
        attemptId: `${manifest.attemptId}-${participant}`,
        jobId: manifest.attemptId,
        phase: 'source',
      },
      token
    )
    await activity({ participant, state: 'started', workspace })
    const startedAt = Date.now()
    const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(manifest.timeoutMs)])
    const result =
      participant === 'scriptact'
        ? await scriptAct({ workspace, output, apiKey, baseURL, signal, python, prompt })
        : await runCodex({
            executable: manifest.codex,
            workspace,
            directory: output,
            baseURL,
            apiKey,
            model: manifest.model,
            prompt,
            timeoutMs: manifest.timeoutMs,
            contextTokens: manifest.contextTokens,
            inputWindowTokens: manifest.inputWindowTokens,
            signal,
          })
    const solveMs = Date.now() - startedAt
    await snapshot(join(output, 'solve.json'), { ...result, startedAt, solveMs })
    const installed = await execute(python, ['-m', 'pip', 'freeze']).then(
      (value) => ({ finalDependencies: value.stdout }),
      (error) => ({ finalDependencies: null, inspectionError: redact(error) })
    )
    await snapshot(join(output, 'execution-environment.json'), {
      python,
      initialDependencies: manifest.dependencyLock,
      ...installed,
    })
    await activity({ participant, state: 'grading', solveMs })
    const grading = await grade(workspace, output)
    await snapshot(join(output, 'grade.json'), grading)
    await verifyFrozen()
    await activity({
      participant,
      state: 'finished',
      solveMs,
      passed: grading.passed,
      solve: result,
    })
    if (ledger.state.authenticationBlocker) throw new Error('Gateway authentication blocked')
  }
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  ledger.close()
  process.off('SIGINT', cancel)
  process.off('SIGTERM', cancel)
}
