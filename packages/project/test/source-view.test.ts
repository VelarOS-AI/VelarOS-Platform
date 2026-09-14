import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { AgentTurnHistoryHelper, compileProviderSendRequest, ContextGovernanceSessionRegistry, InMemoryContextPayloadStore, ProviderRequestCompiler } from '@velaros-ai/agent'
import { fileContextFor } from '@velaros-ai/agent/tool-contract'

import { fitProjectReadsForModel } from '../../agent/src/tools/projectReadSerialization'
import { ProjectReadInputSchema } from '../src/agent/contracts/read'
import { finalizeProjectModelResult, projectSourceLines } from '../src/agent/presentation/source-window'
import { executeProjectRead } from '../src/agent/tools/read'
import { executeProjectSearch } from '../src/agent/tools/search'
import type { ProjectToolContext } from '../src/agent/Types'
import { resolveProjectFileRef, saveProjectFileSource } from '../src/context/file-refs'
import { createProjectKernel } from '../src/index'

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'project-source-view-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const kernel = await createProjectKernel({ root })
  const context: ProjectToolContext = {
    sessionId: 'source-test', codingSession: {}, contextPayloadStore: new InMemoryContextPayloadStore(),
    abortSignal: new AbortController().signal,
    project: {
      getRootPath: () => root, kernel: async () => kernel,
      runInDirectory: async (_path, fn) => fn(), runWithApproval: async (fn) => fn(),
      prepareMutation: async () => ({ approved: true, rootPath: root }),
      queryCode: async () => ({}), runCommand: async () => ({}) as never,
    },
    system: { canStartBackgroundCommands: () => false }, approval: {} as never,
  }
  const read = async (input: Parameters<typeof executeProjectRead>[0], budget = 30_000) => {
    const raw = await executeProjectRead(input, context)
    return await finalizeProjectModelResult(context, fitProjectReadsForModel(raw, budget)) as any
  }
  return { kernel, context, read }
}

describe('Project immutable visible source references', () => {
  test('range shorthands, raw line records and full original source share exact coordinates', async () => {
    const original = 'first\r\n123|literal🙂\\n\r\nlast\r\n'
    await writeFile(join(root, 'a.ts'), original)
    const { context, read } = await fixture()
    for (const range of [2, [2], [2, 2]] as const) {
      const result = await read({ path: 'a.ts', range: range as any })
      const file = result.files[0]
      expect(file.lines).toEqual([[2, '123|literal🙂\\n']])
      expect(file.content).toBeUndefined()
      expect(file.viewSource).toBeUndefined()
      const resolved = await resolveProjectFileRef(context, file.fileRef)
      expect(resolved.content).toBe(original)
      expect(resolved.coverage).toEqual([{ startOffset: 7, endOffset: original.indexOf('last'), startLine: 2, endLine: 2, completeLines: true }])
    }
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe(original)
  })

  test('source candidates cannot edit and final clipping grants only surviving complete lines', async () => {
    await writeFile(join(root, 'a.ts'), Array.from({ length: 1000 }, (_, i) => `line ${i + 1} 🙂`).join('\n'))
    const { context } = await fixture()
    const raw = await executeProjectRead({ path: 'a.ts', maxChars: 100_000 }, context)
    expect(raw.files[0].fileRef).toBeUndefined()
    await expect(resolveProjectFileRef(context, raw.files[0].viewSource!)).rejects.toThrow()
    const sent = await finalizeProjectModelResult(context, fitProjectReadsForModel(raw, 1800)) as any
    const file = sent.files[0]
    const view = await resolveProjectFileRef(context, file.fileRef)
    expect(file.lines.length).toBeGreaterThan(0)
    expect(file.lines.length).toBeLessThan(raw.files[0].lines.length)
    expect(view.coverage).toHaveLength(1)
    expect(view.coverage[0].endLine).toBe(file.lines.at(-1)[0])
    expect(file.continuation).toStartWith('read-page:')
  })

  test('a long Unicode line grants fragment characters only, and continuation progresses exactly', async () => {
    const original = '🙂\\n"'.repeat(1000)
    await writeFile(join(root, 'a.ts'), original)
    const { context, read } = await fixture()
    const first = (await read({ path: 'a.ts', maxChars: 10000 }, 1200)).files[0]
    expect(first.lines).toEqual([])
    expect(first.fragments[0].text.isWellFormed()).toBe(true)
    const view = await resolveProjectFileRef(context, first.fileRef)
    expect(view.coverage[0].completeLines).toBe(false)
    expect(view.coverage[0].endOffset).toBe(first.fragments[0].columns[1] - 1)
    const second = (await read({ continuation: first.continuation, maxChars: 10000 }, 1200)).files[0]
    expect(second.fragments[0].columns[0]).toBe(first.fragments[0].columns[1])
    expect(original.startsWith(first.fragments[0].text + second.fragments[0].text)).toBe(true)
  })

  test('fileRef is branch scoped, immutable, and rejects same-metadata content changes', async () => {
    await writeFile(join(root, 'a.ts'), 'first')
    const { kernel, context, read } = await fixture()
    const originalRead = kernel.read.bind(kernel)
    kernel.read = async (input) => {
      const value = await originalRead({ ...input, baseRevision: undefined })
      return { ...value, snapshot: { ...value.snapshot, revision: 'constant-metadata-revision' } }
    }
    const file = (await read({ path: 'a.ts' })).files[0]
    await expect(resolveProjectFileRef({ ...context, codingSession: {} }, file.fileRef)).rejects.toThrow('branch')
    await writeFile(join(root, 'a.ts'), 'other')
    await expect(resolveProjectFileRef(context, file.fileRef)).rejects.toThrow('content changed')
    const next = (await read({ path: 'a.ts' })).files[0]
    expect(next.fileRef).not.toBe(file.fileRef)
    expect((await resolveProjectFileRef(context, next.fileRef)).content).toBe('other')
  })

  test('batch ranges are independent and a missing file does not swallow other windows', async () => {
    await writeFile(join(root, 'a.ts'), 'a1\na2\na3')
    await writeFile(join(root, 'b.ts'), 'b1\nb2\nb3')
    const { read } = await fixture()
    const result = await read({ files: [{ path: 'a.ts', range: 2 }, { path: 'missing.ts' }, { path: 'b.ts', range: [1, 2] }] })
    expect(result.files.find((file: any) => file.path === 'a.ts').lines).toEqual([[2, 'a2']])
    expect(result.files.find((file: any) => file.path === 'b.ts').lines).toEqual([[1, 'b1'], [2, 'b2']])
    expect(result.issues.some((issue: any) => issue.path === 'missing.ts')).toBe(true)
  })

  test('empty files and end-of-file blank lines have explicit zero-width full-line coverage', async () => {
    const { context, read } = await fixture()
    for (const original of ['', 'line\n']) {
      await writeFile(join(root, 'a.ts'), original)
      const file = (await read({ path: 'a.ts' })).files[0]
      const view = await resolveProjectFileRef(context, file.fileRef)
      expect(file.lines.at(-1)).toEqual([original ? 2 : 1, ''])
      expect(view.coverage.at(-1)?.completeLines).toBe(true)
      expect(view.coverage.at(-1)?.endOffset).toBe(original.length)
    }
    expect(projectSourceLines('a\r\nb\rc').map((line) => line.text)).toEqual(['a', 'b\rc'])
  })

  test('search grants only confirmed source windows at the hit revision', async () => {
    await writeFile(join(root, 'a.ts'), 'before\nconst target = 1\nafter\n')
    const { context } = await fixture()
    const raw = await executeProjectSearch({ query: 'target' }, context)
    expect(raw.hits).toHaveLength(1)
    expect(raw.hits[0]?.revision).toBeTruthy()
    const result = await finalizeProjectModelResult(context, raw) as any
    expect(result.files[0].lines).toContainEqual([2, 'const target = 1'])
    const view = await resolveProjectFileRef(context, result.files[0].fileRef)
    expect(view.coverage[0].startLine).toBe(1)
    expect(view.coverage[0].endLine).toBe(3)
  })

  test('the actual final provider request issues current fileRefs after refresh and keeps old source historical', async () => {
    await writeFile(join(root, 'a.ts'), 'first\n')
    const { context } = await fixture()
    const raw = await executeProjectRead({ path: 'a.ts' }, { ...context, toolCallId: 'read-1' })
    await writeFile(join(root, 'a.ts'), 'other\n')
    const compiler = new ProviderRequestCompiler(new ContextGovernanceSessionRegistry({ config: { dashboard: false } }))
    const sent = await compileProviderSendRequest({
      sessionId: context.sessionId!, toolContext: context as never, payloadStore: context.contextPayloadStore,
      rawHistoryMessages: [
        { role: 'user', content: 'Inspect this file.' },
        { role: 'assistant', content: [{ type: 'tool-call', toolName: 'project:read', toolCallId: 'read-1', input: { path: 'a.ts' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolName: 'project:read', toolCallId: 'read-1', output: { type: 'json', value: JSON.parse(JSON.stringify(raw)) } }] },
      ], phase: 'stream', model: 'gpt-test', systemPrompt: 'system', contextWindow: 64000,
      availableToolNames: ['project_read'], toolNameAliases: { 'project:read': 'project_read' },
    }, compiler)
    expect(sent.providerRequest.messages).toEqual(JSON.parse(JSON.stringify(sent.messages)))
    expect(sent.providerRequest.requestFingerprint).toEqual(sent.requestFingerprint)
    const message = sent.messages.find((item) => typeof item.content === 'string' && item.content.startsWith('[Current project files]'))!
    const value = JSON.parse(String(message.content).slice(String(message.content).indexOf('\n{') + 1))
    const excerpt = value.files[0].excerpts[0]
    expect(excerpt.lines).toContainEqual([1, 'other'])
    expect(excerpt.viewSource).toBeUndefined()
    expect((await resolveProjectFileRef(context, excerpt.fileRef)).content).toBe('other\n')
    const archives = await fileContextFor(context)!.recall({ path: 'a.ts', revision: raw.files[0].revision }) as any
    expect(archives.content).toBe('first\n')
  })
})

test('disjoint visible windows share one ref without authorizing the intervening lines', async () => {
  await writeFile(join(root, 'a.ts'), 'one\ntwo\nthree\nfour\nfive')
  const { context, read } = await fixture()
  const result = await read({ files: [{ path: 'a.ts', range: 1 }, { path: 'a.ts', range: [4, 5] }] })
  expect(result.files[0].fileRef).toBe(result.files[1].fileRef)
  const view = await resolveProjectFileRef(context, result.files[0].fileRef)
  expect(view.coverage.map((range) => [range.startLine, range.endLine])).toEqual([[1, 1], [4, 5]])
  expect(fileContextFor(context)!.currentViews()[0]!.snapshots.map((snapshot) => snapshot.presentation?.lines)).toEqual([[[1, 'one']], [[4, 'four'], [5, 'five']]])
})

test('altered line text never inherits the original full line grant', async () => {
  await writeFile(join(root, 'a.ts'), 'const actual = 123\n')
  const { context } = await fixture()
  const raw = await executeProjectRead({ path: 'a.ts', range: 1 }, context)
  raw.files[0].lines[0]![1] = 'const actual = …'
  const result = await finalizeProjectModelResult(context, raw) as any
  expect(result.files[0].fileRef).toBeUndefined()
})

test('failed shared-reference persistence preserves valid individual window references', async () => {
  await writeFile(join(root, 'a.ts'), 'one\ntwo\nthree')
  const { context, read } = await fixture()
  const put = context.contextPayloadStore!.put.bind(context.contextPayloadStore)
  context.contextPayloadStore!.put = async (record) => {
    const value = JSON.parse(record.serializedResult)
    if (value.kind === 'project-file-view' && value.coverage.length > 1) throw new Error('shared view store unavailable')
    return put(record)
  }
  const result = await read({ files: [{ path: 'a.ts', range: 1 }, { path: 'a.ts', range: 3 }] })
  expect(result.files[0].fileRef).not.toBe(result.files[1].fileRef)
  expect((await resolveProjectFileRef(context, result.files[0].fileRef)).coverage[0]?.startLine).toBe(1)
  expect((await resolveProjectFileRef(context, result.files[1].fileRef)).coverage[0]?.startLine).toBe(3)
})

for (const failedKind of ['project-file-source', 'project-file-view', 'project-read-page']) test(`failed ${failedKind} persistence gives a valid new-schema reread instead of an unsigned legacy continuation`, async () => {
  await writeFile(join(root, 'large.ts'), Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join('\n'))
  const { context, read } = await fixture()
  const put = context.contextPayloadStore!.put.bind(context.contextPayloadStore)
  context.contextPayloadStore!.put = async (record) => {
    if (JSON.parse(record.serializedResult).kind === failedKind) throw new Error('reference store unavailable')
    return put(record)
  }
  const result = await read({ path: 'large.ts', maxChars: 100 }, 1200)
  const file = result.files[0]
  expect(file.continuation).toBeUndefined()
  expect(file.continuationUnavailable).toBeTruthy()
  expect(file.readAgain.path).toBe('large.ts')
  expect(ProjectReadInputSchema.safeParse(file.readAgain).success).toBe(true)
  expect(JSON.stringify(file.readAgain)).not.toContain('baseRevision')
  context.contextPayloadStore!.put = put
  const resumed = await read(file.readAgain)
  expect(resumed.files[0].fileRef).toStartWith('view:')
  expect((await resolveProjectFileRef(context, resumed.files[0].fileRef)).coverage[0]?.startLine).toBe(file.readAgain.range)
})

for (const wrapped of [false, true]) test(`real failed-turn provider pipeline keeps candidates for one decision (${wrapped ? 'payload excerpt' : 'direct'})`, async () => {
  await writeFile(join(root, 'active.ts'), 'const active = true\n')
  await writeFile(join(root, 'candidate.ts'), 'before\nconst target = 2\nafter\n')
  const { kernel, context } = await fixture()
  // A normal read registers the source adapter. Candidate generation itself must not observe a file.
  await executeProjectRead({ path: 'active.ts' }, context)
  const current = await kernel.read({ path: 'candidate.ts' })
  const window = {
    kind: 'project-source-window', path: 'candidate.ts', revision: current.snapshot.revision,
    lines: [[2, 'const target = 2']],
    viewSource: await saveProjectFileSource(context, {
      path: 'candidate.ts', revision: current.snapshot.revision!, content: current.content!,
    }),
  }
  const failure = {
    error: 'tool_execution_failed', code: 'BASE_REVISION_MISMATCH', toolName: 'project:edit',
    details: { executionOutcome: 'not-applied', recovery: {
      kind: 'project-edit-candidates', requiresConfirmation: true,
      candidates: [{ range: 2, explanation: 'candidate-decision-only-marker' }], window,
    } },
  }
  const history: any[] = [
    { role: 'user', content: 'Apply the authorized change.' },
    { role: 'assistant', content: [{ type: 'tool-call', toolName: 'project:edit', toolCallId: 'failed-edit', input: { files: [] } }] },
  ]
  await new AgentTurnHistoryHelper().appendToolResultsToHistory(history, {
    collectAll: async () => [{ toolName: 'project:edit', toolCallId: 'failed-edit', error: 'stale view', result: failure }],
    getTerminalError: () => undefined,
  })
  const rawOutput = history[2].content[0].output
  expect(rawOutput.type).toBe('error-text')
  if (wrapped) rawOutput.value = JSON.stringify({
    __contextRef: 'tool-output', v: 1, ref: 'failed-edit', excerpt: rawOutput.value,
    retrieval: { tool: 'context:recall', args: { ref: 'failed-edit', refKind: 'tool-payload' } },
  })
  const durableHistory = JSON.stringify(history)
  const compiler = new ProviderRequestCompiler(new ContextGovernanceSessionRegistry({ config: { dashboard: false } }))
  const compile = () => compileProviderSendRequest({
    sessionId: context.sessionId!, toolContext: context as never, payloadStore: context.contextPayloadStore,
    rawHistoryMessages: history, phase: 'stream', model: 'gpt-test', systemPrompt: 'system', contextWindow: 64000,
    availableToolNames: ['project_edit', 'context_recall'], toolNameAliases: { 'project:edit': 'project_edit', 'context:recall': 'context_recall' },
  }, compiler)
  const getFailure = (messages: any[]) => {
    const output = messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .find((part) => part.type === 'tool-result' && part.toolCallId === 'failed-edit').output
    expect(output.type).toBe('error-text')
    const value = JSON.parse(output.value)
    if (!wrapped) return value
    expect(value.ref).toBe('failed-edit')
    expect(value.retrieval.args.ref).toBe('failed-edit')
    return JSON.parse(value.excerpt)
  }
  const first = await compile()
  const recovery = getFailure(first.messages).details.recovery
  expect(recovery.candidates[0].explanation).toBe('candidate-decision-only-marker')
  expect(recovery.window.kind).toBe('project-source-window')
  expect(recovery.window.viewSource).toBeUndefined()
  const view = await resolveProjectFileRef(context, recovery.window.fileRef)
  expect(view.coverage.map((range) => [range.startLine, range.endLine])).toEqual([[2, 2]])
  expect(JSON.stringify(first.messages.filter((message) => typeof message.content === 'string' && message.content.startsWith('[Current project files]')))).not.toContain('candidate.ts')
  expect(JSON.stringify(history)).toBe(durableHistory)
  history.push({ role: 'assistant', content: 'I will confirm the candidate and reuse the saved text.' })
  history.push({ role: 'user', content: 'Continue the authorized task.' })
  const next = await compile()
  expect(getFailure(next.messages).details.recovery.status).toBe('archived')
  expect(JSON.stringify(next.messages)).not.toContain('candidate-decision-only-marker')
  expect(JSON.stringify(history.slice(0, 3))).toBe(durableHistory)
})
