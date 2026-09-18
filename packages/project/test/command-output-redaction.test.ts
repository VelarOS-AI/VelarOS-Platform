import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import { createSecretRedactionProvider } from '../src/index'

import { projectSpaceFixture } from './support/space'

/** 假密钥按段拼出来：仓库里不留完整的密钥形状，公开就绪扫描才不会把测试数据当成真泄漏。 */
const secret = ['sk', 'live', '0123456789abcdefghij'].join('-')

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-run-redaction-'))
  await writeFile(join(root, 'app.ts'), `const token = "${secret}"\n`)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 一个只读命令的项目空间：命令输出由 stdout/stderr 固定给出，内核按是否装脱敏后端建。 */
function spaceFor(redacted: boolean) {
  return projectSpaceFixture({
    root,
    providers: redacted ? { secretRedaction: createSecretRedactionProvider() } : {},
    runCommand: async (command) => ({ command, cwd: root, exitCode: 0, stdout: `${secret}\n`, stderr: `api_key=${secret}`, success: true }) as never,
  })
}

test('项目里跑命令的输出过项目的脱敏后端，命令行不再成为绕开读取治理的后门', async () => {
  const { call } = await spaceFor(true)
  const result = await call('shell', 'run', { command: 'cat app.ts' })
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe('[REDACTED]\n')
  expect(result.stderr).toContain('[REDACTED]')
  expect(result.stderr).not.toContain(secret)
})

test('宿主没有脱敏后端时输出原样返回', async () => {
  const { call } = await spaceFor(false)
  const result = await call('shell', 'run', { command: 'cat app.ts' })
  expect(result.stdout).toBe(`${secret}\n`)
})
