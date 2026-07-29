/**
 * @test-meta
 * title: 浏览器工具包命令行
 * summary: 发布契约：构建后验证命令行入口、帮助输出与基础参数。
 * area: packages
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const cliPath = new URL('../dist/cli.js', import.meta.url)

test('browser tools cli lists tools', async () => {
  const { runBrowserToolsCli } = await import(cliPath.href)

  const result = await runBrowserToolsCli(['tools', 'list'])

  assert.equal(result.exitCode, 0)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.cli.browser.tools.list')
  assert.ok(parsed.result.tools.some((tool) => tool.name === 'browser_get_page_state'))
})

test('browser tools cli lists host availability so agents can avoid unavailable calls', async () => {
  const { runBrowserToolsCli } = await import(cliPath.href)

  const result = await runBrowserToolsCli(['tools', 'list'])

  assert.equal(result.exitCode, 0)
  const parsed = JSON.parse(result.text)
  const pageStateTool = parsed.result.tools.find((tool) => tool.name === 'browser_get_page_state')
  const contextTool = parsed.result.tools.find((tool) => tool.name === 'get_browser_site_context')

  assert.equal(pageStateTool.availability.available, false)
  assert.equal(pageStateTool.availability.reason, 'host-runtime-required')
  assert.equal(contextTool.availability.available, true)
})

test('browser tools cli reports host capability requirements', async () => {
  const { runBrowserToolsCli } = await import(cliPath.href)

  const result = await runBrowserToolsCli(['tools', 'call', 'browser_get_page_state'])

  assert.equal(result.exitCode, 1)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.error.code, 'HOST_CAPABILITY_REQUIRED')
})

test('browser tools cli returns stable unknown tool errors', async () => {
  const { runBrowserToolsCli } = await import(cliPath.href)

  const result = await runBrowserToolsCli(['tools', 'call', 'missing_tool'])

  assert.equal(result.exitCode, 2)
  assert.equal(JSON.parse(result.text).error.code, 'UNKNOWN_TOOL')
})

test('browser tools cli module import is side-effect-free', () => {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `import ${JSON.stringify(cliPath.href)}`],
    { encoding: 'utf8' }
  )

  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})
