/**
 * @test-meta
 * title: 办公工具包命令行
 * summary: 发布契约：构建后验证办公工具包命令行与退出码。
 * area: packages
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

import { test } from 'bun:test'

const cliPath = new URL('../dist/cli.js', import.meta.url)

test('office tools cli lists tools', async () => {
  const { runOfficeToolsCli } = await import(cliPath.href)

  const result = await runOfficeToolsCli(['tools', 'list'])

  assert.equal(result.exitCode, 0)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.cli.office.tools.list')
  assert.ok(parsed.result.tools.some((tool) => tool.name === 'create_word_document'))
  assert.ok(parsed.result.tools.some((tool) => tool.name === 'convert_document_to_markdown'))
})

test('office tools cli lists host availability so agents can avoid unavailable calls', async () => {
  const { runOfficeToolsCli } = await import(cliPath.href)

  const result = await runOfficeToolsCli(['tools', 'list'])

  assert.equal(result.exitCode, 0)
  const parsed = JSON.parse(result.text)
  const createTool = parsed.result.tools.find((tool) => tool.name === 'create_word_document')

  assert.equal(createTool.availability.available, false)
  assert.equal(createTool.availability.reason, 'host-runtime-required')
})

test('office tools cli reports host capability requirements', async () => {
  const { runOfficeToolsCli } = await import(cliPath.href)

  const result = await runOfficeToolsCli([
    'tools',
    'call',
    'preview_office_document',
    '--args-json',
    '{"inputPath":"missing.docx"}',
  ])

  assert.equal(result.exitCode, 1)
  assert.equal(JSON.parse(result.text).error.code, 'HOST_CAPABILITY_REQUIRED')
})

test('office tools cli returns stable unknown tool errors', async () => {
  const { runOfficeToolsCli } = await import(cliPath.href)

  const result = await runOfficeToolsCli(['tools', 'call', 'missing_tool'])

  assert.equal(result.exitCode, 2)
  assert.equal(JSON.parse(result.text).error.code, 'UNKNOWN_TOOL')
})

test('office tools cli module import is side-effect-free', () => {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `import ${JSON.stringify(cliPath.href)}`],
    { encoding: 'utf8' }
  )

  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})
