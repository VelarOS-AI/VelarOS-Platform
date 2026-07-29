/**
 * @test-meta
 * title: 知识包命令行
 * summary: 发布契约：构建后验证知识包命令行与退出码。
 * area: packages
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const cliPath = new URL('../../../../../../packages/memory/dist/knowledge/cli.js', import.meta.url)

test('knowledge cli lists only knowledge tools', async () => {
  const { runKnowledgeCli } = await import(cliPath.href)

  const result = await runKnowledgeCli(['tools', 'list'])

  assert.equal(result.exitCode, 0)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.kind, 'velaros.cli.knowledge.tools.list')
  assert.ok(parsed.result.tools.some((tool) => tool.name === 'search_knowledge'))
  assert.equal(parsed.result.tools.some((tool) => tool.name === 'search_memories'), false)
})

test('knowledge cli publishes host availability', async () => {
  const { runKnowledgeCli } = await import(cliPath.href)

  const result = await runKnowledgeCli(['tools', 'list'])

  assert.equal(result.exitCode, 0)
  const parsed = JSON.parse(result.text)
  const searchTool = parsed.result.tools.find((tool) => tool.name === 'search_knowledge')

  assert.equal(searchTool.availability.available, false)
  assert.equal(searchTool.availability.reason, 'host-runtime-required')
})

test('knowledge cli reports host capability requirements', async () => {
  const { runKnowledgeCli } = await import(cliPath.href)

  const result = await runKnowledgeCli(['tools', 'call', 'search_knowledge'])

  assert.equal(result.exitCode, 1)
  assert.equal(JSON.parse(result.text).error.code, 'HOST_CAPABILITY_REQUIRED')
})

test('knowledge cli module import is side-effect-free', () => {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `import ${JSON.stringify(cliPath.href)}`],
    { encoding: 'utf8' }
  )

  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})
