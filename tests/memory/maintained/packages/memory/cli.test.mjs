/**
 * @test-meta
 * title: 记忆包命令行
 * summary: 发布契约：构建后验证记忆包命令行与退出码。
 * area: packages
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const cliPath = new URL('../../../../packages/memory/dist/cli.js', import.meta.url)
const cliFilePath = fileURLToPath(cliPath)

test('memory cli lists tools', async () => {
  const { runMemoryCli } = await import(cliPath.href)

  const result = await runMemoryCli(['tools', 'list'])

  assert.equal(result.exitCode, 0)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.cli.memory.tools.list')
  assert.ok(parsed.result.tools.some((tool) => tool.name === 'search_memories'))
  assert.equal(parsed.result.tools.some((tool) => tool.name === 'get_user_profile'), false)
})

test('memory cli lists host availability so agents can avoid unavailable calls', async () => {
  const { runMemoryCli } = await import(cliPath.href)

  const result = await runMemoryCli(['tools', 'list'])

  assert.equal(result.exitCode, 0)
  const parsed = JSON.parse(result.text)
  const searchTool = parsed.result.tools.find((tool) => tool.name === 'search_memories')

  assert.equal(searchTool.availability.available, false)
  assert.equal(searchTool.availability.reason, 'host-runtime-required')
})

test('memory cli reports host capability requirements', async () => {
  const { runMemoryCli } = await import(cliPath.href)

  const result = await runMemoryCli(['tools', 'call', 'search_memories'])

  assert.equal(result.exitCode, 1)
  assert.equal(JSON.parse(result.text).error.code, 'HOST_CAPABILITY_REQUIRED')
})

test('memory cli reports save_memory host requirements without secondary stderr noise', () => {
  const result = spawnSync(
    process.execPath,
    [
      cliFilePath,
      'tools',
      'call',
      'save_memory',
      '--json',
      '--args-json',
      '{"kind":"session","title":"audit","content":"audit"}',
    ],
    { encoding: 'utf8' }
  )

  assert.equal(result.status, 1)
  assert.equal(JSON.parse(result.stderr).error.code, 'HOST_CAPABILITY_REQUIRED')
  assert.doesNotMatch(result.stderr, /system\.getOverview/)
  assert.doesNotMatch(result.stderr, /VelarosCliError:/)
})

test('memory cli returns stable unknown tool errors', async () => {
  const { runMemoryCli } = await import(cliPath.href)

  const result = await runMemoryCli(['tools', 'call', 'missing_tool'])

  assert.equal(result.exitCode, 2)
  assert.equal(JSON.parse(result.text).error.code, 'UNKNOWN_TOOL')
})

test('memory cli module import is side-effect-free', () => {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `import ${JSON.stringify(cliPath.href)}`],
    { encoding: 'utf8' }
  )

  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})
