#!/usr/bin/env node
// 先验收执行环境与独立评分器，再冻结候选、任务和工具；本步骤不请求模型。
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { toTrajectory } from '../harbor/atif.mjs'
import { verifyCampaignDriver } from './model-driver.mjs'
import { readPytestReport, regressionVerdict } from './regression.mjs'
import {
  createExecutionEnvironments,
  pythonTaskPath,
  regressionArguments,
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
assert.match(attemptId, /^[a-zA-Z0-9-]+$/u)
assert.match(candidateName, /^[a-zA-Z0-9-]+$/u)
assert.ok(!process.argv[5] || ['scriptact', 'paired'].includes(process.argv[5]))
assert.match(taskFile, /^[a-zA-Z0-9][a-zA-Z0-9_-]*\.json$/u)
const taskPath = join(import.meta.dirname, taskFile)
const task = JSON.parse(await readFile(taskPath, 'utf8'))
if (process.argv[7]) {
  assert.equal(process.argv[7], 'development')
  task.split = 'development'
}
const environment = taskEnvironment(task)
const output = join(campaign, attemptId)
await mkdir(output)
const taskRoot = await mkdtemp('/private/tmp/vlr-')
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
await cp(join(campaign, environment.python), join(taskRoot, 'python'), { recursive: true })
const python = join(taskRoot, 'python/bin/python')
const originalGrader = join(import.meta.dirname, environment.acceptance)
const baselineArgs = ['-m', 'pytest', '-q', '--tb=short', '-p', 'no:cacheprovider']
// 原项目测试可以生成文件；只在独立基线副本执行，冻结源码保持逐字不变。
const baselineSource = join(taskRoot, 'baseline', environment.project)
await execute('git', ['clone', '-q', '--no-hardlinks', source, baselineSource])
const env = {
  ...process.env,
  PYTHONPATH: pythonTaskPath(baselineSource),
  PYTHONDONTWRITEBYTECODE: '1',
}
const baselineReport = join(output, 'baseline.xml')
let baselineRegression
try {
  const result = await execute(python, regressionArguments(environment, baselineReport), {
    cwd: baselineSource,
    env,
    timeout: 180000,
    maxBuffer: 8_000_000,
  })
  baselineRegression = { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
} catch (error) {
  baselineRegression = {
    exitCode: error.code ?? null,
    stdout: error.stdout ?? '',
    stderr: error.stderr ?? '',
  }
}
await writeFile(join(output, 'baseline.log'), baselineRegression.stdout + baselineRegression.stderr)
if (environment.regressionRunner === 'pytest') {
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
try {
  await execute(python, [...baselineArgs, originalGrader], {
    cwd: baselineSource,
    env,
    timeout: 180000,
    maxBuffer: 8_000_000,
  })
} catch (error) {
  assert.equal(error.code, 1, 'Acceptance checks must fail assertions, not collection or setup')
  assert(
    error.stdout.includes(environment.baselineFailure),
    'Unchanged source must fail the declared feature checks'
  )
  baselineRejected = true
  await writeFile(join(output, 'acceptance-baseline.log'), error.stdout + error.stderr)
}
assert.ok(baselineRejected, 'The unchanged project must not pass the new feature checks')
const codex =
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
const codexVersion = (await execute(codex, ['--version'])).stdout.trim()
const dependencyLock = (await execute(python, ['-m', 'pip', 'freeze'])).stdout
await writeFile(join(output, 'python-requirements.txt'), dependencyLock)
const executionEnvironments = await createExecutionEnvironments({
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
      'formal Runtime and model provider composition with Node, project code, search, child agents, default context maintenance',
    limitations: [
      'Task is newly authored and frozen on a real upstream project; model training exposure is unknown',
      'Runtime host comparison; this attempt does not exercise Desktop renderer integration',
    ],
  },
  prompt: taskPrompt(task, python),
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
