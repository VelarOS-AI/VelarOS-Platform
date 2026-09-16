import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import type { ProjectToolContext } from '../src/contract/requires'
import { createProjectKernel, createSecretRedactionProvider, projectTools } from '../src/index'

const tool = projectTools['project:run']!
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

/** 一个只读命令的工具上下文：命令输出由 stdout/stderr 固定给出，内核按是否装脱敏后端建。 */
async function contextFor(redacted: boolean): Promise<ProjectToolContext> {
  const kernel = await createProjectKernel({
    root,
    providers: redacted ? { secretRedaction: createSecretRedactionProvider() } : {},
  })
  return {
    abortSignal: new AbortController().signal,
    toolCallId: 'run-1',
    project: {
      getRootPath: () => root,
      kernel: async () => kernel,
      prepareMutation: async () => ({ approved: true, message: '已授权' }),
      queryCode: async () => ({}),
      runCommand: async (command: string) => ({ command, cwd: root, exitCode: 0, stdout: `${secret}\n`, stderr: `api_key=${secret}`, success: true }),
    },
    approval: { awaitConfirmationDecision: async () => ({ approved: true, message: null }) },
  } as unknown as ProjectToolContext
}

test('project:run 的输出过项目的脱敏后端，命令行不再成为绕开读取治理的后门', async () => {
  const result = await tool.execute(tool.schema.parse({ command: 'cat app.ts' }), await contextFor(true)) as { stdout: string; stderr: string; exitCode: number }
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe('[REDACTED]\n')
  expect(result.stderr).toContain('[REDACTED]')
  expect(result.stderr).not.toContain(secret)
})

test('宿主没有脱敏后端时输出原样返回', async () => {
  const result = await tool.execute(tool.schema.parse({ command: 'cat app.ts' }), await contextFor(false)) as { stdout: string }
  expect(result.stdout).toBe(`${secret}\n`)
})
