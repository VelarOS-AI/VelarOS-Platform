/**
 * @test-meta
 * title: VelarOS operational command line
 * summary: 发布契约：构建后验证命令行分发产物与帮助信息。
 * area: packages
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from 'bun:test'

const cliPath = new URL('../dist/cli.js', import.meta.url)
const packageRoot = new URL('../', import.meta.url)
const packageManifestPath = new URL('../package.json', import.meta.url)

test('velaros cli composes product-owned namespaces through registration', async () => {
  const { createVelarosCliRouter } = await import(cliPath.href)
  const calls = []
  const runVelarosCli = createVelarosCliRouter({
    namespaces: {
      browser: (argv, options) => {
        calls.push({ argv, options })
        return {
          exitCode: 0,
          text: 'browser ready\n',
          json: false,
        }
      },
    },
  })

  const result = await runVelarosCli(['browser', 'open', 'https://example.com'], {
    cwd: '/tmp/project',
  })

  assert.equal(result.exitCode, 0)
  assert.equal(result.text, 'browser ready\n')
  assert.deepEqual(calls, [{
    argv: ['open', 'https://example.com'],
    options: { cwd: '/tmp/project' },
  }])

  const help = await runVelarosCli(['help', '--json'])
  assert.deepEqual(JSON.parse(help.text).result.namespaces, [
    'agent',
    'browser',
    'terminal',
  ])
})

test('VelarosCliRouter supports a minimal third-party namespace set', async () => {
  const { VelarosCliRouter } = await import(cliPath.href)
  let now = 100
  const router = new VelarosCliRouter({
    includeBuiltinNamespaces: false,
    now: () => now++,
    resolveDefaultCwd: () => '/embedded/application',
    namespaces: {
      custom: () => ({
        exitCode: 0,
        text: 'custom ready\n',
        json: false,
      }),
    },
  })

  assert.deepEqual(router.listNamespaces(), ['custom'])
  const help = await router.run(['help', '--json'])
  const payload = JSON.parse(help.text)
  assert.deepEqual(payload.result.namespaces, ['custom'])
  assert.equal(payload.cwd, '/embedded/application')
  assert.equal(payload.durationMs, 1)
})

test('velaros cli does not expose the product quality namespace', async () => {
  const { runVelarosCli } = await import(cliPath.href)

  const result = await runVelarosCli(['quality', 'select', '--suite', 'typecheck:node', '--json'])

  assert.equal(result.exitCode, 2)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.error.code, 'UNKNOWN_NAMESPACE')
})

test('velaros cli exposes agent as a formal namespace', async () => {
  const { runVelarosCli } = await import(cliPath.href)

  const result = await runVelarosCli(['agent', 'manifest', '--json'])

  assert.equal(result.exitCode, 0)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.cli.agent.manifest')
  assert.equal(parsed.result.namespace, 'agent')
  assert.deepEqual(parsed.result.commands, ['help', 'manifest', 'status'])
})

test('velaros terminal delegates to the independent Termel command', async () => {
  const { runVelarosCli } = await import(cliPath.href)
  const command = process.env.VELAROS_TERMEL_COMMAND
  process.env.VELAROS_TERMEL_COMMAND = process.execPath
  try {
    const result = await runVelarosCli(['terminal', '--version'], { cwd: process.cwd() })
    assert.equal(result.exitCode, 0)
    assert.equal(result.text, '')
  } finally {
    if (command === undefined) delete process.env.VELAROS_TERMEL_COMMAND
    else process.env.VELAROS_TERMEL_COMMAND = command
  }
})

test('velaros agent status reads task artifacts without a script bridge', async () => {
  const { runVelarosCli } = await import(cliPath.href)
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'velaros-agent-cli-'))
  const taskDir = join(workspaceRoot, '.velaros', 'agent-runs', 'tasks', 'task-1')
  const taskJsonPath = '.velaros/agent-runs/tasks/task-1/task.json'
  const ledger = {
    schemaVersion: 1,
    kind: 'velaros.devWorkbenchTaskRun',
    taskId: 'task-1',
    result: {
      status: 'passed',
    },
  }

  try {
    mkdirSync(taskDir, { recursive: true })
    writeFileSync(join(taskDir, 'task.json'), JSON.stringify(ledger), 'utf8')
    mkdirSync(join(workspaceRoot, '.velaros', 'agent-runs'), { recursive: true })
    writeFileSync(
      join(workspaceRoot, '.velaros', 'agent-runs', 'latest-task.json'),
      JSON.stringify({
        schemaVersion: 1,
        taskId: 'task-1',
        taskJsonPath,
      }),
      'utf8'
    )

    const result = await runVelarosCli([
      'agent',
      'status',
      '--workspace-root',
      workspaceRoot,
      '--full',
      '--json',
    ])

    assert.equal(result.exitCode, 0)
    const parsed = JSON.parse(result.text)
    assert.equal(parsed.kind, 'velaros.cli.agent.status')
    assert.equal(parsed.result.workspaceRoot, workspaceRoot)
    assert.equal(parsed.result.taskId, 'task-1')
    assert.equal(parsed.result.status, 'passed')
    assert.deepEqual(parsed.result.ledger, ledger)
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('velaros agent status refuses a task pointer that escapes through a symbolic link', async () => {
  const { runVelarosCli } = await import(cliPath.href)
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'velaros-agent-cli-escape-'))
  const outsideRoot = mkdtempSync(join(tmpdir(), 'velaros-agent-cli-outside-'))

  try {
    const runsDir = join(workspaceRoot, '.velaros', 'agent-runs')
    mkdirSync(runsDir, { recursive: true })
    writeFileSync(
      join(outsideRoot, 'credentials.json'),
      JSON.stringify({ taskId: 'stolen', apiKey: 'never-print-this-credential' }),
      'utf8'
    )
    // 工作区里的软链接指向工作区外：字面路径判定看不出来，读文件却会跟着链接走。
    symlinkSync(join(outsideRoot, 'credentials.json'), join(runsDir, 'link.json'))
    writeFileSync(
      join(runsDir, 'latest-task.json'),
      JSON.stringify({
        schemaVersion: 1,
        taskJsonPath: '.velaros/agent-runs/link.json',
      }),
      'utf8'
    )

    const result = await runVelarosCli([
      'agent',
      'status',
      '--workspace-root',
      workspaceRoot,
      '--full',
      '--json',
    ])

    assert.equal(result.exitCode, 2)
    assert.equal(JSON.parse(result.text).error.code, 'INVALID_TASK_POINTER')
    assert.doesNotMatch(result.text, /never-print-this-credential/)
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
    rmSync(outsideRoot, { recursive: true, force: true })
  }
})

test('velaros agent status accepts a task pointer under a directory named ..cache', async () => {
  const { runVelarosCli } = await import(cliPath.href)
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'velaros-agent-cli-dotdot-'))

  try {
    const runsDir = join(workspaceRoot, '.velaros', 'agent-runs')
    mkdirSync(join(workspaceRoot, '..cache'), { recursive: true })
    mkdirSync(runsDir, { recursive: true })
    writeFileSync(
      join(workspaceRoot, '..cache', 'task.json'),
      JSON.stringify({ taskId: 'task-cached', result: { status: 'passed' } }),
      'utf8'
    )
    writeFileSync(
      join(runsDir, 'latest-task.json'),
      JSON.stringify({ schemaVersion: 1, taskJsonPath: '..cache/task.json' }),
      'utf8'
    )

    const result = await runVelarosCli([
      'agent',
      'status',
      '--workspace-root',
      workspaceRoot,
      '--json',
    ])

    assert.equal(result.exitCode, 0)
    assert.equal(JSON.parse(result.text).result.taskId, 'task-cached')
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('velaros cli rejects removed agent commands and product namespaces', async () => {
  const { runVelarosCli } = await import(cliPath.href)

  const scriptBackedAgentResult = await runVelarosCli(['agent', 'schema', '--json'])
  const taskTemplateResult = await runVelarosCli(['quality', 'task-template', '--json'])

  assert.equal(scriptBackedAgentResult.exitCode, 2)
  assert.equal(taskTemplateResult.exitCode, 2)
  assert.equal(JSON.parse(scriptBackedAgentResult.text).error.code, 'UNKNOWN_COMMAND')
  assert.equal(JSON.parse(taskTemplateResult.text).error.code, 'UNKNOWN_NAMESPACE')
})

test('velaros cli returns stable unknown namespace errors', async () => {
  const { runVelarosCli } = await import(cliPath.href)

  const result = await runVelarosCli(['not-a-namespace', '--json'])

  assert.equal(result.exitCode, 2)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.cli.error')
  assert.equal(parsed.status, 'error')
  assert.equal(parsed.error.code, 'UNKNOWN_NAMESPACE')
})

test('velaros cli module import is side-effect-free', () => {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `import ${JSON.stringify(cliPath.href)}`],
    { encoding: 'utf8' }
  )

  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

test('published velaros bin target is executable through package metadata', () => {
  const manifest = JSON.parse(readFileSync(packageManifestPath, 'utf8'))
  assert.equal(manifest.bin?.velaros, './dist/bin.js')

  const declaredBinPath = fileURLToPath(new URL(manifest.bin.velaros, packageRoot))
  if (process.platform !== 'win32') {
    assert.notEqual(statSync(declaredBinPath).mode & 0o111, 0)
  }

  const result = process.platform === 'win32'
    ? spawnSync(process.execPath, [declaredBinPath, 'help'], { encoding: 'utf8' })
    : spawnSync(declaredBinPath, ['help'], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /VelarOS CLI/)
  assert.match(result.stdout, /agent \.\.\./)
  assert.match(result.stdout, /terminal \.\.\./)
  assert.doesNotMatch(result.stdout, /serve \.\.\./)
  assert.equal(result.stderr, '')
})
