import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import {
  createProjectKernel,
  projectFileOperations as project,
  type ProjectOperationContext,
} from '../index'

let root: string
let dir: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'commit-files-'))
  dir = await mkdtemp(join(tmpdir(), 'commit-state-'))
})
afterEach(async () => {
  await Promise.all([root, dir].map((path) => rm(path, { recursive: true, force: true })))
})
async function reopen(sessionId = 'owner'): Promise<ProjectOperationContext> {
  const kernel = await createProjectKernel({ root, transactionStatePath: join(dir, 'state.json') })
  return {
    sessionId,
    project: { getRootPath: () => root, kernel: async () => kernel, queryCode: async () => ({}) },
    abortSignal: new AbortController().signal,
  }
}
test('two files, concurrent retry, lost reply, restart and guarded undo', async () => {
  const ctx = await reopen()
  const input = {
    requestId: 'write-1',
    changes: [
      { path: 'a.txt', before: null, after: 'alpha' },
      { path: 'b.txt', before: null, after: 'bravo' },
    ],
  }
  const [a, b] = await Promise.all([project.commit(input, ctx), project.commit(input, ctx)])
  expect(b).toEqual(a)
  const latest = await reopen()
  expect((await project.inspect({}, latest)).changeRef).toBe(a.changeRef)
  expect(
    (await project.inspect({ requestId: 'write-1', path: 'a.txt' }, latest)).diff
  ).not.toContain('b.txt')
  expect(await project.commit(input, latest)).toEqual(a)
  await expect(
    project.commit({ ...input, changes: [{ path: 'c.txt', before: null, after: 'x' }] }, latest)
  ).rejects.toThrow()
  await expect(project.inspect({ changeRef: a.changeRef }, await reopen('other'))).rejects.toThrow()
  await writeFile(join(root, 'b.txt'), 'user')
  await expect(project.undo({ changeRef: a.changeRef }, latest)).rejects.toThrow('b.txt')
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('alpha')
  expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('user')
})

test('successful commit keeps its receipt and effect when the applied transaction leaves history', async () => {
  const ctx = await reopen()
  const kernel = await ctx.project.kernel()
  const apply = kernel.applyEdit.bind(kernel)
  const get = kernel.getTransaction.bind(kernel)
  let evicted = false
  kernel.getTransaction = (id) => (evicted ? undefined : get(id))
  kernel.applyEdit = async (input, signal) => {
    const result = await apply(input, signal)
    evicted = true
    return result
  }
  const commits: Array<Parameters<NonNullable<ProjectOperationContext['recordProjectCommit']>>[0]> =
    []
  const outcomes: string[] = []
  ctx.recordProjectCommit = (commit) => commits.push(commit)
  ctx.recordWriteOutcome = (outcome) => outcomes.push(outcome)
  const result = await project.commit(
    { requestId: 'evicted', changes: [{ path: 'receipt.txt', before: null, after: 'saved' }] },
    ctx
  )
  expect(result.status).toBe('applied')
  expect(result.changedFiles).toEqual(['receipt.txt'])
  expect(result.changed).toBe(true)
  expect(result.diff).toContain('+saved')
  expect(result.newRevisions?.['receipt.txt']).toBeDefined()
  expect(result.oldRevisions?.['receipt.txt']).toBeUndefined()
  expect(commits).toHaveLength(1)
  expect(commits[0].transactionId).toBe(result.changeRef)
  expect(commits[0].changedFiles).toEqual(['receipt.txt'])
  expect(outcomes).toEqual(['applied'])
  expect(await readFile(join(root, 'receipt.txt'), 'utf8')).toBe('saved')
})
test('exact bytes distinguish BOM and empty from absent; conflict writes nothing', async () => {
  const ctx = await reopen()
  await writeFile(join(root, 'original.txt'), '\ufeffold\r\n')
  const changes = [
    { path: 'new.txt', before: null, after: 'new' },
    { path: 'original.txt', before: 'old\r\n', after: 'after' },
  ]
  await expect(project.commit({ changes }, ctx)).rejects.toThrow('original.txt')
  await expect(stat(join(root, 'new.txt'))).rejects.toThrow()
  const before = await readFile(join(root, 'original.txt'))
  const exact = Buffer.from('\ufeffone\r\ntwo\n', 'utf16le')
  const saved = await project.commit(
    {
      changes: [
        {
          path: 'original.txt',
          before: { sha256: createHash('sha256').update(before).digest('hex') },
          after: { base64: exact.toString('base64') },
        },
      ],
    },
    ctx
  )
  expect(await readFile(join(root, 'original.txt'))).toEqual(exact)
  await project.undo({ changeRef: saved.changeRef }, await reopen())
  expect(await readFile(join(root, 'original.txt'))).toEqual(before)
  await writeFile(join(root, 'empty.txt'), '')
  await expect(
    project.commit({ changes: [{ path: 'empty.txt', before: null, after: 'x' }] }, ctx)
  ).rejects.toThrow()
})
test('large diff pages and history stay tied to committed bytes', async () => {
  const ctx = await reopen()
  const before = await project.commit(
    { changes: [{ path: 'first', before: null, after: 'a' }] },
    ctx
  )
  const content = 'long line '.repeat(1800)
  const changed = await project.commit(
    { changes: [{ path: 'large.txt', before: null, after: Buffer.from(content) }] },
    ctx
  )
  expect(changed.diffTruncated).toBe(true)
  await writeFile(join(root, 'large.txt'), 'external')
  const page = await project.inspect({ path: 'large.txt', changeRef: changed.changeRef }, ctx)
  expect(page.previousChangeRef).toBe(before.changeRef)
  expect(page.diff).toBe(changed.diff)
  expect(page.nextOffset).toBeGreaterThan(0)
  const chunks = [page.diff]
  let offset = page.nextOffset
  while (offset !== undefined) {
    const next = await project.inspect(
      { changeRef: changed.changeRef, path: 'large.txt', offset },
      ctx
    )
    chunks.push(next.diff)
    offset = next.nextOffset
  }
  expect(chunks.join('')).toContain(`+${content}`)
})

test('text transformations preserve untouched mixed line endings and utf8 BOM', async () => {
  const ctx = await reopen()
  const source = Buffer.from('\ufeffone\r\ntwo\nthree\r\n')
  await mkdir(join(root, 'src'))
  const path = 'src/mixed.txt'
  await writeFile(join(root, path), source)
  const after = source.toString('utf8').replace('two', 'TWO')
  const tx = await project.commit({ changes: [{ path, before: source, after }] }, ctx)
  expect(tx.changedFiles).toEqual([path])
  expect(await readFile(join(root, path))).toEqual(Buffer.from(after))
  await project.undo({ changeRef: tx.changeRef }, ctx)
  expect(await readFile(join(root, path))).toEqual(source)
})

test('unique fragment, no-op, and guarded move/delete', async () => {
  const ctx = await reopen()
  await writeFile(join(root, 'x.txt'), 'user\nold\nold\n')
  await expect(
    project.commit({ changes: [{ path: 'x.txt', oldText: 'old', newText: 'new' }] }, ctx)
  ).rejects.toThrow()
  const patch = await project.commit(
    { changes: [{ path: 'x.txt', oldText: 'user\nold', newText: 'user\nnew' }] },
    ctx
  )
  expect(patch.diff).toContain('+new')
  const content = await readFile(join(root, 'x.txt'), 'utf8')
  const mtime = (await stat(join(root, 'x.txt'))).mtimeMs
  const same = await project.commit(
    { requestId: 'same', changes: [{ path: 'x.txt', before: content, after: content }] },
    ctx
  )
  expect(same.changedFiles).toEqual([])
  expect(same.changed).toBe(false)
  expect((await stat(join(root, 'x.txt'))).mtimeMs).toBe(mtime)
  const reopened = await reopen()
  expect((await project.inspect({ requestId: 'same' }, reopened)).changeRef).toBe(same.changeRef)
  await project.commit({ changes: [{ from: 'x.txt', to: 'y.txt', before: content }] }, reopened)
  const deleted = await project.commit(
    { changes: [{ path: 'y.txt', before: content, after: null }] },
    reopened
  )
  await project.undo({ changeRef: deleted.changeRef }, reopened)
  expect(await readFile(join(root, 'y.txt'), 'utf8')).toBe(content)
})

test('undo receipts describe restored, created and deleted files and repeated undo writes nothing', async () => {
  const ctx = await reopen()
  await writeFile(join(root, 'old.txt'), 'original\n')
  await writeFile(join(root, 'removed.txt'), 'restore me\n')
  const tx = await project.commit(
    {
      changes: [
        { path: 'old.txt', before: 'original\n', after: 'replacement\n' },
        { path: 'created.txt', before: null, after: 'new file\n' },
        { path: 'removed.txt', before: 'restore me\n', after: null },
      ],
    },
    ctx
  )
  const result = await project.undo({ changeRef: tx.changeRef }, ctx)
  expect(result.status).toBe('rolled_back')
  expect(result.changed).toBe(true)
  expect(result.changedFiles).toEqual(tx.changedFiles)
  expect(result.diffTruncated).toBe(false)
  expect(result.diff).toContain('-replacement\n+original')
  expect(result.diff).toContain('-new file')
  expect(result.diff).toContain('+restore me')
  for (const path of ['old.txt', 'created.txt', 'removed.txt']) {
    expect(result.diff).toContain(`--- a/${path}`)
    expect(result.diff).toContain(`+++ b/${path}`)
  }
  expect(await readFile(join(root, 'old.txt'), 'utf8')).toBe('original\n')
  expect(await readFile(join(root, 'removed.txt'), 'utf8')).toBe('restore me\n')
  await expect(stat(join(root, 'created.txt'))).rejects.toThrow()
  await writeFile(join(root, 'old.txt'), 'later user change\n')
  expect(await project.undo({ changeRef: tx.changeRef }, ctx)).toMatchObject({
    status: 'rolled_back',
    changed: false,
    alreadyUndone: true,
    diff: '',
    diffTruncated: false,
  })
  expect(await readFile(join(root, 'old.txt'), 'utf8')).toBe('later user change\n')
})

test('undo diff is bounded while the complete original bytes are restored', async () => {
  const ctx = await reopen()
  const original = 'original '.repeat(1500)
  await writeFile(join(root, 'large.txt'), original)
  const tx = await project.commit(
    { changes: [{ path: 'large.txt', before: original, after: 'small' }] },
    ctx
  )
  const result = await project.undo({ changeRef: tx.changeRef }, ctx)
  expect(result.changed).toBe(true)
  expect(result.diffTruncated).toBe(true)
  expect(result.diff.length).toBeLessThanOrEqual(8192)
  expect(await readFile(join(root, 'large.txt'), 'utf8')).toBe(original)
})
