#!/usr/bin/env node
// 先验收执行环境与独立评分器，再冻结候选、任务和工具；本步骤不请求模型。
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { toTrajectory } from '../harbor/atif.mjs'
import { runCapturedCommand } from './command-output.mjs'
import { freezeHarness } from './freeze-harness.mjs'
import { executionIsolation } from './execution-isolation.mjs'
import { verifyCampaignDriver } from './model-driver.mjs'
import {
  buildNodeProject,
  validateMaintainedNodeProject,
  copyNodeDependencies,
  nodeRegressionReport,
  nodeDependencyState,
  nodeTestSummary,
} from './node-task.mjs'
import {
  acquireTaskResources,
  archiveTaskResources,
  checkTaskCopyBudget,
  checkTaskResourceBudget,
  createTaskProcessGuard,
  registerTaskResources,
} from './resource-lifecycle.mjs'
import { readPytestReport, regressionVerdict } from './regression.mjs'
import { freezeRuntimeCompletion, runtimeCompletionOptions } from './runtime-completion.mjs'
import {
  runtimeCapabilityOptions,
  runtimeContextPolicy,
  runtimeEditingPrompt,
  runtimeSubmissionOptions,
} from './runtime-capabilities.mjs'
import {
  createExecutionEnvironments,
  copyPythonEnvironment,
  bindPythonCheckout,
  createTaskRoot,
  copyTaskWorkspace,
  acceptanceArguments,
  applyTaskEnvironment,
  pythonTaskPath,
  pythonProcessEnvironment,
  regressionArguments,
  regressionEnvironment,
  taskEnvironment,
  taskPrompt,
  taskTemporaryEnvironment,
  verifyCommandEnvironment,
} from './task-environment.mjs'

const execute = promisify(execFile)
const root = resolve(import.meta.dirname, '../../..')
const campaign = resolve(process.argv[2])
const configPath = resolve(process.argv[12] ?? join(campaign, 'config.json'))
const config = JSON.parse(await readFile(configPath, 'utf8'))
const isolation = executionIsolation()
assert(!config.desktop, 'An external Desktop process cannot inherit the evaluation signal boundary')
assert.equal(typeof config.model, 'string')
assert.equal(typeof config.credentials, 'string')
assert.equal(config.pricing.model, config.model)
for (const key of [
  'contextTokens',
  'inputWindowTokens',
  'outputTokens',
  'timeoutMs',
  'maxRequests',
  'budgetUsd',
])
  assert(Number.isSafeInteger(config[key]) && config[key] > 0, `Missing positive campaign ${key}`)
assert(config.inputWindowTokens + config.outputTokens < config.contextTokens)
runtimeContextPolicy(config)
assert(
  !config.desktop || config.runtimeRetainedFrameRatio === undefined,
  'Retained frame ablation requires direct Runtime configuration'
)
const attemptId = process.argv[3] ?? 'rich-01'
const candidateName = process.argv[4] ?? 'candidate-v1'
const participants = process.argv[5] === 'scriptact' ? ['scriptact'] : ['scriptact', 'codex']
const taskFile = process.argv[6] ?? 'rich-ascii-task.json'
const scriptactCapabilities = process.argv[8] ?? 'on-demand'
runtimeCapabilityOptions(scriptactCapabilities)
const scriptactTaskMode = process.argv[9] ?? 'request'
const scriptactEditingStrategy = process.argv[10] ?? 'adaptive'
runtimeEditingPrompt(scriptactCapabilities, scriptactEditingStrategy, '')
// 命令路径由准备时显式选定；原样冻结，运行时不继承启动控制器的偶然 PATH。
const commandEnvironment = {
  path: process.argv[11] ?? process.env.PATH ?? '',
  node: process.execPath,
  nodeVersion: process.version,
  platform: process.platform,
  arch: process.arch,
}
process.env.PATH = commandEnvironment.path
assert.match(attemptId, /^[a-zA-Z0-9-]+$/u)
assert.match(candidateName, /^[a-zA-Z0-9-]+$/u)
assert.ok(!process.argv[5] || ['scriptact', 'paired'].includes(process.argv[5]))
assert.match(taskFile, /^[a-zA-Z0-9][a-zA-Z0-9_-]*\.json$/u)
const taskPath = join(import.meta.dirname, taskFile)
const task = JSON.parse(await readFile(taskPath, 'utf8'))
runtimeSubmissionOptions(scriptactTaskMode, task.prompt)
if (process.argv[7]) {
  assert.equal(process.argv[7], 'development')
  task.split = 'development'
}
const environment = taskEnvironment(task)
applyTaskEnvironment(environment)
const node = environment.runtime === 'node' ? process.execPath : undefined
const output = join(campaign, attemptId)
await mkdir(output)
const taskRoot = await createTaskRoot()
const resources = await registerTaskResources(taskRoot, output, config.storage)
const releaseResources = await acquireTaskResources(resources)
let prepared = false
let preparationFailure
try {
  await checkTaskResourceBudget(resources)
  const commandPreflight = await verifyCommandEnvironment(commandEnvironment, Boolean(node))
  commandEnvironment.commands = commandPreflight.commands
  await writeFile(join(output, 'command-preflight.json'), JSON.stringify(commandPreflight, null, 2))
  if (participants.includes('codex')) {
    const workspace = join(taskRoot, 'process-preflight')
    const directory = join(output, 'process-preflight')
    await mkdir(workspace)
    await mkdir(directory)
    const guard = await createTaskProcessGuard(resources, workspace, directory)
    assert.equal((await guard.stop()).scopeEmpty, true)
  }
  const temporaryEnvironment = await taskTemporaryEnvironment(taskRoot)
  Object.assign(process.env, temporaryEnvironment)
  const source = join(taskRoot, 'source', environment.project)
  await checkTaskCopyBudget(resources, [
    { source: join(campaign, 'sources', environment.project), destination: source },
  ])
  await execute('git', [
    'clone',
    '-q',
    '--no-hardlinks',
    join(campaign, 'sources', environment.project),
    source,
  ])
  assert.equal(
    (await execute('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim(),
    task.commit
  )
  if (node) await copyNodeDependencies(join(campaign, 'sources', environment.project), source)
  else await copyPythonEnvironment(join(campaign, environment.python), join(taskRoot, 'python'))
  await checkTaskResourceBudget(resources)
  const python = node ? undefined : join(taskRoot, 'python/bin/python')
  const executable = node ?? python
  const originalGrader = join(import.meta.dirname, environment.acceptance)
  // 原项目测试可以生成文件；只在独立基线副本执行，冻结源码保持逐字不变。
  const baselineSource = join(taskRoot, 'baseline', environment.project)
  await checkTaskCopyBudget(resources, [{ source, destination: baselineSource }])
  await copyTaskWorkspace(source, baselineSource, environment.runtime)
  if (node) await copyNodeDependencies(source, baselineSource)
  else await bindPythonCheckout(python, baselineSource)
  await checkTaskResourceBudget(resources)
  const env = {
    ...(node ? process.env : pythonProcessEnvironment(python)),
    PYTHONPATH: pythonTaskPath(baselineSource),
    PYTHONDONTWRITEBYTECODE: '1',
  }
  const baselineReport = join(output, 'baseline.xml')
  const baselineBuild = await buildNodeProject(environment, baselineSource, node, env)
  if (baselineBuild) {
    await writeFile(join(output, 'baseline-build.json'), JSON.stringify(baselineBuild, null, 2))
    assert.equal(
      baselineBuild.exitCode,
      0,
      'The original project build must pass before a paid run'
    )
  }
  const baselineMaintained = await validateMaintainedNodeProject(
    environment,
    baselineSource,
    node,
    env
  )
  if (baselineMaintained) {
    await writeFile(
      join(output, 'baseline-maintained-validation.json'),
      JSON.stringify(baselineMaintained, null, 2)
    )
    assert.equal(
      baselineMaintained.exitCode,
      0,
      'The original maintained validation command must pass before a paid run'
    )
  }
  const baselineRegression = await runCapturedCommand(
    executable,
    regressionArguments(environment, baselineReport),
    { cwd: baselineSource, env: regressionEnvironment(environment, env, baselineSource) }
  )
  await writeFile(
    join(output, 'baseline.log'),
    baselineRegression.stdout + baselineRegression.stderr
  )
  if (node) {
    Object.assign(
      baselineRegression,
      nodeRegressionReport(baselineRegression, baselineSource, environment.regressionRunner)
    )
    baselineRegression.verdict = regressionVerdict(baselineRegression, environment.baselineIssues)
  } else if (environment.regressionRunner === 'pytest') {
    baselineRegression.cases = await readPytestReport(python, baselineReport)
    baselineRegression.verdict = regressionVerdict(baselineRegression, environment.baselineIssues)
  } else {
    const count = Number(
      `${baselineRegression.stdout}\n${baselineRegression.stderr}`.match(
        /Ran (\d+) tests? in/u
      )?.[1] ?? 0
    )
    baselineRegression.verdict = {
      baselineCompatible: baselineRegression.exitCode === 0 && count > 0,
      suitePassed: baselineRegression.exitCode === 0 && count > 0,
      knownFailures: [],
      unexpected: count > 0 ? [] : ['unittest did not discover any tests'],
    }
  }
  await writeFile(join(output, 'baseline.json'), JSON.stringify(baselineRegression, null, 2))
  assert(
    baselineRegression.verdict.baselineCompatible,
    'The frozen baseline must match its declared issues before a paid run'
  )
  let baselineRejected = false
  const acceptanceBaseline = await runCapturedCommand(
    executable,
    acceptanceArguments(environment, originalGrader),
    {
      cwd: baselineSource,
      env,
      timeout: 180000,
      maxBuffer: 8_000_000,
    }
  )
  if (acceptanceBaseline.exitCode !== 0) {
    assert.equal(
      acceptanceBaseline.exitCode,
      1,
      'Acceptance checks must fail assertions, not collection or setup'
    )
    if (node) {
      const summary = nodeTestSummary(acceptanceBaseline)
      assert(
        summary.failed > 0 && summary.errors === 0,
        'Node acceptance must report failing tests'
      )
    }
    assert(
      acceptanceBaseline.stdout.includes(environment.baselineFailure),
      'Unchanged source must fail the declared feature checks'
    )
    baselineRejected = true
    await writeFile(
      join(output, 'acceptance-baseline.log'),
      acceptanceBaseline.stdout + acceptanceBaseline.stderr
    )
  }
  assert.ok(baselineRejected, 'The unchanged project must not pass the new feature checks')
  const codex =
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
  const codexVersion = (await execute(codex, ['--version'])).stdout.trim()
  const dependencyLock = node
    ? await nodeDependencyState(source, node)
    : (await execute(python, ['-m', 'pip', 'freeze'])).stdout
  await writeFile(
    join(output, node ? 'node-dependencies.json' : 'python-requirements.txt'),
    node ? JSON.stringify(dependencyLock, null, 2) : dependencyLock
  )
  const executionEnvironments = node
    ? Object.fromEntries(
        participants.map((participant) => [participant, { node, prompt: taskPrompt(task, node) }])
      )
    : await createExecutionEnvironments({
        source: join(taskRoot, 'python'),
        taskRoot,
        participants,
        task,
      })
  executionEnvironments.scriptact.prompt = runtimeEditingPrompt(
    scriptactCapabilities,
    scriptactEditingStrategy,
    executionEnvironments.scriptact.prompt
  )
  const pricing = config.pricing
  const files = {}
  const hash = (value) => createHash('sha256').update(value).digest('hex')
  const harness = join(output, 'harness/agent')
  const agentScripts = resolve(import.meta.dirname, '..')
  Object.assign(files, await freezeHarness(agentScripts, harness))
  // 受控进程与打包器的所属脚本一起冻结，包含它们的本地依赖。
  const releaseScripts = join(root, 'scripts/release')
  Object.assign(files, await freezeHarness(releaseScripts, join(output, 'harness/release')))
  // 从冻结副本验证真实执行链；缺少依赖时在任何模型请求之前失败。
  const frozenCommands = await import(pathToFileURL(join(harness, 'long-tasks/command-output.mjs')))
  const harnessPreflight = await frozenCommands.runCapturedCommand(
    process.execPath,
    ['-e', 'process.stdout.write("frozen-harness-ready")'],
    { cwd: output }
  )
  await writeFile(join(output, 'harness-preflight.json'), JSON.stringify(harnessPreflight, null, 2))
  assert.equal(harnessPreflight.exitCode, 0, harnessPreflight.error)
  assert.equal(harnessPreflight.stdout, 'frozen-harness-ready')
  files[codex] = hash(await readFile(codex))
  files[commandEnvironment.node] = hash(await readFile(commandEnvironment.node))
  const candidate = join(campaign, candidateName)
  const runtimeCompletion = await freezeRuntimeCompletion(config.runtimeCompletion, output)
  let runtimeCompletionPreflight
  if (runtimeCompletion) {
    assert(!config.desktop, 'Runtime completion host configuration is only for direct Runtime runs')
    files[runtimeCompletion.module] = runtimeCompletion.sha256
    const workspace = join(taskRoot, 'completion-preflight')
    await mkdir(workspace)
    const text = 'Real workspace artifact for completion host readiness.'
    await writeFile(join(workspace, 'readiness.txt'), text)
    const createValidationHost = runtimeCompletion.validation
      ? (await import(pathToFileURL(join(candidate, 'packages/velaros/dist/act/runtime/index.js'))))
          .createNodeCompletionValidationHost
      : undefined
    const completion = await runtimeCompletionOptions(runtimeCompletion, workspace, {
      createValidationHost,
      executable: commandEnvironment.node,
    })
    const result = await completion.artifacts.capture(
      ['file:readiness.txt'],
      4096,
      new AbortController().signal
    )
    assert.deepEqual(result.issues, [])
    if (runtimeCompletion.validation) {
      const validation = await completion.validation.execute(
        {
          requirementIds: ['readiness'],
          artifacts: [{ identity: 'file:readiness.txt', sha256: hash(Buffer.from(text)) }],
          fingerprint: result.fingerprint,
          timeoutMs: 15000,
          maxOutputBytes: 4096,
          code: `import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';const files=JSON.parse(process.env.VELAR_REVIEW_INPUTS);assert.equal(await readFile(new URL(files['file:readiness.txt']),'utf8'),${JSON.stringify(text)});console.log('frozen-validation-ready');`,
        },
        AbortSignal.timeout(20000)
      )
      await writeFile(
        join(output, 'runtime-validation-preflight.json'),
        JSON.stringify(validation, null, 2) + '\n',
        { flag: 'wx' }
      )
      assert.equal(
        validation.status,
        'passed',
        'Frozen independent validation host must pass before model dispatch'
      )
      assert.equal(validation.stdout.trim(), 'frozen-validation-ready')
    }
    // 可选字段显式为 undefined 与缺省同义；仍要求实际完整正文及其原字节指纹。
    assert.deepEqual(
      result.materials.map(({ identity, text }) => ({ identity, text })),
      [{ identity: 'file:readiness.txt', text }]
    )
    assert.equal(result.materials[0].metadata, undefined)
    assert.equal(result.fingerprint.status, 'versioned')
    assert.equal(result.fingerprint.artifacts.length, 1)
    assert.equal(result.fingerprint.artifacts[0].identity, 'file:readiness.txt')
    assert.equal(result.fingerprint.artifacts[0].contentHash, hash(text))
    runtimeCompletionPreflight = { kind: completion.kind, artifactReadVerified: true }
    await writeFile(
      join(output, 'runtime-completion-preflight.json'),
      JSON.stringify({ ...runtimeCompletionPreflight, result }, null, 2)
    )
  }
  if (config.desktop) {
    for (const key of ['endpointFile', 'settingsFile', 'cdp', 'artifactManifest'])
      assert.equal(typeof config.desktop[key], 'string', `Missing Desktop ${key}`)
    const desktopArtifacts = JSON.parse(await readFile(config.desktop.artifactManifest, 'utf8'))
    assert(desktopArtifacts.files.length > 0, 'Desktop build identity is required')
    files[config.desktop.artifactManifest] = hash(await readFile(config.desktop.artifactManifest))
    for (const item of desktopArtifacts.files) {
      assert.equal(hash(await readFile(item.path)), item.sha256, 'Desktop artifacts changed')
      files[item.path] = item.sha256
    }
  }
  // 能力由本次配置冻结，不继承历史供应商假设。
  const providerCapabilities = config.providerCapabilities ?? {}
  const modelWirePreflight = await verifyCampaignDriver(
    await import(pathToFileURL(join(candidate, 'packages/model/dist/index.js'))),
    providerCapabilities
  )
  const candidateManifest = await readFile(join(candidate, 'manifest.json'), 'utf8')
  files[join(candidate, 'manifest.json')] = hash(candidateManifest)
  const candidateIdentity = JSON.parse(candidateManifest)
  const candidateSourceCommit = candidateIdentity.sourceCommit ?? 'unknown'
  const candidateId = `${candidateName}-${files[join(candidate, 'manifest.json')].slice(0, 12)}`
  // 在任何付费请求前覆盖终态导出的身份要求。
  assert.equal(
    toTrajectory({
      sessionId: 'preflight',
      instruction: task.prompt,
      traces: [],
      identity: { sourceCommit: candidateSourceCommit, bundleFingerprint: candidateId },
      model: config.model,
    }).schema_version,
    'ATIF-v1.8'
  )
  const grader = join(harness, 'long-tasks', environment.acceptance)
  const controller = join(harness, 'long-tasks/launch.mjs')
  const worker = join(harness, 'long-tasks/run.mjs')
  const manifest = {
    schema: 1,
    campaignId: config.campaignId ?? 'long-runtime-20261004',
    createdAt: new Date().toISOString(),
    attemptId,
    participants,
    controller,
    worker,
    campaignDirectory: campaign,
    executionIsolation: isolation,
    task,
    environment,
    taskRoot,
    resources,
    temporaryEnvironment,
    commandEnvironment,
    source,
    python,
    node,
    grader,
    codex,
    codexVersion,
    dependencyLock,
    baselineRegression: { cases: baselineRegression.cases, verdict: baselineRegression.verdict },
    baselineMaintainedValidation: baselineMaintained
      ? { exitCode: baselineMaintained.exitCode, output: 'baseline-maintained-validation.json' }
      : null,
    executionEnvironments,
    candidate,
    candidateId,
    candidateSourceCommit,
    candidateSourceDirty: candidateIdentity.sourceDirty ?? null,
    ...(config.desktop ? { desktop: config.desktop } : {}),
    ...(config.runtimeRetainedFrameRatio === undefined
      ? {}
      : { runtimeRetainedFrameRatio: config.runtimeRetainedFrameRatio }),
    ...(runtimeCompletion ? { runtimeCompletion, runtimeCompletionPreflight } : {}),
    scriptactSessionId: `scriptact-${randomUUID()}`,
    scriptactCapabilities,
    scriptactTaskMode,
    scriptactEditingStrategy,
    modelWirePreflight,
    harnessPreflight,
    providerCapabilities,
    model: config.model,
    contextTokens: config.contextTokens,
    inputWindowTokens: config.inputWindowTokens,
    outputTokens: config.outputTokens,
    timeoutMs: config.timeoutMs,
    maxRequests: config.maxRequests,
    budgetUsd: config.budgetUsd,
    concurrency: 4,
    qualifications: {
      kind: task.split,
      longRunRequiresObservedCompaction: true,
      source: {
        'on-demand':
          'formal Runtime and model provider composition with Node.js and Execa, on-demand project code, search, child agents, default context maintenance',
        node: 'formal Runtime and model provider composition with Node.js and Execa, core runtime controls and default context maintenance',
        project:
          'formal Runtime and model provider composition with Node.js and Execa, only velaros:project added to core runtime controls and default context maintenance',
      }[scriptactCapabilities],
      limitations: [
        'Task is newly authored and frozen on a real upstream project; model training exposure is unknown',
        config.desktop
          ? 'Desktop Hook, renderer, ChatService and product Runtime, including independent completion review'
          : runtimeCompletion
            ? 'Runtime host with independent completion review and a frozen production artifact adapter; Desktop renderer integration is separate'
            : 'Runtime host without independent completion review; Desktop renderer integration is separate',
      ],
    },
    prompt: taskPrompt(task, executable),
    credentials: config.credentials,
    accounting: {
      maxRequestsPerAttempt: config.maxRequests,
      perAttemptBudgetUsd: config.perAttemptBudgetUsd ?? null,
      reservationOutputTokens: config.outputTokens,
      model: pricing.model,
      reasoningEffort: 'high',
      pricingRef: `${pricing.source}#sha256=${hash(JSON.stringify(pricing))}`,
      pricingBasis: pricing.pricingBasis,
      pricing: {
        input: pricing.input,
        cached: pricing.cachedInput,
        write: pricing.cacheWriteInput,
        output: pricing.output,
        longThreshold: pricing.longThreshold,
        longInputMultiplier: pricing.longInputMultiplier,
        longOutputMultiplier: pricing.longOutputMultiplier,
      },
    },
    generationPolicy: {
      maxOutputTokens: config.outputTokens,
      reasoningContext: 'all_turns',
      reasoningSummary: 'auto',
      textVerbosity: 'medium',
    },
    files,
  }
  await writeFile(join(output, 'task.json'), JSON.stringify(task, null, 2) + '\n')
  await writeFile(join(output, 'freeze.json'), JSON.stringify(manifest, null, 2), {
    flag: 'wx',
    mode: 0o600,
  })
  console.log(
    JSON.stringify({
      output,
      taskRoot,
      codexVersion,
      frozenFiles: Object.keys(files).length,
      controller,
      participants,
      baselinePassed: baselineRegression.verdict.suitePassed,
      baselineMaintainedPassed: baselineMaintained ? baselineMaintained.exitCode === 0 : null,
      baselineKnownFailures: baselineRegression.verdict.knownFailures,
      baselineRejectedByFeatureChecks: true,
    })
  )

  await checkTaskResourceBudget(resources)
  prepared = true
} catch (error) {
  preparationFailure = error
  await writeFile(
    join(output, 'preparation-error.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        name: error.name,
        message: error.message,
        code: error.code,
      },
      null,
      2
    )
  )
  throw error
} finally {
  await releaseResources()
  if (!prepared) {
    try {
      await archiveTaskResources(resources)
    } catch (cleanup) {
      throw new AggregateError(
        [preparationFailure, cleanup].filter(Boolean),
        'Preparation failed; resource cleanup also failed and the original directory was retained'
      )
    }
  }
}
