#!/usr/bin/env node
// 先验收执行环境与独立评分器，再冻结候选、任务和工具；本步骤不请求模型。
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { toTrajectory } from '../harbor/atif.mjs'
import { runCapturedCommand } from './command-output.mjs'
import { verifyCampaignDriver } from './model-driver.mjs'
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
  createExecutionEnvironments,
  createTaskRoot,
  copyTaskWorkspace,
  acceptanceArguments,
  applyTaskEnvironment,
  pythonTaskPath,
  regressionArguments,
  regressionEnvironment,
  taskEnvironment,
  taskPrompt,
} from './task-environment.mjs'

const execute = promisify(execFile)
const root = resolve(import.meta.dirname, '../../..')
const campaign = resolve(process.argv[2])
const attemptId = process.argv[3] ?? 'rich-01'
const candidateName = process.argv[4] ?? 'candidate-v1'
const participants = process.argv[5] === 'scriptact' ? ['scriptact'] : ['scriptact', 'codex']
const taskFile = process.argv[6] ?? 'rich-ascii-task.json'
const scriptactCapabilities = process.argv[8] ?? 'on-demand'
runtimeCapabilityOptions(scriptactCapabilities)
const scriptactTaskMode = process.argv[9] ?? 'request'
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
const source = join(taskRoot, 'source', environment.project)
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
else await cp(join(campaign, environment.python), join(taskRoot, 'python'), { recursive: true })
const python = node ? undefined : join(taskRoot, 'python/bin/python')
const executable = node ?? python
const originalGrader = join(import.meta.dirname, environment.acceptance)
// 原项目测试可以生成文件；只在独立基线副本执行，冻结源码保持逐字不变。
const baselineSource = join(taskRoot, 'baseline', environment.project)
await copyTaskWorkspace(source, baselineSource, environment.runtime)
if (node) await copyNodeDependencies(source, baselineSource)
const env = {
  ...process.env,
  PYTHONPATH: pythonTaskPath(baselineSource),
  PYTHONDONTWRITEBYTECODE: '1',
}
const baselineReport = join(output, 'baseline.xml')
const baselineBuild = await buildNodeProject(environment, baselineSource, node, env)
if (baselineBuild) {
  await writeFile(join(output, 'baseline-build.json'), JSON.stringify(baselineBuild, null, 2))
  assert.equal(baselineBuild.exitCode, 0, 'The original project build must pass before a paid run')
}
const baselineRegression = await runCapturedCommand(
  executable,
  regressionArguments(environment, baselineReport),
  { cwd: baselineSource, env: regressionEnvironment(environment, env, baselineSource) }
)
await writeFile(join(output, 'baseline.log'), baselineRegression.stdout + baselineRegression.stderr)
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
    assert(summary.failed > 0 && summary.errors === 0, 'Node acceptance must report failing tests')
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
const pricing = JSON.parse(
  await readFile(
    join(root, '.velaros-workspace/bench/parallel-54/model-pricing-hedgeho9-sol-reference.json'),
    'utf8'
  )
)
const files = {}
const hash = (value) => createHash('sha256').update(value).digest('hex')
const harness = join(output, 'harness/agent')
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && !['__pycache__', 'node_modules'].includes(entry.name))
      await collect(path)
    else if (entry.isFile() && /\.(mjs|py|json)$/u.test(path)) {
      const destination = join(harness, relative(resolve(import.meta.dirname, '..'), path))
      await mkdir(dirname(destination), { recursive: true })
      await cp(path, destination)
      files[destination] = hash(await readFile(destination))
    }
  }
}
await collect(resolve(import.meta.dirname, '..'))
// 独立包验收复用仓库的受控打包器；与评分器一起复制并登记哈希，冻结后不读取工作树。
const packHelper = join(output, 'harness/release/safe-package-pack.mjs')
await mkdir(dirname(packHelper), { recursive: true })
await cp(join(root, 'scripts/release/safe-package-pack.mjs'), packHelper)
files[packHelper] = hash(await readFile(packHelper))
files[codex] = hash(await readFile(codex))
const candidate = join(campaign, candidateName)
// 本 campaign 的兼容供应商在 rich-06 首次请求明确拒绝显式断点；会话键继续使用。
const providerCapabilities = { openaiExplicitCacheBreakpoints: false }
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
    model: 'gpt-5.6-sol',
  }).schema_version,
  'ATIF-v1.8'
)
const grader = join(harness, 'long-tasks', environment.acceptance)
const controller = join(harness, 'long-tasks/run.mjs')
const manifest = {
  schema: 1,
  createdAt: new Date().toISOString(),
  attemptId,
  participants,
  controller,
  task,
  environment,
  taskRoot,
  source,
  python,
  node,
  grader,
  codex,
  codexVersion,
  dependencyLock,
  baselineRegression: { cases: baselineRegression.cases, verdict: baselineRegression.verdict },
  executionEnvironments,
  candidate,
  candidateId,
  candidateSourceCommit,
  candidateSourceDirty: candidateIdentity.sourceDirty ?? null,
  scriptactSessionId: `scriptact-${randomUUID()}`,
  scriptactCapabilities,
  scriptactTaskMode,
  modelWirePreflight,
  providerCapabilities,
  model: 'gpt-5.6-sol',
  contextTokens: 65536,
  inputWindowTokens: 32768,
  outputTokens: 12000,
  timeoutMs: 2700000,
  maxRequests: null,
  concurrency: 4,
  qualifications: {
    kind: task.split,
    longRunRequiresObservedCompaction: true,
    source:
      scriptactCapabilities === 'on-demand'
        ? 'formal Runtime and model provider composition with Shell/Node, on-demand project code, search, child agents, default context maintenance'
        : 'formal Runtime and model provider composition with Shell/Node, core runtime controls and default context maintenance',
    limitations: [
      'Task is newly authored and frozen on a real upstream project; model training exposure is unknown',
      'Runtime host comparison; this attempt does not exercise Desktop renderer integration',
    ],
  },
  prompt: taskPrompt(task, executable),
  credentials: join(root, '.velaros-workspace/bench/parallel-54/provider-hedgeho9-private.json'),
  accounting: {
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
    maxOutputTokens: 12000,
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
    baselineKnownFailures: baselineRegression.verdict.knownFailures,
    baselineRejectedByFeatureChecks: true,
  })
)
