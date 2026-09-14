import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { InMemoryContextPayloadStore } from '@velaros-ai/agent'

import { finalizeProjectModelResult } from '../src/agent/presentation/source-window'
import { projectTools } from '../src/agent/Project.tool'
import { registerProjectFileContext } from '../src/agent/ProjectFileContext'
import type { ProjectToolContext } from '../src/agent/Types'
import { resolveProjectFileRef } from '../src/context/file-refs'
import { createProjectKernel } from '../src/index'

const execute = promisify(execFile)
let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'project-tool-surface-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function fixture(options: { approved?: boolean; readDeny?: string[] } = {}) {
  const kernel = await createProjectKernel({ root, corePolicy: { readDeny: options.readDeny ?? [] } })
  const store = new InMemoryContextPayloadStore()
  const ctx: ProjectToolContext = {
    sessionId: 'project-surface',
    codingSession: {},
    contextPayloadStore: store,
    abortSignal: new AbortController().signal,
    project: {
      getRootPath: () => root,
      kernel: async () => kernel,
      runInDirectory: async (_path, run) => run(),
      runWithApproval: async (run) => run(),
      prepareMutation: async () => ({ approved: options.approved !== false, rootPath: root, rejectionMessage: 'fixture rejected' }),
      queryCode: async () => ({}),
      runCommand: async (command, commandOptions, _allowDangerous, signal) => {
        const result = await execute('/bin/sh', ['-c', command], { cwd: root, signal, timeout: commandOptions?.timeoutMs ?? 5000 })
        return { stdout: result.stdout.slice(0, commandOptions?.maxOutputChars), stderr: result.stderr, exitCode: 0, shell: { kind: 'posix', name: 'sh' } } as never
      },
    },
    system: { canStartBackgroundCommands: () => false },
    approval: { awaitConfirmationDecision: async () => ({ approved: options.approved !== false }) } as never,
  }
  registerProjectFileContext(ctx)
  let callId = 0
  const call = async (name: string, args: Record<string, unknown>, finalize = true): Promise<any> => {
    const tool = projectTools[name]
    const context = { ...ctx, toolCallId: `surface-${++callId}` }
    const result = await tool.execute(tool.schema.parse(args), context)
    return finalize ? finalizeProjectModelResult(context, result) : result
  }
  const read = async (path: string, range?: unknown) => (await call('project:read', { path, ...(range === undefined ? {} : { range }) })).files[0]
  return { kernel, store, ctx, call, read }
}

describe('actual Project tool surface with final model references', () => {
  test('read finalization emits only source records and binds exactly the displayed range', async () => {
    await writeFile(join(root, 'a.txt'), 'first\nsecond\nthird\n')
    const { call, ctx } = await fixture()
    const raw = await call('project:read', { path: 'a.txt', range: [2] }, false)
    expect(raw.files[0].fileRef).toBeUndefined()
    expect(raw.files[0].viewSource).toStartWith('source:')
    const final: any = await finalizeProjectModelResult(ctx, raw)
    expect(final.files[0].lines).toEqual([[2, 'second']])
    expect(final.files[0].content).toBeUndefined()
    expect(final.files[0].viewSource).toBeUndefined()
    expect(final.files[0].fileRef).toStartWith('view:')
    const resolved = await resolveProjectFileRef(ctx, final.files[0].fileRef)
    expect(resolved.content).toBe('first\nsecond\nthird\n')
    expect(resolved.coverage).toEqual([{ startOffset: 6, endOffset: 13, startLine: 2, endLine: 2, completeLines: true }])
    await expect(call('project:edit', { files: [{ fileRef: final.files[0].fileRef, edits: [{ op: 'replace', range: 3, text: 'bad' }] }] })).rejects.toMatchObject({ reason: 'SCOPE_VIOLATION', details: { executionOutcome: 'not-applied' } })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('first\nsecond\nthird\n')
  })

  test('all edit selector combinations execute on one original snapshot and return fresh references', async () => {
    await writeFile(join(root, 'a.txt'), 'header\nold\nvalue oldCall()\ntarget\nend\n')
    const { call, read } = await fixture()
    const original = await read('a.txt')
    const result = await call('project:edit', { files: [{ fileRef: original.fileRef, edits: [
      { op: 'insert', at: 'start', text: 'start' },
      { op: 'replace', range: [2], text: 'new\nextra' },
      { op: 'replace', range: 3, match: 'oldCall()', text: 'newCall()' },
      { op: 'insert', range: [4, 4], side: 'before', text: 'before' },
      { op: 'insert', match: 'target', side: 'after', text: '!' },
      { op: 'insert', at: 'end', text: 'finish' },
    ] }] })
    expect(result.changed).toBe(true)
    expect(result.changeRef).toStartWith('change:')
    expect(result.contextRefreshError).toBeUndefined()
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('start\nheader\nnew\nextra\nvalue newCall()\nbefore\ntarget!\nend\nfinish\n')
    const current = result.files.find((file: any) => file.path === 'a.txt' && file.fileRef)
    expect(current?.fileRef).toStartWith('view:')
    expect(current.fileRef).not.toBe(original.fileRef)
    await call('project:edit', { files: [{ fileRef: current.fileRef, edits: [{ op: 'replace', match: 'target!', text: 'confirmed' }] }] })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toContain('confirmed\n')
    await expect(call('project:edit', { files: [{ fileRef: original.fileRef, edits: [{ op: 'replace', range: 2, text: 'stale' }] }] })).rejects.toMatchObject({ reason: 'BASE_REVISION_MISMATCH' })
  })

  test('1000 edits across two narrow windows of a 50,000-line file form one atomic patch', async () => {
    const content = Array.from({ length: 50_000 }, (_, index) => `row ${index + 1}`).join('\n')
    await writeFile(join(root, 'large.txt'), content)
    const { call, read, kernel } = await fixture()
    const first = await read('large.txt', [1, 500])
    const last = await read('large.txt', [49_501, 50_000])
    expect(first.fileRef).not.toBe(last.fileRef)
    const changed = await call('project:edit', { files: [
      { fileRef: first.fileRef, edits: Array.from({ length: 500 }, (_, index) => ({ op: 'replace', range: index + 1, text: `changed ${index + 1}` })) },
      { fileRef: last.fileRef, edits: Array.from({ length: 500 }, (_, index) => ({ op: 'replace', range: index + 49_501, text: `changed ${index + 49_501}` })) },
    ] })
    expect(kernel.getTransaction(changed.transactionId)?.patches).toHaveLength(1)
    const actual = (await readFile(join(root, 'large.txt'), 'utf8')).split('\n')
    expect(actual).toHaveLength(50_000)
    for (let index = 0; index < 500; index += 1) {
      expect(actual[index]).toBe(`changed ${index + 1}`)
      expect(actual[index + 49_500]).toBe(`changed ${index + 49_501}`)
    }
    expect(actual[501]).toBe('row 502')
    await call('project:change', { action: 'undo', changeRef: changed.changeRef })
    expect(await readFile(join(root, 'large.txt'), 'utf8')).toBe(content)
  })

  test('cross-group overlap and attempts to borrow another reference coverage reject atomically', async () => {
    await writeFile(join(root, 'a.txt'), 'first\nsecond\nthird\n')
    const { call, read } = await fixture()
    const first = await read('a.txt', 1)
    const last = await read('a.txt', 3)
    await expect(call('project:edit', { files: [
      { fileRef: first.fileRef, edits: [{ op: 'replace', match: 'third', text: 'bad' }] },
      { fileRef: last.fileRef, edits: [{ op: 'replace', match: 'third', text: 'last' }] },
    ] })).rejects.toMatchObject({ reason: 'TARGET_NOT_FOUND', details: { fileIndex: 0 } })
    const whole = await read('a.txt')
    await expect(call('project:edit', { files: [
      { fileRef: first.fileRef, edits: [{ op: 'replace', range: 1, text: 'one' }] },
      { fileRef: whole.fileRef, edits: [{ op: 'replace', range: [1, 2], text: 'two' }] },
    ] })).rejects.toMatchObject({ reason: 'INVALID_INPUT', details: { fileIndex: 1, conflictsWithFile: 0 } })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('first\nsecond\nthird\n')
  })

  test('file create, overwrite, move, delete use receipts and undo restores the latest file', async () => {
    const { call, read } = await fixture()
    const created = await call('project:file', { actions: [{ op: 'create', path: 'created.txt', text: 'old\n' }] })
    expect(created.changed).toBe(true)
    const original = await read('created.txt')
    const overwritten = await call('project:file', { actions: [{ op: 'overwrite', fileRef: original.fileRef, text: 'complete\r\n' }] })
    expect(overwritten.contextRefreshError).toBeUndefined()
    const source = await read('created.txt')
    await call('project:file', { actions: [{ op: 'move', fileRef: source.fileRef, to: 'moved.txt' }] })
    await expect(readFile(join(root, 'created.txt'))).rejects.toThrow()
    const moved = await read('moved.txt')
    const deleted = await call('project:file', { actions: [{ op: 'delete', fileRef: moved.fileRef }] })
    await expect(readFile(join(root, 'moved.txt'))).rejects.toThrow()
    const inspected = await call('project:change', { action: 'inspect', changeRef: deleted.changeRef })
    expect(inspected.changedFiles).toContain('moved.txt')
    expect(inspected.status).toBe('applied')
    expect(inspected.oldRevisions['moved.txt']).toBe(moved.revision)
    expect(inspected.newRevisions['moved.txt']).toBe('deleted')
    const undone = await call('project:change', { action: 'undo', changeRef: deleted.changeRef })
    expect(undone.status).toBe('rolled_back')
    expect((await call('project:change', { action: 'inspect', changeRef: deleted.changeRef })).status).toBe('rolled_back')
    expect(await readFile(join(root, 'moved.txt'), 'utf8')).toBe('complete\n')
  })

  test('changed reports net content and file existence, including empty files and cancelling steps', async () => {
    await writeFile(join(root, 'a.txt'), 'same\n')
    const { call, read } = await fixture()
    const first = await read('a.txt')
    const unchanged = await call('project:edit', { files: [{ fileRef: first.fileRef, edits: [{ op: 'replace', range: 1, text: 'same' }] }] })
    expect(unchanged.changed).toBe(false)
    expect((await call('project:change', { action: 'inspect', changeRef: unchanged.changeRef })).status).toBe('applied')
    const current = await read('a.txt')
    const overwritten = await call('project:file', { actions: [{ op: 'overwrite', fileRef: current.fileRef, text: 'same\n' }] })
    expect(overwritten.changed).toBe(false)

    const empty = await call('project:file', { actions: [{ op: 'create', path: 'empty.txt', text: '' }] })
    expect(empty.changed).toBe(true)
    const emptyView = await read('empty.txt')
    const moved = await call('project:file', { actions: [{ op: 'move', fileRef: emptyView.fileRef, to: 'moved-empty.txt' }] })
    expect(moved.changed).toBe(true)
    const movedView = await read('moved-empty.txt')
    const removed = await call('project:file', { actions: [{ op: 'delete', fileRef: movedView.fileRef }] })
    expect(removed.changed).toBe(true)

    const cancelled = await call('project:change', { action: 'apply', steps: [
      { tool: 'file', actions: [{ op: 'create', path: 'temporary.txt', text: '' }, { op: 'delete', path: 'temporary.txt' }] },
    ] })
    expect(cancelled.changed).toBe(false)
    await expect(readFile(join(root, 'temporary.txt'))).rejects.toThrow()
    const movedSource = await read('a.txt')
    const roundTrip = await call('project:change', { action: 'apply', steps: [
      { tool: 'file', actions: [{ op: 'move', fileRef: movedSource.fileRef, to: 'transit.txt' }, { op: 'move', sourceRef: movedSource.fileRef, to: 'a.txt' }] },
    ] })
    expect(roundTrip.changed).toBe(false)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('same\n')
  })

  test('change apply resolves created paths and moved source identities, then undo restores all paths', async () => {
    await writeFile(join(root, 'a.txt'), 'old\n')
    const { call, read } = await fixture()
    const file = await read('a.txt')
    const result = await call('project:change', { action: 'apply', steps: [
      { tool: 'file', actions: [{ op: 'create', path: 'new.txt', text: 'created\n' }, { op: 'move', fileRef: file.fileRef, to: 'moved.txt' }] },
      { tool: 'edit', files: [{ sourceRef: file.fileRef, edits: [{ op: 'replace', range: 1, text: 'moved' }] }, { path: 'new.txt', edits: [{ op: 'insert', at: 'end', text: 'checked' }] }] },
    ] })
    expect(result.changedFiles).toEqual(expect.arrayContaining(['a.txt', 'new.txt', 'moved.txt']))
    expect(await readFile(join(root, 'moved.txt'), 'utf8')).toBe('moved\n')
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('created\nchecked\n')
    await call('project:change', { action: 'undo', changeRef: result.changeRef })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('old\n')
    await expect(readFile(join(root, 'new.txt'))).rejects.toThrow()
    await expect(readFile(join(root, 'moved.txt'))).rejects.toThrow()
  })

  test('read continuations keep the original version and fragment coverage', async () => {
    await writeFile(join(root, 'a.txt'), 'first\nsecond\nthird\n')
    const { call } = await fixture()
    const first = (await call('project:read', { path: 'a.txt', maxChars: 6 })).files[0]
    expect(first.lines).toEqual([[1, 'first']])
    expect(first.continuation).toStartWith('read-page:')
    const next = (await call('project:read', { continuation: first.continuation, maxChars: 20 })).files[0]
    expect(next.lines[0]).toEqual([2, 'second'])
    await writeFile(join(root, 'a.txt'), 'new\nsecond\nthird\n')
    await expect(call('project:read', { continuation: first.continuation })).rejects.toMatchObject({ reason: 'BASE_REVISION_MISMATCH' })
  })

  test('batch reads retain successful windows when another path is denied', async () => {
    await writeFile(join(root, 'open.txt'), 'visible\n')
    await writeFile(join(root, 'denied.txt'), 'private\n')
    const { call } = await fixture({ readDeny: ['denied.txt'] })
    const result = await call('project:read', { files: [{ path: 'denied.txt' }, { path: 'open.txt', range: 1 }] })
    expect(result.files).toHaveLength(1)
    expect(result.files[0].path).toBe('open.txt')
    expect(result.files[0].fileRef).toStartWith('view:')
    expect(result.issues.length).toBeGreaterThan(0)
  })

  test('list pagination is stable and changed directory entries invalidate the cursor', async () => {
    await mkdir(join(root, 'src'))
    for (const name of ['a.ts', 'b.ts', 'c.ts']) await writeFile(join(root, 'src', name), 'export {}\n')
    const { call } = await fixture()
    const first = await call('project:list', { path: 'src', include: ['*.ts'], limit: 1 })
    expect(first.entries).toHaveLength(1)
    expect(first.cursor).toStartWith('list-page:')
    const second = await call('project:list', { cursor: first.cursor, limit: 1 })
    expect(second.entries).toHaveLength(1)
    expect(second.entries[0].path).not.toBe(first.entries[0].path)
    await writeFile(join(root, 'src/d.ts'), 'export {}\n')
    await expect(call('project:list', { cursor: second.cursor })).rejects.toMatchObject({ reason: 'INVALID_INPUT' })
  })

  test('search results authorize only returned source and support literal and regex queries', async () => {
    await writeFile(join(root, 'a.txt'), 'first\nneedle A\nsecond\nneedle B\nend\n')
    const { call } = await fixture()
    const literal = await call('project:search', { query: 'needle A', regex: false, contextLines: 0 })
    expect(literal.hits).toHaveLength(1)
    const window = literal.files[0]
    expect(window.lines).toEqual([[2, 'needle A']])
    expect(window.fileRef).toStartWith('view:')
    await call('project:edit', { files: [{ fileRef: window.fileRef, edits: [{ op: 'replace', match: 'needle A', text: 'changed A' }] }] })
    const regex = await call('project:search', { query: '(changed|needle) [AB]', regex: true, caseSensitive: true, contextLines: 0 })
    expect(regex.hits).toHaveLength(2)
    expect(regex.files.every((file: any) => typeof file.fileRef === 'string')).toBe(true)
  })

  test('rejected mutation authorization returns without changing any file', async () => {
    await writeFile(join(root, 'a.txt'), 'old\n')
    const { call, read } = await fixture({ approved: false })
    const file = await read('a.txt')
    const edited = await call('project:edit', { files: [{ fileRef: file.fileRef, edits: [{ op: 'replace', range: 1, text: 'new' }] }] })
    expect(edited).toMatchObject({ approved: false, changed: false })
    const created = await call('project:file', { actions: [{ op: 'create', path: 'new.txt', text: 'new' }] })
    expect(created).toMatchObject({ approved: false, changed: false })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('old\n')
    await expect(readFile(join(root, 'new.txt'))).rejects.toThrow()
  })

  test('syntax validation failure leaves the file intact and does not return an applied receipt', async () => {
    await writeFile(join(root, 'config.json'), '{"enabled":true}\n')
    const { call, read } = await fixture()
    const file = await read('config.json')
    await expect(call('project:edit', { files: [{ fileRef: file.fileRef, edits: [{ op: 'replace', range: 1, text: '{invalid' }] }] })).rejects.toMatchObject({ reason: 'VALIDATION_FAILED' })
    expect(await readFile(join(root, 'config.json'), 'utf8')).toBe('{"enabled":true}\n')
  })

  test('undo refuses to overwrite an external change', async () => {
    await writeFile(join(root, 'a.txt'), 'old\n')
    const { call, read } = await fixture()
    const file = await read('a.txt')
    const result = await call('project:edit', { files: [{ fileRef: file.fileRef, edits: [{ op: 'replace', range: 1, text: 'ours' }] }] })
    await writeFile(join(root, 'a.txt'), 'external\n')
    await expect(call('project:change', { action: 'undo', changeRef: result.changeRef })).rejects.toThrow()
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('external\n')
  })

  test('run executes a real foreground command with bounded output and rejects unsupported background execution', async () => {
    const { call } = await fixture()
    const result = await call('project:run', { command: 'printf project-tool-check', timeoutMs: 5000, maxOutputChars: 7 })
    expect(result.stdout).toBe('project')
    expect(result.exitCode).toBe(0)
    await expect(call('project:run', { command: 'printf background', background: true })).rejects.toThrow('后台')
  })
})
