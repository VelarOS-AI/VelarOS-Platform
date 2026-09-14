import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { legacyProjectTools as projectTools } from '../src/compatibility/agent-tools'
import { ProjectEditOperationSchema } from '../src/edits/schema'
import { createProjectKernel } from '../src/index'
import type { ReplaceLinesOperation } from '../src/types/edit'

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'project-line-edit-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function fixture(content: string, path = 'sample.txt', requireBaseRevision = true) {
  await writeFile(join(root, path), content)
  const project = await createProjectKernel({ root, corePolicy: { requireBaseRevision } })
  const read = await project.read({ path })
  const operation: ReplaceLinesOperation = {
    type: 'replace_lines', path, baseRevision: read.snapshot.revision,
    startLine: 2, endLine: 2, newLines: ['changed'],
  }
  return { project, operation }
}

describe('revision-bound line edits', () => {
  test('edits the selected duplicate without replaying escaped old source, composes and rolls back', async () => {
    const original = 'const path = "\\\\"\nconst path = "\\\\"\n尾部🙂\n'
    const { project, operation } = await fixture(original)
    operation.newLines = ['中文🙂', 'next']
    expect(projectTools['project:edit'].schema.safeParse({ edits: [operation] }).success).toBe(true)
    const tx = await project.prepareEdit({ operations: [
      { operation },
      { operation: { type: 'replace_text', path: operation.path, oldText: 'next', newText: 'done' } },
    ] })
    await project.applyEdit({ transactionId: tx.transactionId })
    const actual = await readFile(join(root, operation.path), 'utf8')
    expect(actual).toBe('const path = "\\\\"\n中文🙂\ndone\n尾部🙂\n')
    expect(tx.diff).toContain('+done')
    await project.rollback({ transactionId: tx.transactionId })
    expect(await readFile(join(root, operation.path), 'utf8')).toBe(original)
  })

  test.each([
    ['a\r\nb\r\nc\r\n', ['x', 'y'], 'a\r\nx\r\ny\r\nc\r\n'],
    ['a\nb\nc', [], 'a\nc'],
    ['a\nb', ['x', 'y'], 'a\nx\ny'],
    ['a\r\nb', ['x', 'y'], 'a\r\nx\r\ny'],
    ['a\r\nb\nc\r\n', ['x', 'y'], 'a\r\nx\ny\nc\r\n'],
    ['a\nb\n', [''], 'a\n\n'],
  ])('preserves regional line endings and file boundaries: %j', async (original, newLines, expected) => {
    const { project, operation } = await fixture(original)
    operation.newLines = newLines
    const tx = await project.prepareEdit({ operations: [{ operation }] })
    await project.applyEdit({ transactionId: tx.transactionId })
    expect(await readFile(join(root, operation.path), 'utf8')).toBe(expected)
  })

  test('supports empty files', async () => {
    const { project, operation } = await fixture('')
    operation.startLine = operation.endLine = 1
    const tx = await project.prepareEdit({ operations: [{ operation }] })
    await project.applyEdit({ transactionId: tx.transactionId })
    expect(await readFile(join(root, operation.path), 'utf8')).toBe('changed')
  })

  test('supports the final empty line returned by read', async () => {
    const { project, operation } = await fixture('a\n')
    const tx = await project.prepareEdit({ operations: [{ operation }] })
    await project.applyEdit({ transactionId: tx.transactionId })
    expect(await readFile(join(root, operation.path), 'utf8')).toBe('a\nchanged')
  })

  test('preserves UTF-16 bytes through apply and rollback', async () => {
    const path = 'utf16.txt'
    const original = Buffer.from('\uFEFF标题🙂\r\n原文\r\n', 'utf16le')
    await writeFile(join(root, path), original)
    const project = await createProjectKernel({ root })
    const read = await project.read({ path })
    const tx = await project.prepareEdit({ operations: [{ operation: {
      type: 'replace_lines', path, baseRevision: read.snapshot.revision,
      startLine: 2, endLine: 2, newLines: ['新文🙂'],
    } }] })
    await project.applyEdit({ transactionId: tx.transactionId })
    expect(await readFile(join(root, path))).toEqual(Buffer.from('\uFEFF标题🙂\r\n新文🙂\r\n', 'utf16le'))
    await project.rollback({ transactionId: tx.transactionId })
    expect(await readFile(join(root, path))).toEqual(original)
  })

  test('rejects stale revisions even when optional revision policy is disabled', async () => {
    const { project, operation } = await fixture('a\nb\n', 'sample.txt', false)
    await writeFile(join(root, operation.path), 'external\na\nb\n')
    await expect(project.prepareEdit({ operations: [{ operation }] })).rejects.toMatchObject({ reason: 'BASE_REVISION_MISMATCH' })
    expect(await readFile(join(root, operation.path), 'utf8')).toBe('external\na\nb\n')
  })

  test('rejects line numbers invalidated by earlier operations atomically', async () => {
    const original = 'a\nb\n'
    const { project, operation } = await fixture(original)
    await expect(project.prepareEdit({ operations: [
      { operation: { type: 'prepend_text', path: operation.path, text: 'new\n' } },
      { operation },
    ] })).rejects.toMatchObject({ reason: 'BASE_REVISION_MISMATCH' })
    expect(await readFile(join(root, operation.path), 'utf8')).toBe(original)
  })

  test('keeps external edits made between prepare and apply', async () => {
    const { project, operation } = await fixture('a\nb\n')
    const tx = await project.prepareEdit({ operations: [{ operation }] })
    const external = 'external\na\nb\n'
    await writeFile(join(root, operation.path), external)
    await expect(project.applyEdit({ transactionId: tx.transactionId })).rejects.toBeDefined()
    expect(await readFile(join(root, operation.path), 'utf8')).toBe(external)
  })

  test('validates generated source before writing', async () => {
    const original = 'const first = 1\nconst second = 2\n'
    const { project, operation } = await fixture(original, 'sample.mjs')
    operation.newLines = ['const second = ;']
    const tx = await project.prepareEdit({ operations: [{ operation }] })
    await expect(project.applyEdit({ transactionId: tx.transactionId })).rejects.toMatchObject({ reason: 'VALIDATION_FAILED' })
    expect(await readFile(join(root, operation.path), 'utf8')).toBe(original)
  })

  test('checks ranges and line payloads through schema and direct kernel calls', async () => {
    const { project, operation } = await fixture('a\nb')
    for (const overrides of [
      { startLine: 0 }, { endLine: 1 }, { startLine: 1.5 },
      { newLines: ['x\ny'] }, { newLines: ['x\ry'] },
      { newLines: ['x\n'] }, { newLines: ['x\r\n'] }, { baseRevision: '' },
    ]) {
      const invalid = { ...operation, ...overrides }
      expect(ProjectEditOperationSchema.safeParse(invalid).success).toBe(false)
      await expect(project.prepareEdit({ operations: [{ operation: invalid }] })).rejects.toBeDefined()
    }
    await expect(project.prepareEdit({ operations: [{ operation: { ...operation, endLine: 3 } }] }))
      .rejects.toMatchObject({ reason: 'INVALID_INPUT', details: { totalLines: 2 } })
    expect(await readFile(join(root, operation.path), 'utf8')).toBe('a\nb')
  })
})

describe('batched edits against one read revision', () => {
  test.each([false, true])('keeps original line numbers when earlier ranges expand (reverse=%s)', async (reverse) => {
    const original = 'first\nsecond\nthird\nfourth\nfifth\n'
    const { project, operation } = await fixture(original)
    const edits: ReplaceLinesOperation[] = [
      { ...operation, startLine: 2, endLine: 2, newLines: ['two', 'extra', 'more'] },
      { ...operation, startLine: 4, endLine: 5, newLines: ['four-five'] },
    ]
    if (reverse) edits.reverse()
    const tx = await project.prepareEdit({ operations: edits.map((operation) => ({ operation })) })
    expect(tx.patches).toHaveLength(1)
    await project.applyEdit({ transactionId: tx.transactionId })
    expect(await readFile(join(root, operation.path), 'utf8')).toBe('first\ntwo\nextra\nmore\nthird\nfour-five\n')
    await project.rollback({ transactionId: tx.transactionId })
    expect(await readFile(join(root, operation.path), 'utf8')).toBe(original)
  })

  test('identifies the failing range and rejects the entire multi-file prepare', async () => {
    const { project, operation } = await fixture('first\nsecond\nthird\n')
    await expect(project.prepareEdit({ operations: [
      { operation: { type: 'create_file', path: 'new.txt', content: 'must not appear' } },
      { operation },
      { operation: { ...operation, startLine: 3, endLine: 99 } },
    ] })).rejects.toMatchObject({ reason: 'INVALID_INPUT', details: { operationIndex: 2, stage: 'prepare', written: false } })
    expect(await readFile(join(root, operation.path), 'utf8')).toBe('first\nsecond\nthird\n')
    expect(await Bun.file(join(root, 'new.txt')).exists()).toBe(false)
  })

  test('rejects overlapping ranges before writing', async () => {
    const { project, operation } = await fixture('first\nsecond\nthird\n')
    await expect(project.prepareEdit({ operations: [
      { operation: { ...operation, startLine: 1, endLine: 2 } },
      { operation: { ...operation, startLine: 2, endLine: 3 } },
    ] })).rejects.toMatchObject({ reason: 'INVALID_INPUT', details: { written: false } })
    expect(await readFile(join(root, operation.path), 'utf8')).toBe('first\nsecond\nthird\n')
  })
})


test('detects same-size external edits with a preserved mtime before a line edit', async () => {
  const path = 'preserved-time.txt'
  await writeFile(join(root, path), 'first\nold\n')
  await utimes(join(root, path), 1700000000, 1700000000)
  const project = await createProjectKernel({ root })
  const read = await project.read({ path })
  await writeFile(join(root, path), 'first\nnew\n')
  await utimes(join(root, path), 1700000000, 1700000000)
  await expect(project.prepareEdit({ operations: [{ operation: {
    type: 'replace_lines', path, baseRevision: read.snapshot.revision,
    startLine: 2, endLine: 2, newLines: ['agent'],
  } }] })).rejects.toMatchObject({ reason: 'BASE_REVISION_MISMATCH' })
  expect(await readFile(join(root, path), 'utf8')).toBe('first\nnew\n')
})
