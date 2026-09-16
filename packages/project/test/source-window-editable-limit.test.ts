import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import { InMemoryContextPayloadStore } from '@velaros-ai/agent'

import { ProjectPolicyDefaults } from '../src/contract/constants'
import type { ProjectToolContext } from '../src/contract/requires'
import { createProjectKernel } from '../src/exports/index'
import { readProjectSource } from '../src/utils/agent/project-files'
import { finalizeProjectModelResult } from '../src/utils/agent/source-window'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-editable-limit-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 一个只需要内核与载荷存储的工具上下文。 */
async function contextFor(): Promise<ProjectToolContext> {
  const kernel = await createProjectKernel({ root })
  return {
    sessionId: 'editable-limit', codingSession: {}, contextPayloadStore: new InMemoryContextPayloadStore(),
    abortSignal: new AbortController().signal,
    project: {
      getRootPath: () => root, kernel: async () => kernel,
      prepareMutation: async () => ({ approved: true, message: '已授权' }),
      queryCode: async () => ({}), runCommand: async () => ({}) as never,
    }, approval: {} as never,
  } as unknown as ProjectToolContext
}

/** 读一个文件并把回执定稿（fileRef 在这一步签发）。 */
async function readFinalized(context: ProjectToolContext, path: string): Promise<{ fileRef?: string; editable?: boolean; referenceUnavailable?: string }> {
  const raw = await readProjectSource({ files: [{ path, range: [1, 2] }] }, context)
  const finalized = await finalizeProjectModelResult(context, raw) as { files: Array<Record<string, unknown>> }
  return finalized.files[0] as never
}

test('超过可编辑上限的大文件只给只读窗口并说明，不再签发用起来必然失败的可编辑引用', async () => {
  const line = `${'a'.repeat(127)}\n`
  const lines = Math.ceil((ProjectPolicyDefaults.maxFileSizeToReadBytes + 1024 * 1024) / line.length)
  await writeFile(join(root, 'huge.txt'), line.repeat(lines))
  await writeFile(join(root, 'small.txt'), 'first\nsecond\nthird\n')
  const context = await contextFor()

  const huge = await readFinalized(context, 'huge.txt')
  expect(huge.fileRef).toBeUndefined()
  expect(huge.editable).toBe(false)
  expect(huge.referenceUnavailable).toContain('可编辑上限')

  // 同一条路上的普通文件照常签发可编辑引用。
  const small = await readFinalized(context, 'small.txt')
  expect(small.fileRef).toBeTruthy()
  expect(small.referenceUnavailable).toBeUndefined()
}, 120_000)
