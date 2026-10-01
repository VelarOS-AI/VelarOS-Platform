import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { FileLimits } from '../contract/constants'
import type { FileOperationContext, FileSpacePort } from '../contract/requires'
import { fileOperations } from '../impl/FileOperations'
import { createLocalFilePort } from '../impl/LocalFilePort'

let root: string
let port: FileSpacePort
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'files-foundation-'))
  port = createLocalFilePort({ resolvePath: (path) => path })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const context = (
  files: FileSpacePort,
  abortSignal = new AbortController().signal
): FileOperationContext => ({ files, abortSignal })

test.each([32, FileLimits.undoBytes + 32])(
  'commit detects external edits independent of undo retention (%s bytes)',
  async (length) => {
    const path = join(root, 'data.txt')
    await writeFile(path, 'a'.repeat(length))
    const raced: FileSpacePort = {
      locate: (p) => port.locate(p),
      commit: async (writes) => {
        await writeFile(path, 'external')
        return port.commit(writes)
      },
    }
    await expect(
      fileOperations.edit({ steps: [{ action: 'write', path, text: 'planned' }] }, context(raced))
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await readFile(path, 'utf8')).toBe('external')
  }
)

test('undo reauthorizes every path with a freshly constructed current port', async () => {
  const path = join(root, 'data.txt')
  await writeFile(path, 'before')
  const result = await fileOperations.edit(
    { steps: [{ action: 'write', path, text: 'after' }] },
    context(port)
  )
  let commits = 0
  const denied: FileSpacePort = {
    locate: async () => {
      throw new AppError('PERMISSION', 'scope changed')
    },
    commit: async () => {
      commits++
    },
  }
  await expect(
    fileOperations.undo({ changeId: result.changeId }, context(denied))
  ).rejects.toMatchObject({ code: 'PERMISSION' })
  expect(commits).toBe(0)
  expect(await readFile(path, 'utf8')).toBe('after')
  const rebuilt = createLocalFilePort({ resolvePath: (p) => p })
  await fileOperations.undo({ changeId: result.changeId }, context(rebuilt))
  expect(await readFile(path, 'utf8')).toBe('before')
})

test('undo refuses a path whose current resolved target changed', async () => {
  const a = join(root, 'a.txt')
  const b = join(root, 'b.txt')
  const link = join(root, 'link.txt')
  await writeFile(a, 'before')
  await writeFile(b, 'other')
  await symlink(a, link)
  const result = await fileOperations.edit(
    { steps: [{ action: 'write', path: link, text: 'after' }] },
    context(port)
  )
  await rm(link)
  await symlink(b, link)
  await expect(
    fileOperations.undo({ changeId: result.changeId }, context(port))
  ).rejects.toMatchObject({ code: 'PERMISSION' })
  expect(await readFile(a, 'utf8')).toBe('after')
  expect(await readFile(b, 'utf8')).toBe('other')
})

test('cancellation during planning prevents commit', async () => {
  const path = join(root, 'data.txt')
  await writeFile(path, 'before')
  const abort = new AbortController()
  let commits = 0
  const cancelled: FileSpacePort = {
    locate: async (p) => {
      const location = await port.locate(p)
      abort.abort()
      return location
    },
    commit: async (writes) => {
      commits++
      return port.commit(writes)
    },
  }
  await expect(
    fileOperations.edit(
      { steps: [{ action: 'write', path, text: 'after' }] },
      context(cancelled, abort.signal)
    )
  ).rejects.toBeDefined()
  expect(commits).toBe(0)
  expect(await readFile(path, 'utf8')).toBe('before')
})

test('late cancellation reports the completed first file and skips the next file', async () => {
  const a = join(root, 'a.txt')
  const b = join(root, 'b.txt')
  await writeFile(a, 'a')
  await writeFile(b, 'b')
  const abort = new AbortController()
  const writes = [
    {
      target: a,
      bytes: Buffer.from('first'),
      expected: { exists: true as const, bytes: Buffer.from('a') },
    },
    {
      target: b,
      get bytes() {
        abort.abort()
        return Buffer.from('second')
      },
      expected: { exists: true as const, bytes: Buffer.from('b') },
    },
  ]
  await expect(port.commit(writes, abort.signal)).rejects.toMatchObject({
    context: { applied: [a] },
  })
  expect(await readFile(a, 'utf8')).toBe('first')
  expect(await readFile(b, 'utf8')).toBe('b')
})
