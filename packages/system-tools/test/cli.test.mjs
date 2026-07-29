/**
 * @test-meta
 * title: 系统工具包命令行
 * summary: 发布契约：构建后验证系统工具包命令行与退出码。
 * area: packages
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

import { test } from 'bun:test'

const cliPath = new URL('../dist/cli.js', import.meta.url)

test('system tools cli lists tools with a stable envelope', async () => {
  const { runSystemToolsCli } = await import(cliPath.href)

  const result = await runSystemToolsCli(['tools', 'list'])

  assert.equal(result.exitCode, 0)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.schemaVersion, 1)
  assert.equal(parsed.kind, 'velaros.cli.system.tools.list')
  assert.equal(parsed.status, 'ok')
  assert.ok(parsed.result.tools.some((tool) => tool.name === 'get_system_overview'))
  assert.ok(parsed.result.tools.some((tool) => tool.name === 'bash'))
  assert.ok(parsed.result.tools.some((tool) => tool.name === 'ps'))
  assert.ok(parsed.result.tools.some((tool) => tool.name === 'open'))
  assert.equal(parsed.result.tools.some((tool) => tool.name === 'run_command'), false)
  assert.equal(parsed.result.tools.some((tool) => tool.name === 'diagnose_dev_runtime'), false)
})

test('system tools cli lists model-facing schemas without default-required conflicts or duplicated description prefixes', async () => {
  const { runSystemToolsCli } = await import(cliPath.href)

  const result = await runSystemToolsCli(['tools', 'list'])

  assert.equal(result.exitCode, 0)
  const parsed = JSON.parse(result.text)
  const writeTool = parsed.result.tools.find((tool) => tool.name === 'write')
  const editTool = parsed.result.tools.find((tool) => tool.name === 'edit')
  const serializedTools = JSON.stringify(parsed.result.tools)

  assert.ok(writeTool)
  assert.ok(editTool)
  assert.deepEqual(writeTool.inputSchema.required, ['path', 'content'])
  assert.deepEqual(editTool.inputSchema.required, ['path', 'oldText', 'newText'])
  assert.doesNotMatch(serializedTools, /描述：描述：/)
})

test('system tools cli calls a local-safe tool', async () => {
  const { runSystemToolsCli } = await import(cliPath.href)

  const result = await runSystemToolsCli([
    'tools',
    'call',
    'get_system_overview',
    '--args-json',
    '{"compact":true}',
  ])

  assert.equal(result.exitCode, 0)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.cli.system.tools.call')
  assert.equal(parsed.result.compact, true)
  assert.equal(typeof parsed.result.capabilities.canRunCommands, 'boolean')
})

test('system tools cli runs local bash commands without an Electron host', async () => {
  const { runSystemToolsCli } = await import(cliPath.href)

  const result = await runSystemToolsCli([
    'tools',
    'call',
    'bash',
    '--args-json',
    '{"command":"printf velaros-kernel","maxOutputChars":2000}',
  ])

  assert.equal(result.exitCode, 0)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.cli.system.tools.call')
  assert.equal(parsed.result.success, true)
  assert.equal(parsed.result.stdout, 'velaros-kernel')
})

test('system tools cli can sample process state through the local kernel', async () => {
  const { runSystemToolsCli } = await import(cliPath.href)

  const result = await runSystemToolsCli([
    'tools',
    'call',
    'ps',
    '--args-json',
    '{"include":["processes"],"limit":5}',
  ])

  assert.equal(result.exitCode, 0)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.cli.system.tools.call')
  assert.equal(typeof parsed.result.processes.count, 'number')
  assert.ok(Array.isArray(parsed.result.processes.items))
}, 15_000)

test('system tools cli returns stable unknown tool errors', async () => {
  const { runSystemToolsCli } = await import(cliPath.href)

  const result = await runSystemToolsCli(['tools', 'call', 'missing_tool'])

  assert.equal(result.exitCode, 2)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.cli.error')
  assert.equal(parsed.status, 'error')
  assert.equal(parsed.error.code, 'UNKNOWN_TOOL')
})

test('system tools cli module import is side-effect-free', () => {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `import ${JSON.stringify(cliPath.href)}`],
    { encoding: 'utf8' }
  )

  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})
