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
import { awaitGatewaySettlement } from '../mechanism-ab/settlement.mjs'
import { runDesktopTask } from './desktop-host.mjs'
import { runCapturedCommand } from './command-output.mjs'
import { verifyIsolatedWorker } from './execution-isolation.mjs'
import { campaignModelDriver } from './model-driver.mjs'
import {
  buildNodeProject,
  validateMaintainedNodeProject,
  copyNodeDependencies,
  nodeRegressionReport,
  nodeDependencyState,
  nodeTestSummary,
} from './node-task.mjs'
import { readPytestReport, regressionVerdict } from './regression.mjs'
import {
  runtimeCapabilityOptions,
  runtimeContextPolicy,
  runtimeSubmissionOptions,
} from './runtime-capabilities.mjs'
import { runtimeCompletionOptions } from './runtime-completion.mjs'
import { runtimeEventStatus } from './runtime-status.mjs'
import {
  pythonTaskPath,
  pythonProcessEnvironment,
  executionCommandEnvironment,
  acceptanceArguments,
  applyTaskEnvironment,
  bindPythonCheckout,
  copyTaskWorkspace,
  regressionArguments,
  regressionEnvironment,
  restoreTaskPaths,
  taskEnvironment,
  taskTemporaryEnvironment,
  verifyCommandEnvironment,
} from './task-environment.mjs'
import { workspaceChanges } from './workspace-changes.mjs'
import {
  acquireTaskResources,
  checkTaskCopyBudget,
  checkTaskResourceBudget,
  createTaskProcessGuard,
  monitorTaskResources,
} from './resource-lifecycle.mjs'
import { preserveWorkspaceEvidence } from './workspace-evidence.mjs'
import { monitorHostIo } from './host-health.mjs'

const execute = promisify(execFile)
const directory = resolve(process.argv[2])
const manifest = JSON.parse(await readFile(join(directory, 'freeze.json'), 'utf8'))
const isolation = await verifyIsolatedWorker(directory, manifest)
if (manifest.commandEnvironment) {
  const expected = manifest.commandEnvironment
  assert.equal(process.execPath, expected.node, 'Run the frozen Node executable')
  assert.equal(process.version, expected.nodeVersion)
  assert.equal(process.platform, expected.platform)
  assert.equal(process.arch, expected.arch)
  process.env.PATH = expected.path
  if (expected.commands)
    assert.deepEqual(
      (await verifyCommandEnvironment(expected, Boolean(manifest.node))).commands,
      expected.commands,
      'Frozen toolchain versions changed'
    )
}
const capabilities = runtimeCapabilityOptions(manifest.scriptactCapabilities)
const submission = runtimeSubmissionOptions(manifest.scriptactTaskMode, manifest.task.prompt)
const scriptactSessionId = manifest.scriptactSessionId ?? 'development'
const environment = taskEnvironment(manifest.task)
assert.deepEqual(environment, manifest.environment)
applyTaskEnvironment(environment)
if (manifest.temporaryEnvironment) {
  const temporaryEnvironment = await taskTemporaryEnvironment(manifest.taskRoot)
  assert.deepEqual(temporaryEnvironment, manifest.temporaryEnvironment)
  Object.assign(process.env, temporaryEnvironment)
}
assert.equal(
  import.meta.filename,
  manifest.worker,
  'Run the frozen launcher path printed by prepare.mjs'
)
const recovery =
  process.argv[3] === '--resume-codex'
    ? JSON.parse(await readFile(join(directory, 'recovery.json'), 'utf8'))
    : null
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const candidate = manifest.candidate
const importAt = (file) => import(pathToFileURL(join(candidate, 'packages', file)))
const { createRuntime, createNodeExecutionEnvironment, createNodeCompletionValidationHost } =
  await importAt('velaros/dist/act/runtime/index.js')
const { createLocalShellHost } = await importAt('velaros/dist/execution/local.js')
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
  if (manifest.resources)
    await checkTaskCopyBudget(
      manifest.resources,
      [{ source: manifest.source, destination, count: 2 }],
      cancellation.signal
    )
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
  const result = await runCapturedCommand(command, args, {
    cwd,
    env: {
      ...(environment.runtime === 'node'
        ? processEnvironment
        : pythonProcessEnvironment(command, processEnvironment)),
      PYTHONPATH: pythonTaskPath(cwd),
      PYTHONDONTWRITEBYTECODE: '1',
    },
  })
  if (result.error) result.error = redact(result.error)
  await snapshot(join(output, name + '.json'), result)
  return { exitCode: result.exitCode, output: name + '.json' }
}

async function grade(workspace, output) {
  if (manifest.resources)
    await checkTaskCopyBudget(
      manifest.resources,
      [
        {
          source: workspace,
          destination: join(manifest.taskRoot, 'grading'),
          count: environment.maintainedValidation ? 2 : 1,
        },
        {
          source: manifest.source,
          destination: join(manifest.taskRoot, 'grading'),
          count: environment.maintainedValidation ? 2 : 1,
        },
      ],
      cancellation.signal
    )
  let maintainedValidation = null
  if (environment.maintainedValidation) {
    const maintained = join(manifest.taskRoot, `maintained-${output.split('/').at(-1)}`)
    await copyTaskWorkspace(workspace, maintained, environment.runtime)
    await copyNodeDependencies(manifest.source, maintained)
    const result = await validateMaintainedNodeProject(environment, maintained, manifest.node)
    await snapshot(join(output, 'maintained-validation.json'), result)
    maintainedValidation = { exitCode: result.exitCode, output: 'maintained-validation.json' }
  }
  // 验收复制真实产物；原项目测试从冻结源码恢复，防止删测试制造通过。
  const judge = join(manifest.taskRoot, `judge-${output.split('/').at(-1)}`)
  await copyTaskWorkspace(workspace, judge, environment.runtime)
  await restoreTaskPaths(manifest.source, judge, environment.preserve)
  if (environment.runtime === 'node') await copyNodeDependencies(manifest.source, judge)
  else await bindPythonCheckout(manifest.python, judge)
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
    ...(maintainedValidation ? { maintainedValidation } : {}),
    ...(build ? { build: { exitCode: build.exitCode, output: 'build.json' } } : {}),
    acceptance,
    regression,
    passed:
      (!maintainedValidation || maintainedValidation.exitCode === 0) &&
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

async function scriptAct({
  workspace,
  output,
  apiKey,
  baseURL,
  signal,
  python,
  node,
  prompt,
  deadline,
}) {
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
      node: createNodeExecutionEnvironment({
        cwd: workspace,
        directory: join(output, 'node'),
        host,
        executable: manifest.commandEnvironment?.node,
        environment: executionCommandEnvironment(python, manifest.commandEnvironment),
      }),
      modelTools: { concurrency: manifest.concurrency },
      context: {
        policy: runtimeContextPolicy(manifest),
        completion: await runtimeCompletionOptions(manifest.runtimeCompletion, workspace, {
          createValidationHost: createNodeCompletionValidationHost,
          executable: node,
          signal,
        }),
      },
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
    for await (const event of session.submit(prompt, signal, { ...submission, deadline })) {
      await appendFile(join(output, 'events.jsonl'), JSON.stringify(event) + '\n')
      ;({ status, failure } = runtimeEventStatus({ status, failure }, event))
      if (event.type === 'interaction') {
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

const resources = manifest.resources
const cancellation = new AbortController()
let closeGatewayConnections = () => {}
const hostHealth = monitorHostIo({
  directory,
  onFailure(error) {
    cancellation.abort(error)
    closeGatewayConnections()
  },
})
process.once('exit', () => hostHealth.stop())
const releaseResources = resources ? await acquireTaskResources(resources) : null
let finished = false
try {
  await verifyFrozen()
  if (resources) await checkTaskResourceBudget(resources)
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
  const ledger = new BudgetLedger(
    join(directory, 'gateway'),
    manifest.budgetUsd ?? 'unlimited',
    manifest.accounting
  )
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
    catalogContextTokens: manifest.desktop ? manifest.contextTokens : null,
  })
  closeGatewayConnections = () => {
    server.close()
    server.closeAllConnections()
  }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`
  const cancel = () => cancellation.abort(new Error('Controller interrupted'))
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  const stopMonitor = resources
    ? monitorTaskResources(resources, (error) => cancellation.abort(error))
    : null
  try {
    for (const participant of recovery
      ? ['codex']
      : (manifest.participants ?? ['scriptact', 'codex'])) {
      cancellation.signal.throwIfAborted()
      hostHealth.assertHealthy()
      hostHealth.setPhase(`${participant}:preparing`)
      if (resources) await checkTaskResourceBudget(resources)
      await verifyFrozen()
      const output = join(directory, participant)
      await mkdir(output)
      const {
        python,
        node,
        prompt: taskPrompt,
      } = manifest.executionEnvironments?.[participant] ?? manifest
      process.env.PATH = executionCommandEnvironment(python, manifest.commandEnvironment).PATH
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
          campaignId: manifest.campaignId ?? 'long-runtime-20261004',
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
      hostHealth.setPhase(`${participant}:executing`)
      const startedAt = Date.now()
      const deadline = startedAt + manifest.timeoutMs
      const prompt = `${taskPrompt}\n\nHost execution window: started ${new Date(startedAt).toISOString()} (Unix milliseconds ${startedAt}); hard deadline ${new Date(deadline).toISOString()} (Unix milliseconds ${deadline}); total ${manifest.timeoutMs} ms. Plan execution, verification and the final response within this window. External cancellation or other limits may end the run earlier.`
      await snapshot(join(output, 'execution-window.json'), {
        startedAt,
        deadline,
        timeoutMs: manifest.timeoutMs,
        taskPrompt,
        submittedPrompt: prompt,
      })
      const signal = AbortSignal.any([
        cancellation.signal,
        AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      ])
      const processGuard = resources
        ? await createTaskProcessGuard(resources, workspace, output)
        : undefined
      let result
      let runtimeCleanup
      try {
        result =
          participant === 'scriptact'
            ? manifest.desktop
              ? await runDesktopTask({
                  manifest,
                  workspace,
                  output,
                  apiKey,
                  baseURL,
                  signal,
                  prompt,
                })
              : await scriptAct({
                  workspace,
                  output,
                  apiKey,
                  baseURL,
                  signal,
                  python,
                  node,
                  prompt,
                  deadline,
                })
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
                processGuard,
              })
      } finally {
        if (participant === 'scriptact') runtimeCleanup = await processGuard?.stop()
      }
      if (runtimeCleanup) result.ownedProcessCleanup = runtimeCleanup
      const solveMs = Date.now() - startedAt
      hostHealth.setPhase(`${participant}:finalizing`)
      hostHealth.assertHealthy()
      const solve = { ...result, startedAt, solveMs }
      await snapshot(join(output, 'solve.json'), solve)
      await snapshot(
        join(output, 'gateway-settlement.json'),
        await awaitGatewaySettlement(baseURL, apiKey)
      )
      await snapshot(join(output, 'solve.json'), {
        ...solve,
        settledAt: Date.now(),
        upstreamSettlementMs: Date.now() - startedAt - solveMs,
        totalParticipantMs: Date.now() - startedAt,
      })
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
      hostHealth.setPhase(`${participant}:grading`)
      let grading
      try {
        cancellation.signal.throwIfAborted()
        if (resources)
          await checkTaskCopyBudget(
            resources,
            [
              { source: workspace, destination: join(output, 'source-evidence') },
              {
                source: workspace,
                destination: join(manifest.taskRoot, 'grading'),
                count: environment.maintainedValidation ? 2 : 1,
              },
              {
                source: manifest.source,
                destination: join(manifest.taskRoot, 'grading'),
                count: environment.maintainedValidation ? 2 : 1,
              },
            ],
            cancellation.signal
          )
        await preserveWorkspaceEvidence(workspace, output, baseline)
        grading = await grade(workspace, output)
      } catch (error) {
        await snapshot(join(output, 'grading-deferred.json'), {
          status: 'deferred',
          reason: redact(error),
          workspace,
          originalSolvePreserved: true,
          modelRerun: false,
        })
        throw error
      }
      await snapshot(join(output, 'grade.json'), grading)
      await verifyFrozen()
      hostHealth.assertHealthy()
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
    hostHealth.setPhase('closing-gateway-and-resource-monitor')
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    ledger.close()
    process.off('SIGINT', cancel)
    process.off('SIGTERM', cancel)
    await stopMonitor?.()
  }
  hostHealth.assertHealthy()
  finished = true
} finally {
  hostHealth.setPhase('releasing-and-archiving-resources')
  await releaseResources?.()
  hostHealth.stop()
  if (finished)
    await snapshot(join(directory, 'isolation', `${isolation.launchId}.completed.json`), {
      launchId: isolation.launchId,
      finished,
    })
}
