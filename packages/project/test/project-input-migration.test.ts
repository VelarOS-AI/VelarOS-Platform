import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import { InMemoryContextPayloadStore } from '@velaros-ai/agent'
import { resolveToolInputReuse } from '@velaros-ai/agent/tool-contract'

import { saveToolAttemptInput, saveToolAttemptOutcome } from '../../agent/src/tools/recovery/ToolInputReuse'
import { finalizeProjectModelResult } from '../src/agent/presentation/source-window'
import { projectTools } from '../src/agent/Project.tool'
import { registerProjectFileContext } from '../src/agent/ProjectFileContext'
import type { ProjectToolContext } from '../src/agent/Types'
import { migrateProjectReusedInput } from '../src/compatibility/input-migration'
import { createProjectKernel } from '../src/runtime/project-kernel'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'project-input-migration-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function fixture(content = 'first\nold\nlast\n') {
  await writeFile(join(root, 'a.txt'), content)
  const kernel = await createProjectKernel({ root })
  const context: ProjectToolContext = {
    sessionId: 'migration', codingSession: {}, contextPayloadStore: new InMemoryContextPayloadStore(),
    abortSignal: new AbortController().signal,
    project: { getRootPath: () => root, kernel: async () => kernel, runInDirectory: async (_path, run) => run(), runWithApproval: async (run) => run(),
      prepareMutation: async () => ({ approved: true, rootPath: root }), queryCode: async () => ({}), runCommand: async () => ({}) as never },
    system: { canStartBackgroundCommands: () => false }, approval: {} as never,
  }
  registerProjectFileContext(context)
  const read = async (range?: number | [number, number]) => {
    const raw = await projectTools['project:read'].execute({ path: 'a.txt', range }, context)
    return (await finalizeProjectModelResult(context, raw) as any).files[0]
  }
  const save = async (args: Record<string, unknown>, name = 'project:edit', callId = 'old') => {
    await saveToolAttemptInput(context, callId, name, args, 1)
    await saveToolAttemptOutcome(context, callId, 'not-applied')
  }
  const reuse = async (changes: any[], target = 'project:edit', callId = 'new') => {
    const tool = projectTools[target]
    return resolveToolInputReuse(context, target, { reuse: 'attempt:old', changes }, callId, {
      inputContractVersion: tool.inputContractVersion, inputReuseSourceTools: tool.inputReuseSourceTools,
      migrateReusedInput: (request) => tool.migrateReusedInput!(request, context),
    })
  }
  return { context, read, save, reuse }
}

const refCorrection = (fileRef: string) => [{ op: 'set', path: ['edits', 0, 'fileRef'], value: fileRef }]

test('trusted v1 failure keeps its large body and migrates only after a visible reference is attached', async () => {
  const { context, read, save, reuse } = await fixture()
  const newText = '值\\n $() "quoted" '.repeat(4000)
  await save({ edits: [{ type: 'replace_text', path: 'a.txt', oldText: 'miss', newText }] })
  await expect(reuse([{ op: 'set', path: ['edits', 0, 'oldText'], value: 'old' }])).rejects.toMatchObject({
    details: { kind: 'project-input-migration', reuse: 'attempt:old', correctionPath: ['edits', 0, 'fileRef'] },
  })
  const file = await read()
  // Failed migration did not claim the original. The retry only sends a small selector correction.
  const changes = [...refCorrection(file.fileRef), { op: 'set', path: ['edits', 0, 'oldText'], value: 'old' }]
  expect(JSON.stringify(changes).length).toBeLessThan(300)
  const migrated: any = await reuse(changes)
  expect(migrated.files[0].edits[0].text).toBe(newText)
  expect(projectTools['project:edit'].schema.safeParse({ edits: [{ type: 'replace_text', path: 'a.txt', oldText: 'old', newText }] }).success).toBe(false)
  const result: any = await projectTools['project:edit'].execute(migrated, context)
  expect(result.changed).toBe(true)
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe(`first\n${newText}\nlast\n`)
  await expect(reuse(changes, 'project:edit', 'another-consumer')).rejects.toThrow()
})

test('v1 line input retains revisions, original coordinates and empty replacement lines', async () => {
  const { context, read, save, reuse } = await fixture('one\r\ntwo\r\nthree\r\n')
  const file = await read()
  await save({ edits: [
    { type: 'replace_lines', path: 'a.txt', baseRevision: file.revision, startLine: 1, endLine: 1, newLines: [''] },
    { type: 'replace_lines', path: 'a.txt', baseRevision: file.revision, startLine: 3, endLine: 3, newLines: ['changed', ''] },
  ] })
  const migrated = await reuse([...refCorrection(file.fileRef), { op: 'set', path: ['edits', 1, 'fileRef'], value: file.fileRef }])
  await projectTools['project:edit'].execute(migrated, context)
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('\r\ntwo\r\nchanged\r\n\r\n')
})

test('old append/prepend character boundaries survive source files without a final newline', async () => {
  for (const mode of ['append', 'prepend'] as const) {
    const { context, read, save, reuse } = await fixture('body')
    const file = await read()
    await save({ path: 'a.txt', mode, content: 'suffix' }, 'project:write')
    const migrated = await reuse([{ op: 'set', path: ['fileRef'], value: file.fileRef }])
    await projectTools['project:edit'].execute(migrated, context)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe(mode === 'append' ? 'bodysuffix' : 'suffixbody')
  }
})

test('split file tool accepts a saved create body through its declared old source alias', async () => {
  const { context, save, reuse } = await fixture()
  await save({ path: 'created.txt', mode: 'create', content: 'unchanged large body' }, 'project:write')
  const migrated = await reuse([{ op: 'set', path: ['path'], value: 'other.txt' }], 'project:file')
  expect(migrated).toEqual({ actions: [{ op: 'create', path: 'other.txt', text: 'unchanged large body' }] })
  await projectTools['project:file'].execute(migrated, context)
  expect(await readFile(join(root, 'other.txt'), 'utf8')).toBe('unchanged large body')
})

test('partial coverage, stale revision and mismatched file references never become automatic write grants', async () => {
  const { context, read, save, reuse } = await fixture()
  const partial = await read(2)
  await save({ edits: [{ type: 'replace_text', path: 'a.txt', oldText: 'first', newText: 'new' }] })
  await expect(reuse(refCorrection(partial.fileRef))).rejects.toMatchObject({ reason: 'TARGET_NOT_FOUND' })
  const full = await read()
  await expect(reuse([...refCorrection(full.fileRef), { op: 'set', path: ['edits', 0, 'path'], value: 'other.txt' }])).rejects.toThrow('different file')
  await expect(migrateProjectReusedInput('project:edit', {
    input: { edits: [{ type: 'replace_lines', path: 'a.txt', baseRevision: 'old-version', startLine: 2, endLine: 2, newLines: ['new'], fileRef: full.fileRef }] },
    sourceContractVersion: 1, targetContractVersion: 2, sourceCallId: 'line', sourceToolName: 'project:edit',
  }, context)).rejects.toThrow('revision assertion')
  const restored = await reuse(refCorrection(full.fileRef))
  expect(restored).toHaveProperty('files')
})

test('strict old contract and completed history remain guarded during migration', async () => {
  const { context, read, save, reuse } = await fixture()
  const file = await read()
  await save({ edits: [{ type: 'replace_text', path: 'a.txt', oldText: 'old', newText: 'new' }] })
  await expect(reuse([...refCorrection(file.fileRef), { op: 'set', path: ['edits', 0, 'ignoredFlag'], value: true }])).rejects.toThrow()
  await saveToolAttemptInput(context, 'completed', 'project:edit', { edits: [] }, 1)
  await saveToolAttemptOutcome(context, 'completed', 'completed')
  await expect(resolveToolInputReuse(context, 'project:edit', { reuse: 'attempt:completed', changes: [{ op: 'set', path: ['edits'], value: [] }] }, 'invalid', {
    inputContractVersion: 2, migrateReusedInput: () => { throw new Error('must not call migration') },
  })).rejects.toThrow('may already have applied')
  await expect(resolveToolInputReuse({ ...context, project: { getRootPath: () => '/other-project' } }, 'project:edit', { reuse: 'attempt:old', changes: refCorrection(file.fileRef) }, 'invalid', {
    inputContractVersion: 2, migrateReusedInput: () => { throw new Error('must not call migration') },
  })).rejects.toThrow('different tool or resource scope')
})

test('a narrow visible line can restore the original unique match without resending its replacement', async () => {
  const { read, save, reuse } = await fixture()
  const file = await read(2)
  await save({ edits: [{ type: 'replace_text', path: 'a.txt', oldText: 'old', newText: 'new' }] })
  const migrated: any = await reuse(refCorrection(file.fileRef))
  expect(migrated.files[0].edits[0]).toEqual({ op: 'replace', match: 'old', text: 'new' })
})
