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
    'serve',
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

test('velaros cli exposes serve through the Host-owned namespace runner', async () => {
  const { runVelarosCli } = await import(cliPath.href)

  const help = await runVelarosCli(['serve', '--help', '--json'])
  assert.equal(help.exitCode, 0)
  const parsed = JSON.parse(help.text)
  assert.equal(parsed.kind, 'velaros.cli.serve.help')
  assert.deepEqual(parsed.result.commands, [
    'start',
    'status',
    'config show',
    'config apply',
    'computer probe',
    'computer install',
    'extension pair',
    'extension disconnect',
    'remote pair',
    'remote revoke',
  ])

  const invalid = await runVelarosCli(['serve', 'status', '--not-a-real-option', '--json'])
  assert.equal(invalid.exitCode, 2)
  assert.equal(JSON.parse(invalid.text).error.code, 'ARGUMENT_ERROR')
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
  assert.notEqual(statSync(declaredBinPath).mode & 0o111, 0)

  const result = spawnSync(declaredBinPath, ['help'], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /VelarOS CLI/)
  assert.match(result.stdout, /agent \.\.\./)
  assert.match(result.stdout, /serve \.\.\./)
  assert.equal(result.stderr, '')
})
