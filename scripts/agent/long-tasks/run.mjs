#!/usr/bin/env node
// 同一冻结任务先跑正式 ScriptAct，再跑本机 Codex；模型请求、整理、支线和验收分别留证。
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
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
import {
  buildNodeProject,
  copyNodeDependencies,
  nodeRegressionReport,
  nodeDependencyState,
  nodeTestSummary,
} from './node-task.mjs'
import { readPytestReport, regressionVerdict } from './regression.mjs'
import { runtimeCapabilityOptions, runtimeSubmissionOptions } from './runtime-capabilities.mjs'
import {
  pythonTaskPath,
  acceptanceArguments,
  applyTaskEnvironment,
  bindPythonCheckout,
  copyTaskWorkspace,
  regressionArguments,
  regressionEnvironment,
  restoreTaskPaths,
  taskEnvironment,
} from './task-environment.mjs'
import { workspaceChanges } from './workspace-changes.mjs'

const execute = promisify(execFile)
const directory = resolve(process.argv[2])
const manifest = JSON.parse(await readFile(join(directory, 'freeze.json'), 'utf8'))
const capabilities = runtimeCapabilityOptions(manifest.scriptactCapabilities)
const submission = runtimeSubmissionOptions(manifest.scriptactTaskMode, manifest.task.prompt)
const scriptactSessionId = manifest.scriptactSessionId ?? 'development'
const environment = taskEnvironment(manifest.task)
assert.deepEqual(environment, manifest.environment)
applyTaskEnvironment(environment)
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
  assert.deepEqual(
    environment.runtime === 'node'
      ? await nodeDependencyState(manifest.source, manifest.node)
      : (await execute(manifest.python, ['-m', 'pip', 'freeze'])).stdout,
    manifest.dependencyLock,
    'Frozen task dependencies changed'
  )
}

const activity = async (value) => {
  const event = { at: new Date().toISOString(), ...value }
  await appendFile(join(directory, 'activity.jsonl'), JSON.stringify(event) + '\n')
  console.log(JSON.stringify(event))
}

async function copySource(destination, output) {
  await copyTaskWorkspace(manifest.source, destination, environment.runtime)
  if (environment.runtime === 'node') await copyNodeDependencies(manifest.source, destination)
  const build = await buildNodeProject(environment, destination, manifest.node)
  if (build) {
    await snapshot(join(output, 'initial-build.json'), build)
    assert.equal(build.exitCode, 0, 'The frozen project build must pass before a participant runs')
  }
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
  return (await execute('git', ['rev-parse', 'HEAD'], { cwd: destination })).stdout.trim()
}

async function check(command, args, cwd, name, output, processEnvironment = process.env) {
  let result
  try {
    const value = await execute(command, args, {
      cwd,
      timeout: 180000,
      maxBuffer: 8_000_000,
      env: { ...processEnvironment, PYTHONPATH: pythonTaskPath(cwd), PYTHONDONTWRITEBYTECODE: '1' },
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
  await copyTaskWorkspace(workspace, judge, environment.runtime)
  await restoreTaskPaths(manifest.source, judge, environment.preserve)
  if (environment.runtime === 'node') await copyNodeDependencies(manifest.source, judge)
  const build = await buildNodeProject(environment, judge, manifest.node)
  if (build) await snapshot(join(output, 'build.json'), build)
  const acceptance = await check(
    manifest.node ?? manifest.python,
    acceptanceArguments(environment, manifest.grader),
    judge,
    'acceptance',
    output
  )
  const regression = await check(
    manifest.node ?? manifest.python,
    regressionArguments(environment, join(output, 'regression.xml')),
    judge,
    'regression',
    output,
    regressionEnvironment(environment, process.env, judge)
  )
  if (environment.runtime === 'node' || environment.regressionRunner === 'pytest') {
    const result = JSON.parse(await readFile(join(output, 'regression.json'), 'utf8'))
    try {
      if (environment.runtime === 'node')
        Object.assign(result, nodeRegressionReport(result, judge, environment.regressionRunner))
      else result.cases = await readPytestReport(manifest.python, join(output, 'regression.xml'))
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
  const baseline = await readFile(join(output, 'workspace-baseline.json'), 'utf8')
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
  const acceptanceSummary =
    environment.runtime === 'node'
      ? nodeTestSummary(JSON.parse(await readFile(join(output, 'acceptance.json'), 'utf8')))
      : null
  const acceptancePassed =
    acceptance.exitCode === 0 &&
    (!acceptanceSummary ||
      (acceptanceSummary.passed > 0 &&
        acceptanceSummary.errors === 0 &&
        acceptanceSummary.failed === 0))
  return {
    ...(build ? { build: { exitCode: build.exitCode, output: 'build.json' } } : {}),
    acceptance,
    regression,
    passed:
      (!build || build.exitCode === 0) &&
      acceptancePassed &&
      (regression.verdict?.suitePassed ?? regression.exitCode === 0),
    featureCompleteWithoutNewRegressions:
      (!build || build.exitCode === 0) &&
      acceptancePassed &&
      (regression.verdict?.baselineCompatible ?? regression.exitCode === 0),
    ...(await workspaceChanges(workspace, baseline?.commit)),
  }
}

async function scriptAct({ workspace, output, apiKey, baseURL, signal, python, node, prompt }) {
  const host = createLocalShellHost({ cwd: workspace })
  let runtime,
    session,
    exporter,
    requestCount = 0,
    status = 'starting',
    failure = null,
    goal = null,
    goalSnapshotError = null
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
      environment: () => ({ cwd: workspace, ...(node ? { node } : { python }) }),
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
    for await (const event of session.submit(prompt, signal, submission)) {
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
      if (manifest.scriptactTaskMode === 'goal' && session) {
        try {
          goal = await session.getGoal()
        } catch (error) {
          goalSnapshotError = redact(error)
        }
      }
      await session?.close()
      await exporter?.export({ final: true, status, failure })
    } finally {
      await runtime?.close()
      await host.dispose()
    }
  }
  return {
    status,
    failure,
    requestCount,
    ...(manifest.scriptactTaskMode === 'goal' ? { goal, goalSnapshotError } : {}),
  }
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
    const { python, node, prompt } = manifest.executionEnvironments?.[participant] ?? manifest
    const workspace = join(manifest.taskRoot, participant, environment.project)
    const baseline = await copySource(workspace, output)
    const sourceBinding = python ? await bindPythonCheckout(python, workspace) : null
    if (sourceBinding) await snapshot(join(output, 'source-binding.json'), sourceBinding)
    assert.deepEqual(
      node
        ? await nodeDependencyState(workspace, node)
        : (await execute(python, ['-m', 'pip', 'freeze'])).stdout,
      manifest.dependencyLock,
      'Participant must start with the frozen dependencies'
    )
    await snapshot(join(output, 'workspace-baseline.json'), { commit: baseline })
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
        ? await scriptAct({ workspace, output, apiKey, baseURL, signal, python, node, prompt })
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
    const installed = await (
      node
        ? nodeDependencyState(workspace, node)
        : execute(python, ['-m', 'pip', 'freeze']).then((value) => value.stdout)
    ).then(
      (value) => ({ finalDependencies: value }),
      (error) => ({ finalDependencies: null, inspectionError: redact(error) })
    )
    await snapshot(join(output, 'execution-environment.json'), {
      python,
      node,
      sourceBinding,
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
