// 用途：从已验收的原生任务生成独立工作树与冻结清单，复用当前 Desktop/Codex 运行产物。
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { privateJson, sha256 } from './client.mjs'
import { snapshotFiles, verifyFrozen } from './controller.mjs'
import { nativeContextPolicy } from './context-window.mjs'
import { normalizedGenerationPolicy } from '../harbor/budget-proxy.mjs'

const execute = promisify(execFile)
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"

/** 从当前目录重新枚举产物；旧候选的逐文件清单不能代表本次构建的目录。 */
export async function freezeCandidate(previous, requestedRoots, nativeRoot) {
  const roots = requestedRoots.length ? requestedRoots : previous.candidateRoots
  if (!Array.isArray(roots) || !roots.length)
    throw new Error(
      'Candidate artifact roots are required; pass --candidate-root for this template'
    )
  const candidateRoots = [...new Set(roots.map((path) => resolve(path)))].sort()
  const harnessFiles = (await readdir(nativeRoot))
    .filter((name) => name.endsWith('.mjs') || name.endsWith('.py'))
    .sort()
    .map((name) => join(nativeRoot, name))
  return {
    candidateRoots,
    candidate: await snapshotFiles([...candidateRoots, ...harnessFiles]),
  }
}

/** 模型总容量显式进入清单；工作窗口另从冻结 Agent 的实际策略取得。 */
export function pairedContextTokens(value) {
  if (!/^\d+$/.test(String(value))) throw new Error('Invalid paired context token capacity')
  const tokens = Number(value)
  if (!Number.isSafeInteger(tokens) || tokens <= 12000 + 4096)
    throw new Error('Invalid paired context token capacity')
  return tokens
}

/** 源任务直接使用仓库原生 runner，保持与零模型重放的配置一致。 */
export function nativeTestArgs(profile) {
  if (profile.runner === 'django') return [profile.python, 'tests/runtests.py', ...profile.args]
  if (profile.runner === 'sympy') return [profile.python, 'bin/test', ...profile.args]
  if (profile.runner === 'pytest') {
    const plugins = (profile.pytest_plugins ?? []).flatMap((plugin) => ['-p', plugin])
    return [profile.python, '-m', 'pytest', ...plugins, ...profile.args]
  }
  throw new Error('Unsupported native grading runner')
}

/** 与 grader 使用同一组输入指纹；验收之后修改配置或执行代码会阻断派发。 */
export async function nativeInputIdentity(taskDir, nativeRoot) {
  const profile = JSON.parse(await readFile(join(taskDir, 'native-test-profile.json'), 'utf8'))
  const inputs = {
    taskSha256: join(taskDir, 'task.json'),
    profileSha256: join(taskDir, 'native-test-profile.json'),
    testPatchSha256: join(taskDir, 'test.patch'),
    graderSha256: join(nativeRoot, 'grade.py'),
    preparerSha256: join(nativeRoot, 'prepare.py'),
  }
  if (profile.official_parser) {
    inputs.parserSourceSha256 = profile.official_parser.source
    inputs.parserConstantsSha256 = profile.official_parser.constants
  }
  const identity = { schema: 1 }
  for (const [name, path] of Object.entries(inputs)) identity[name] = sha256(await readFile(path))
  identity.environmentLockSha256 = await readFile(join(taskDir, 'native-environment-lock.json'))
    .then(sha256)
    .catch((error) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
  return identity
}

/** 旧记录或仅有通过状态的记录不能证明当前输入已经通过零模型验收。 */
export function verifyAcceptance(value, kind, taskId, identity) {
  if (value.status !== kind + '_verified' || value.kind !== kind || value.taskId !== taskId)
    throw new Error('Task has not passed zero-model ' + kind + ' acceptance')
  const actual = value.nativeInputIdentity
  const expectedKeys = Object.keys(identity).sort()
  if (
    !actual ||
    JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(expectedKeys) ||
    expectedKeys.some((key) => actual[key] !== identity[key]) ||
    value.modelCalls !== 0
  )
    throw new Error('Zero-model ' + kind + ' acceptance does not match current native inputs')
}

async function main() {
  const { values } = parseArgs({
    options: {
      template: { type: 'string' },
      task: { type: 'string' },
      attempt: { type: 'string' },
      baseline: { type: 'string' },
      oracle: { type: 'string' },
      'candidate-root': { type: 'string', multiple: true },
      'context-tokens': { type: 'string' },
      'evidence-root': { type: 'string', multiple: true },
    },
  })
  for (const key of ['template', 'task', 'attempt', 'baseline', 'oracle'])
    if (!values[key]) throw new Error('Missing --' + key)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,120}$/.test(values.attempt))
    throw new Error('Invalid attempt identity')
  const previous = JSON.parse(await readFile(values.template, 'utf8'))
  const contextTokens = pairedContextTokens(values['context-tokens'] ?? previous.contextTokens)
  const root = previous.campaignRoot,
    taskDir = resolve(values.task)
  const lease = await stat(join(root, 'active-controller.lock')).catch((error) => {
    if (error.code !== 'ENOENT') throw error
  })
  if (lease)
    throw new Error('The current campaign still has an active or unresolved controller lease')
  const task = JSON.parse(await readFile(join(taskDir, 'task.json'), 'utf8'))
  const profile = JSON.parse(await readFile(join(taskDir, 'native-test-profile.json'), 'utf8'))
  const nativeRoot = dirname(fileURLToPath(import.meta.url))
  const inputIdentity = await nativeInputIdentity(taskDir, nativeRoot)
  const receipts = {
    baselineResult: resolve(values.baseline),
    oracleResult: resolve(values.oracle),
  }
  for (const kind of ['baseline', 'oracle']) {
    const value = JSON.parse(await readFile(receipts[kind + 'Result'], 'utf8'))
    verifyAcceptance(value, kind, task.instance_id, inputIdentity)
  }
  const directory = join(root, 'runs', values.attempt)
  await mkdir(directory, { mode: 0o700 })
  const taskRoots = previous.evaluation?.files.map((f) => f.path) ?? []
  const { candidate, candidateRoots } = await freezeCandidate(
    previous,
    values['candidate-root'] ?? [],
    nativeRoot
  )
  const contextPolicy = await nativeContextPolicy(candidate, contextTokens)
  const evaluationRoots = [
    join(taskDir, 'task.json'),
    join(taskDir, 'test.patch'),
    join(taskDir, 'native-test-profile.json'),
    ...Object.values(receipts),
    join(root, 'task-registry.json'),
    ...taskRoots.filter((p) => p.includes('model-pricing-')),
    ...(values['evidence-root'] ?? []).map((path) => resolve(path)),
  ]
  if (profile.official_parser)
    evaluationRoots.push(profile.official_parser.source, profile.official_parser.constants)
  if (inputIdentity.environmentLockSha256)
    evaluationRoots.push(join(taskDir, 'native-environment-lock.json'))
  const evaluation = await snapshotFiles(evaluationRoots)
  const workspaces = {},
    prompts = {}
  const testArgs = nativeTestArgs(profile).map(quote).join(' ')
  for (const who of ['scriptact', 'codex']) {
    const workspace = join(taskDir, 'attempts', values.attempt, who)
    await mkdir(dirname(workspace), { recursive: true, mode: 0o700 })
    await execute('git', [
      '--git-dir',
      join(root, 'repositories', task.repo.replaceAll('/', '__')),
      'worktree',
      'add',
      '--detach',
      workspace,
      task.base_commit,
    ])
    await execute(previous.grader.python, [
      join(nativeRoot, 'prepare.py'),
      '--profile',
      join(taskDir, 'native-test-profile.json'),
      '--workspace',
      workspace,
      '--directory',
      join(directory, who + '-preparation'),
    ])
    workspaces[who] = workspace
    const pythonPath = profile.python_path.map((p) => (p === '.' ? '$PWD' : '$PWD/' + p)).join(':')
    prompts[who] =
      `${task.problem_statement}\n\nWork in ${workspace}. This is a macOS native coding task. The shared Python environment is already installed: ${profile.python}. Use PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 and PYTHONPATH="${pythonPath}". The relevant existing test command is ${testArgs}. Make the repository fix, verify it, and give a concise final explanation. Derive the fix from this base revision's source and tests. Ordinary API documentation is allowed. Do not retrieve completed fixes, solution pull requests, commit patches/diffs, or repository revisions after this base commit. Do not access other task workspaces, evaluator data, reference patches, or the other agent's artifacts. Preserve the shared environment; do not download container images. You have full local tool access.\n`
  }
  const manifest = {
    ...previous,
    generationPolicy: normalizedGenerationPolicy(previous.generationPolicy),
    directory,
    attemptId: values.attempt,
    candidate,
    candidateRoots,
    contextTokens,
    contextPolicy,
    evaluation,
    task: {
      id: task.instance_id,
      baseCommit: task.base_commit,
      directory: taskDir,
      ...receipts,
      workspaces,
      prompts,
    },
  }
  await verifyFrozen(candidate)
  await verifyFrozen(evaluation)
  const currentIdentity = await nativeInputIdentity(taskDir, nativeRoot)
  for (const kind of ['baseline', 'oracle'])
    verifyAcceptance(
      JSON.parse(await readFile(receipts[kind + 'Result'], 'utf8')),
      kind,
      task.instance_id,
      currentIdentity
    )
  const path = join(directory, 'frozen-manifest.json')
  await privateJson(path, manifest)
  const active = JSON.parse(await readFile(join(root, 'active-campaign.json'), 'utf8'))
  Object.assign(active, {
    status: 'ready',
    manifest: path,
    manifestSha256: sha256(await readFile(path)),
    candidateId: candidate.fingerprint,
    next_action: 'dispatch_native_pair',
  })
  await privateJson(join(root, 'active-campaign.json'), active)
  console.log(
    JSON.stringify({
      manifest: path,
      candidate: candidate.fingerprint,
      files: candidate.files.length,
      task: task.instance_id,
    })
  )
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  void main().catch((error) => {
    console.error(error.stack)
    process.exitCode = 1
  })
