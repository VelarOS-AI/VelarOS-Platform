import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { FileStore } from '../impl/files/FileStore'
import { createProjectKernel } from '../index'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-atomic-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// 编码与原子写入本身的用例在 @velaros-ai/core/text-files；这里只测项目怎么用它：事务的整批语义，以及公共件的失败在文件网关上翻成 ProjectError。
describe('lossless text and atomic replacement', () => {
  test('rejects a malformed late operation before an earlier valid edit is applied', async () => {
    await writeFile(join(root, 'source.txt'), 'original')
    const project = await createProjectKernel({ root })
    await expect(
      project.prepareEdit({
        operations: [
          {
            operation: {
              type: 'replace_text',
              path: 'source.txt',
              oldText: 'original',
              newText: 'changed',
            },
          },
          { operation: { type: 'create_file', path: 'broken.txt', content: '\uD800' } },
        ],
      })
    ).rejects.toMatchObject({
      reason: 'INVALID_INPUT',
      details: { operationIndex: 1, written: false },
    })
    expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('original')
    expect(await Bun.file(join(root, 'broken.txt')).exists()).toBe(false)
  })

  test('text-files failures reach the file gateway as ProjectError reasons, and the disk stays untouched', async () => {
    const store = new FileStore(
      root,
      ((await createProjectKernel({ root })) as any).policy,
      undefined,
      undefined as never
    )
    await writeFile(join(root, 'source.txt'), 'original')
    await link(join(root, 'source.txt'), join(root, 'alias.txt'))
    await expect(store.write('alias.txt', 'changed')).rejects.toMatchObject({
      name: 'ProjectError',
      reason: 'NOT_SUPPORTED',
    })
    expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('original')
    await expect(store.write('broken.txt', 'valid🙂then\uD800bad')).rejects.toMatchObject({
      name: 'ProjectError',
      reason: 'INVALID_INPUT',
      details: { offset: 11 },
    })
    await expect(store.write('mode.txt', 'x', { mode: 0o4755 })).rejects.toMatchObject({
      name: 'ProjectError',
      reason: 'INVALID_INPUT',
    })
    await expect(
      store.write('late.txt', 'late', {
        transactionBytes: Buffer.from('late'),
        expectedBytes: { exists: true, bytes: Buffer.from('early') },
      })
    ).rejects.toMatchObject({ name: 'ProjectError', reason: 'CONFLICT_WITH_EXTERNAL_EDIT' })
    await writeFile(join(root, 'removed.txt'), 'changed outside')
    await expect(
      store.remove('removed.txt', {
        expectedBytes: { exists: true, bytes: Buffer.from('original') },
      })
    ).rejects.toMatchObject({ name: 'ProjectError', reason: 'CONFLICT_WITH_EXTERNAL_EDIT' })
    expect(await readFile(join(root, 'removed.txt'), 'utf8')).toBe('changed outside')
    for (const path of ['broken.txt', 'mode.txt', 'late.txt'])
      expect(await Bun.file(join(root, path)).exists()).toBe(false)
  })
})
