import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import { InMemoryContextPayloadStore } from '@velaros-ai/agent'

import { finalizeProjectModelResult } from '../src/agent/presentation/source-window'
import { projectTools } from '../src/agent/Project.tool'
import type { ProjectToolContext } from '../src/agent/Types'
import { completeProjectCoverage } from '../src/editing/planner/coverage'
import { suggestProjectEditLocations } from '../src/editing/recovery/stale-location'
import { ProjectError } from '../src/errors'
import { createProjectKernel } from '../src/index'

function view(content: string) {
  return { path: 'a.txt', revision: 'A', content, coverage: completeProjectCoverage(content) }
}

test('offers relocation only when the complete target and its distinguishing context survive', () => {
  const original = 'head\nstart\nunique\nold\nend\ntail\n'
  const edits = [{ op: 'replace' as const, range: 4, text: 'new' }]
  expect(suggestProjectEditLocations(view(original), edits, `extra\n${original}`)).toEqual([
    { editIndex: 0, range: 5, unchanged: true },
  ])
  expect(suggestProjectEditLocations(view(original), edits, original.replace('old', 'external'))).toBeUndefined()
  expect(suggestProjectEditLocations(view(original), edits, `${original}${original}`)).toBeUndefined()
})

test('unchanged first and last lines cannot hide a changed middle line', () => {
  const original = 'header\nfirst\nmiddle\nlast\nfooter\n'
  expect(suggestProjectEditLocations(view(original), [{ op: 'replace', range: [2, 4], text: 'replacement' }],
    original.replace('middle', 'changed'))).toBeUndefined()
})

test('CRLF and Unicode relocation preserves physical source coordinates', () => {
  const original = '// 中文🙂\r\nfirst\r\nold\\path\r\nlast\r\n'
  expect(suggestProjectEditLocations(view(original), [{ op: 'replace', range: [3], match: 'old\\path', text: 'new\\path' }],
    `header\r\n${original}`)).toEqual([{ editIndex: 0, range: 4, unchanged: true }])
})

test('real tool returns a new bounded reference for confirmation and never applies stale intent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-stale-recovery-'))
  try {
    const original = 'header\nstart\nunique\nold\nend\ntail\n'
    await writeFile(join(root, 'a.txt'), original)
    const kernel = await createProjectKernel({ root })
    const ctx: ProjectToolContext = {
      sessionId: 'recovery', codingSession: {}, contextPayloadStore: new InMemoryContextPayloadStore(),
      abortSignal: new AbortController().signal,
      project: {
        getRootPath: () => root, kernel: async () => kernel,
        runInDirectory: async (_path, run) => run(), runWithApproval: async (run) => run(),
        prepareMutation: async () => ({ approved: true, rootPath: root }),
        queryCode: async () => ({}), runCommand: async () => ({}) as never,
      },
      system: { canStartBackgroundCommands: () => false }, approval: {} as never,
    }
    const read = await finalizeProjectModelResult(ctx,
      await projectTools['project:read'].execute({ path: 'a.txt' }, ctx)) as any
    const input = { files: [{ fileRef: read.files[0].fileRef, edits: [{ op: 'replace', range: 4, text: 'new' }] }] }
    const current = `extra\n${original}`
    await writeFile(join(root, 'a.txt'), current)
    let failure: ProjectError | undefined
    try { await projectTools['project:edit'].execute(input, ctx) } catch (error) {
      if (error instanceof ProjectError) failure = error
      else throw error
    }
    expect(failure?.reason).toBe('BASE_REVISION_MISMATCH')
    expect(failure?.details.executionOutcome).toBe('not-applied')
    const recovery = await finalizeProjectModelResult(ctx, failure!.details.recovery) as any
    expect(recovery.requiresConfirmation).toBe(true)
    expect(recovery.candidates[0].range).toBe(5)
    expect(recovery.window.fileRef).toStartWith('view:')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe(current)
    await projectTools['project:edit'].execute({ files: [{ fileRef: recovery.window.fileRef,
      edits: [{ op: 'replace', range: recovery.candidates[0].range, text: 'new' }],
    }] }, ctx)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe(current.replace('\nold\n', '\nnew\n'))
    await expect(projectTools['project:edit'].execute({ files: [{ fileRef: recovery.window.fileRef,
      edits: [{ op: 'replace', range: 5, text: 'duplicate' }],
    }] }, ctx)).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
