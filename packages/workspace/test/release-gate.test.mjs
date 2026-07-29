/**
 * @test-meta
 * title: 工作区发布门禁
 * summary: 发布契约：验证工作区包发布门禁与构建产物约束。
 * area: packages
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { test } from 'bun:test'

async function readPackageJson() {
  return JSON.parse(
    await fs.readFile(path.resolve(import.meta.dirname, '../package.json'), 'utf8')
  )
}

test('workspace package exposes the current release preflight gate', async () => {
  const pkg = await readPackageJson()

  assert.equal(pkg.scripts.preflight, 'bun run check && bun run test:eval')
  assert.match(pkg.version, /^1\.\d+\.\d+(?:-.+)?$/)
})

test('workspace test gates are package-owned', async () => {
  const pkg = await readPackageJson()
  const testScripts = [pkg.scripts.test, pkg.scripts['test:eval']]

  assert.equal(pkg.scripts.test, 'bun run build && bun run test:run')
  assert.equal(pkg.scripts['test:eval'], 'bun run build && bun test test/eval.test.mjs')
  assert.equal(testScripts.some((script) => script.includes('../')), false)
})
