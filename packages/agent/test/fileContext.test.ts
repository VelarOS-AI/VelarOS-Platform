import type { ModelMessage } from 'ai'
import { describe, expect, test } from 'bun:test'

import { InMemoryContextPayloadStore } from '../src/agent/context/ContextPayloadStore'
import { ProviderRequestCompiler } from '../src/agent/context/ProviderRequestCompiler'
import { compileProviderSendRequest } from '../src/agent/context/ProviderSendRequest'
import { ContextGovernanceSessionRegistry } from '../src/agent/context/residency/ContextGovernanceSession'
import {
  FileContextCoordinator,
  fileContextFor,
  type FileContextSnapshot,
  projectFileContext,
} from '../src/agent/context/resources'
import { forkFileContext } from '../src/agent/context/resources/FileContextCoordinator'
import { sliceFileSnapshot } from '../src/agent/context/resources/FileSnapshotArchive'
import { contextRetrievalTools } from '../src/tool-library/builtin/ContextRetrieval.tool'
import { fitProjectReadsForModel } from '../src/tools/projectReadSerialization'

const workspaceId = '/repo'
function snapshot(revision: string, content: string, path = 'a.ts'): FileContextSnapshot {
  return {
    workspaceId,
    path,
    revision,
    content,
    exists: true,
    range: { startLine: 1, endLine: content.split('\n').length },
    totalLines: content.split('\n').length,
    complete: true,
  }
}
function source(read: () => FileContextSnapshot) {
  return {
    workspaceId,
    normalizePath: (path: string) => {
      if (path.startsWith('../')) throw new Error('scope')
      return path
    },
    read: async () => [read()],
  }
}
function historyOf(value: FileContextSnapshot): ModelMessage[] {
  return [
    { role: 'user', content: 'Fix the file' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'read-1',
          toolName: 'project:read',
          input: { path: value.path },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'read-1',
          toolName: 'project:read',
          output: {
            type: 'json',
            value: {
              rootPath: workspaceId,
              files: [
                {
                  snapshot: { path: value.path, revision: value.revision },
                  content: value.content,
                  range: value.range,
                },
              ],
            },
          },
        },
      ],
    },
  ]
}

describe('file context provider and archive', () => {
  test('actual provider request contains B once, preserves raw A, and recalls A without reverting B', async () => {
    const store = new InMemoryContextPayloadStore()
    const ctx = { codingSession: {}, sessionId: 's', contextPayloadStore: store }
    const files = fileContextFor(ctx)!
    let disk = snapshot('A', 'old unique source')
    files.registerSource(source(() => disk))
    await files.observe([disk], files.beginObservation(), 'read-1')
    const history = historyOf(disk)
    const original = JSON.stringify(history)
    disk = snapshot('B', 'new unique source')
    files.touch(workspaceId, ['a.ts'])
    const compiler = new ProviderRequestCompiler(
      new ContextGovernanceSessionRegistry({ config: { dashboard: false } })
    )
    const compiled = await compileProviderSendRequest(
      {
        sessionId: 's',
        rawHistoryMessages: history,
        toolContext: ctx,
        payloadStore: store,
        model: 'gpt-test',
        systemPrompt: 'system',
        contextWindow: 64000,
        phase: 'stream',
        toolNameAliases: { 'project:read': 'project_read', 'context:recall': 'context_recall' },
        availableToolNames: ['project_read', 'context_recall'],
      },
      compiler
    )
    const sent = JSON.stringify(compiled.messages)
    expect(sent).toContain('new unique source')
    expect(sent.split('new unique source')).toHaveLength(2)
    expect(sent).not.toContain('old unique source')
    expect(JSON.stringify(history)).toBe(original)
    const recalled = (await contextRetrievalTools['context:recall'].execute(
      { path: 'a.ts', revision: 'A' },
      ctx as never
    )) as any
    expect(recalled.content).toBe('old unique source')
    expect(recalled.historical).toBe(true)
    expect(files.currentViews()[0]!.snapshots[0]!.revision).toBe('B')
  })

  test('late old observation is archived but never replaces a newer view', async () => {
    const files = new FileContextCoordinator(new InMemoryContextPayloadStore(), 's')
    files.registerSource(source(() => snapshot('B', 'new')))
    const old = files.beginObservation()
    await files.observe([snapshot('B', 'new')], files.beginObservation())
    await files.observe([snapshot('A', 'old')], old)
    expect(files.currentViews()[0]!.snapshots[0]!.revision).toBe('B')
    expect(((await files.recall({ path: 'a.ts', revision: 'A' })) as any).content).toBe('old')
  })

  test('refresh detects external changes, deletion and unavailable source', async () => {
    let disk = snapshot('A', 'old')
    let failure = false
    const files = new FileContextCoordinator(new InMemoryContextPayloadStore(), 's')
    files.registerSource(
      source(() => {
        if (failure) throw new Error('denied')
        return disk
      })
    )
    await files.observe([disk], files.beginObservation())
    disk = snapshot('B', 'new')
    await files.prepare()
    expect(files.currentViews()[0]!.snapshots[0]!.revision).toBe('B')
    disk = { ...disk, exists: false, revision: 'deleted', content: '' }
    await files.prepare()
    expect(files.currentViews()[0]!.status).toBe('deleted')
    failure = true
    await files.prepare()
    expect(files.currentViews()[0]!.status).toBe('unavailable')
    expect(files.currentViews()[0]!.snapshots).toEqual([])
  })

  test('archive failure preserves actual current text and reports missing archive independently', async () => {
    const store = new InMemoryContextPayloadStore()
    store.put = async () => {
      throw new Error('disk full')
    }
    const files = new FileContextCoordinator(store, 's')
    files.registerSource(source(() => snapshot('B', 'applied')))
    files.touch(workspaceId, ['a.ts'])
    await files.prepare()
    const view = files.currentViews()[0]!
    expect(view.status).toBe('fresh')
    expect(view.snapshots[0]!.content).toBe('applied')
    expect(view.refs).toEqual([])
    expect(view.error).toContain('disk full')
  })

  test('mixed revision ranges are rejected; historical partial snapshots never claim full coverage', async () => {
    const files = new FileContextCoordinator(new InMemoryContextPayloadStore(), 's')
    files.registerSource(source(() => snapshot('B', 'new')))
    await files.observe([snapshot('A', 'one'), snapshot('B', 'two')], files.beginObservation())
    expect(files.currentViews()[0]!.status).toBe('dirty')
    await files.observe(
      [{ ...snapshot('C', 'piece'), complete: false, range: { startLine: 50, endLine: 50 } }],
      files.beginObservation()
    )
    const old = (await files.recall({ path: 'a.ts', revision: 'C' })) as any
    expect(old.complete).toBe(false)
    expect(old.range.startLine).toBe(50)
  })

  test('an invalidation during archive IO cannot be overwritten by the delayed observation', async () => {
    const store = new InMemoryContextPayloadStore()
    const put = store.put.bind(store)
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    store.put = async (record) => {
      entered()
      await gate
      return put(record)
    }
    const files = new FileContextCoordinator(store, 's')
    files.registerSource(source(() => snapshot('B', 'new')))
    const old = files.observe([snapshot('A', 'old')], files.beginObservation())
    await started
    files.touch(workspaceId, ['a.ts'])
    release()
    await old
    expect(files.currentViews()[0]!.status).toBe('dirty')
    await files.prepare()
    expect(files.currentViews()[0]!.snapshots[0]!.revision).toBe('B')
  })

  test('child views are isolated and inherited refresh obeys child tool scope', async () => {
    const store = new InMemoryContextPayloadStore()
    const parent = { codingSession: {}, sessionId: 's', contextPayloadStore: store }
    const files = fileContextFor(parent)!
    files.registerSource(source(() => snapshot('A', 'parent')))
    await files.observe([snapshot('A', 'parent')], files.beginObservation(), 'read-1')
    const child = { ...parent, getCurrentVisibleToolNames: () => ['context:recall'] }
    forkFileContext(parent, child)
    const childFiles = fileContextFor(child)!
    expect(childFiles.currentViews()).toEqual([])
    childFiles.touch(workspaceId, ['a.ts'])
    await childFiles.prepare()
    expect(childFiles.currentViews()[0]!.status).toBe('unavailable')
    expect(((await childFiles.recall({ path: 'a.ts', revision: 'A' })) as any).found).toBe(false)
    expect(files.currentViews()[0]!.status).toBe('fresh')
  })

  test('bare snapshot refs use authorized recall even when the caller requests generic payload access', async () => {
    const store = new InMemoryContextPayloadStore()
    const ctx = { codingSession: {}, sessionId: 's', contextPayloadStore: store }
    const files = fileContextFor(ctx)!
    files.registerSource(source(() => snapshot('A', 'historical')))
    await files.observe([snapshot('A', 'historical')], files.beginObservation(), 'read-1')
    const ref = files.currentViews()[0]!.refs[0]!
    const recall = contextRetrievalTools['context:recall']!
    expect(((await recall.execute({ ref }, ctx as never)) as any).content).toBe('historical')
    files.registerSource({
      ...source(() => snapshot('A', 'historical')),
      validateArchive: async () => {
        throw new Error('revoked')
      },
    })
    for (const refKind of [undefined, 'payload-ref', 'tool-payload'] as const) {
      expect(((await recall.execute({ ref, refKind }, ctx as never)) as any).found).toBe(false)
    }
  })

  test('replayed numbered source preserves literal numeric prefixes after a lone CR', () => {
    const raw = {
      snapshot: { path: 'a.ts', revision: 'A' },
      content: 'first\r123|literal\nsecond',
      range: { startLine: 1, endLine: 2 },
    }
    const once = fitProjectReadsForModel(raw, 10000)
    expect(fitProjectReadsForModel(once, 10000)).toEqual(once)
    expect(JSON.stringify(once)).toContain('123|literal')
  })

  test('snapshot paging preserves UTF-16 and CRLF exactly', () => {
    const original = '中文🙂\r\n'.repeat(500)
    let offset = 0
    let result = ''
    do {
      const page = sliceFileSnapshot(original, offset, 7)
      result += page.content
      if (page.nextOffset === null) break
      expect(page.nextOffset).toBeGreaterThan(offset)
      offset = page.nextOffset
    } while (offset < original.length)
    expect(result).toBe(original)
    expect(() => sliceFileSnapshot('🙂', 1, 10)).toThrow()
  })

  test('restart restores only paths observed in this branch; workspace scope isolates archives', async () => {
    const store = new InMemoryContextPayloadStore()
    const first = new FileContextCoordinator(store, 's')
    first.registerSource(source(() => snapshot('A', 'old')))
    await first.observe([snapshot('A', 'old')], first.beginObservation(), 'read-1')
    const next = new FileContextCoordinator(store, 's')
    next.registerSource(source(() => snapshot('B', 'new')))
    await next.seedHistory(historyOf(snapshot('A', 'old')))
    await next.prepare()
    expect(next.currentViews()[0]!.snapshots[0]!.revision).toBe('B')
    const foreign = new FileContextCoordinator(store, 's')
    foreign.registerSource({
      ...source(() => snapshot('X', 'other')),
      workspaceId: '/other-worktree',
    })
    expect(((await foreign.recall({ path: 'a.ts', revision: 'A' })) as any).found).toBe(false)
  })

  test('deduplicated snapshots retain each branch observation after folded-history restart', async () => {
    const store = new InMemoryContextPayloadStore()
    const files = new FileContextCoordinator(store, 's')
    files.registerSource(source(() => snapshot('A', 'same')))
    await files.observe([snapshot('A', 'same')], files.beginObservation(), 'first-branch')
    await files.observe([snapshot('A', 'same')], files.beginObservation(), 'second-branch')
    expect(
      (await store.listForSession('s')).filter((record) => record.toolName === '__file_snapshot__')
    ).toHaveLength(1)
    const restarted = new FileContextCoordinator(store, 's')
    restarted.registerSource(source(() => snapshot('B', 'current')))
    await restarted.seedHistory([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'second-branch',
            toolName: 'project:read',
            output: { type: 'text', value: 'Folded result' },
          },
        ],
      },
    ])
    await restarted.prepare()
    expect(restarted.currentViews()[0]!.snapshots[0]!.content).toBe('current')
  })

  test('a corrupt archive does not block current refresh or valid historical recall', async () => {
    const store = new InMemoryContextPayloadStore()
    await store.put({
      sessionId: 's',
      hash: 'corrupt',
      payloadRef: 'ctx-payload:s:corrupt',
      toolCallId: 'read-1',
      toolName: '__file_snapshot__',
      serializedResult: '{broken',
      chars: 7,
      createdAt: 0,
    })
    const files = new FileContextCoordinator(store, 's')
    files.registerSource(source(() => snapshot('B', 'current')))
    await files.observe([snapshot('A', 'old')], files.beginObservation(), 'read-1')
    await files.seedHistory(historyOf(snapshot('A', 'old')))
    await files.prepare()
    expect(files.currentViews()[0]!.snapshots[0]!.revision).toBe('B')
    expect(((await files.recall({ path: 'a.ts', revision: 'A' })) as any).content).toBe('old')
    expect(((await files.recall({ ref: 'ctx-payload:s:corrupt' })) as any).reason).toBe(
      'Snapshot archive is corrupt'
    )
  })

  test('same-version page updates preserve matching refs and complete source suppresses duplicate excerpts', async () => {
    const files = new FileContextCoordinator(new InMemoryContextPayloadStore(), 's')
    files.registerSource(source(() => snapshot('A', 'one\ntwo')))
    const first = { ...snapshot('A', 'one'), complete: false, totalLines: 2 }
    const second = { ...first, content: 'two', range: { startLine: 2, endLine: 2 } }
    await files.observe([first], files.beginObservation(), 'page-1')
    await files.observe([second], files.beginObservation(), 'page-2')
    await files.observe([first], files.beginObservation(), 'page-3')
    const view = files.currentViews()[0]!
    for (let index = 0; index < view.snapshots.length; index++) {
      expect(((await files.recall({ ref: view.refs[index] })) as any).content).toBe(
        view.snapshots[index]!.content
      )
    }
    await files.observe([snapshot('A', 'one\ntwo')], files.beginObservation(), 'whole')
    await files.observe([second], files.beginObservation(), 'another-page')
    expect(files.currentViews()[0]!.snapshots).toHaveLength(1)
    expect(files.currentViews()[0]!.snapshots[0]!.complete).toBe(true)
  })

  test('1000 invalidations cap actual refresh IO before reading begins', async () => {
    const files = new FileContextCoordinator(new InMemoryContextPayloadStore(), 's')
    const readPaths: string[] = []
    files.registerSource({
      workspaceId,
      normalizePath: (path) => path,
      read: async (path) => {
        readPaths.push(path)
        return [snapshot('A', 'source', path)]
      },
    })
    files.touch(
      workspaceId,
      Array.from({ length: 1000 }, (_, index) => `${index}.ts`)
    )
    expect(files.currentViews()).toHaveLength(100)
    await files.prepare()
    expect(readPaths).toHaveLength(100)
    expect(readPaths.every((path) => Number(path.split('.')[0]) >= 900)).toBe(true)
  })

  test('100 file projection is bounded and deterministic after unchanged refresh', async () => {
    const files = new FileContextCoordinator(new InMemoryContextPayloadStore(), 's')
    files.registerSource({
      workspaceId,
      normalizePath: (path) => path,
      read: async (path) => [snapshot('A', '中🙂\\"'.repeat(1000), path)],
    })
    for (let i = 0; i < 100; i++) files.touch(workspaceId, [`${i}.ts`])
    await files.prepare()
    const first = projectFileContext([], files.currentViews(), 8000)
    expect(String(first.tail[0]!.content).length).toBeLessThanOrEqual(8050)
    await files.prepare()
    expect(projectFileContext([], files.currentViews(), 8000)).toEqual(first)
  })
})

function structuredHistory(file: FileContextSnapshot, callId = 'read-visible'): ModelMessage[] {
  const history = historyOf(file)
  const part = (history[2]!.content as any[])[0]
  part.toolCallId = callId
  part.output.value.files = [{
    kind: 'project-source-window', path: file.path, revision: file.revision,
    viewSource: `source:${file.path}`,
    lines: file.content.split('\n').map((text, index) => [index + 1, text]),
  }]
  return history
}

test('latest explicit read stays inline when the current tail cannot display its full window', async () => {
  const files = new FileContextCoordinator(new InMemoryContextPayloadStore(), 'read-budget')
  files.registerSource(source(() => snapshot('A', 'unused')))
  const requested = snapshot('A', 'only requested original source', 'requested.ts')
  await files.observe([requested], files.beginObservation())
  await files.observe([snapshot('A', 'many old matches\n'.repeat(1000), 'search.ts')], files.beginObservation())
  const history = structuredHistory(requested)
  const before = JSON.stringify(history)
  const projected = projectFileContext(history, files.currentViews(), 1200)
  expect(JSON.stringify(projected.history)).toContain('only requested original source')
  expect(JSON.stringify(projected.history)).toContain('source:requested.ts')
  expect(JSON.stringify(history)).toBe(before)
  expect(projectFileContext(history, files.currentViews(), 0).history).toEqual(projected.history)
})

test('the same current window is represented once when tail coverage is sufficient', async () => {
  const files = new FileContextCoordinator(new InMemoryContextPayloadStore(), 'once')
  const requested = snapshot('A', 'unique current source', 'requested.ts')
  files.registerSource(source(() => requested))
  await files.observe([requested], files.beginObservation())
  const history = structuredHistory(requested)
  const projected = projectFileContext(history, files.currentViews(), 8000)
  expect(JSON.stringify(projected.history)).not.toContain('unique current source')
  expect(JSON.stringify(projected.history)).toContain('file-view-receipt')
  expect(JSON.stringify(projected.tail).split('unique current source')).toHaveLength(2)
})

test('source envelopes archive parseable old windows and retain retrieval for invalid head-tail splices', async () => {
  const files = new FileContextCoordinator(new InMemoryContextPayloadStore(), 'envelopes')
  const current = snapshot('B', 'current source')
  files.registerSource(source(() => current))
  await files.observe([current], files.beginObservation())
  const old = structuredHistory(snapshot('A', 'obsolete original source'))
  const originalPart = (old[2]!.content as any[])[0]
  const wrap = (excerpt: string) => ({
    ...originalPart, output: { type: 'json', value: {
      __contextRef: 'tool-output', ref: 'output:original', excerpt,
      retrieval: { tool: 'context:recall', args: { ref: 'output:original' } },
    } },
  })
  const history: ModelMessage[] = [{ role: 'tool', content: [
    wrap(JSON.stringify(originalPart.output.value)),
    wrap('{"kind":"project-source-window",...invalid splice'),
  ] }]
  const raw = JSON.stringify(history)
  const projected = projectFileContext(history, files.currentViews(), 8000)
  const encoded = JSON.stringify(projected.history)
  expect(encoded).not.toContain('obsolete original source')
  expect(encoded).not.toContain('invalid splice')
  expect(encoded).toContain('file-view-receipt')
  expect(encoded).toContain('output:original')
  expect(JSON.stringify(history)).toBe(raw)
})

test('final provider reference binding includes valid structured source inside generic excerpt envelopes', async () => {
  const files = new FileContextCoordinator(new InMemoryContextPayloadStore(), 'nested-final')
  files.registerSource({
    ...source(() => snapshot('A', 'source')),
    finalizeModelResult: (value) => {
      const visit = (item: any): any => Array.isArray(item) ? item.map(visit)
        : item && typeof item === 'object' ? item.kind === 'project-source-window'
          ? { ...item, fileRef: 'view:actually-shown' }
          : Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)])) : item
      return visit(value)
    },
  })
  const window = { kind: 'project-source-window', path: 'a.ts', revision: 'A', lines: [[1, 'source']], viewSource: 'source:a' }
  const history: ModelMessage[] = [{ role: 'tool', content: [{
    type: 'tool-result', toolCallId: 'read', toolName: 'project:read',
    output: { type: 'json', value: { __contextRef: 'tool-output', ref: 'output:original', excerpt: JSON.stringify({ files: [window] }) } },
  }] }]
  const finalized = await files.finalizeMessages(history)
  const envelope = (finalized[0]!.content as any[])[0].output.value
  expect(typeof envelope.excerpt).toBe('string')
  expect(JSON.parse(envelope.excerpt).files[0].fileRef).toBe('view:actually-shown')
  expect(JSON.stringify(history)).not.toContain('view:actually-shown')
})


test('a current redaction policy never restores the older plaintext window when the tail is full', async () => {
  const files = new FileContextCoordinator(new InMemoryContextPayloadStore(), 'redaction-budget')
  const redacted = { ...snapshot('A', '[redacted]'), redacted: true }
  files.registerSource(source(() => redacted))
  await files.observe([redacted], files.beginObservation())
  const projected = projectFileContext(structuredHistory(snapshot('A', 'previous plaintext secret')), files.currentViews(), 0)
  expect(JSON.stringify(projected.history)).not.toContain('previous plaintext secret')
  expect(JSON.stringify(projected.history)).toContain('file-view-receipt')
})

test('the last finalization pass strips unresolved source and unsigned continuation after every source adapter has had a chance', async () => {
  const files = new FileContextCoordinator(new InMemoryContextPayloadStore(), 'unknown-source')
  const window = { kind: 'project-source-window', path: 'a.ts', viewSource: 'unknown-source', lines: [[1, 'text']], continuation: { path: 'a.ts', range: { startLine: 2 }, baseRevisions: { 'a.ts': 'A' } } }
  const result = await files.finalizeModelResult({ __contextRef: 'tool-output', ref: 'output:original', excerpt: JSON.stringify({ files: [window] }) }) as any
  const shown = JSON.parse(result.excerpt).files[0]
  expect(shown.viewSource).toBeUndefined()
  expect(shown.continuation).toBeUndefined()
  expect(shown.continuationUnavailable).toBeTruthy()
  expect(shown.lines).toEqual([[1, 'text']])
  expect(window.continuation.range.startLine).toBe(2)
})

test('model historical file recall displays Unicode LF once while archive and paging preserve original text', async () => {
  const ctx = { sessionId: 'historical-format', codingSession: {}, contextPayloadStore: new InMemoryContextPayloadStore() }
  const files = fileContextFor(ctx)!
  const original = '\uFEFFfirst\\n\r\n中文🙂\r\nlast'
  files.registerSource(source(() => snapshot('A', original)))
  await files.observe([snapshot('A', original)], files.beginObservation())
  const recall = contextRetrievalTools['context:recall']!
  const parts: string[] = []
  let offset = 0
  do {
    const result = await recall.execute({ path: 'a.ts', revision: 'A', offset, maxChars: 9 }, ctx as never) as any
    expect(result.contentFormat).toBe('unicode-lf')
    expect(result.offsetUnit).toBe('archived-utf16')
    expect(result.content).not.toContain('\r\n')
    expect(result.content.isWellFormed()).toBe(true)
    parts.push(result.content)
    offset = result.nextOffset
  } while (offset !== null)
  expect(parts.join('')).toBe('first\\n\n中文🙂\nlast')
  expect((await files.recall({ path: 'a.ts', revision: 'A' }) as any).content).toBe(original)
})

test('explicit reads outrank incidental search windows in the current view and survive trimming', async () => {
  const store = new InMemoryContextPayloadStore()
  const files = fileContextFor({ codingSession: {}, sessionId: 's', contextPayloadStore: store })!
  const disk = new Map<string, FileContextSnapshot>()
  files.registerSource({ workspaceId, normalizePath: (path: string) => path, read: async (path) => [disk.get(path)!] })
  const requested = snapshot('A', 'requested unique source', 'requested.ts')
  disk.set(requested.path, requested)
  await files.observe([requested], files.beginObservation(), 'read-1')
  for (let index = 0; index < 120; index++) {
    const incidental = snapshot('H', `hit ${index} `.repeat(40), `hit-${index}.ts`)
    disk.set(incidental.path, incidental)
    await files.observe([incidental], files.beginObservation(), 'search-1', false, 'incidental')
  }
  const views = files.currentViews()
  expect(views).toHaveLength(100)
  expect(views[0]!.path).toBe('requested.ts')
  expect(views[0]!.tier).toBe('requested')
  expect(views.slice(1).every((view) => view.tier === 'incidental')).toBe(true)
  const tail = String(projectFileContext([], views, 2_000).tail[0]!.content)
  const projected = JSON.parse(tail.slice(tail.indexOf('\n{') + 1))
  expect(projected.files[0].path).toBe('requested.ts')
  expect(projected.files[0].excerpts).toHaveLength(1)
  expect(projected.omittedFiles).toBeGreaterThan(0)
  // 顺带观察不会把显式读取降级；刷新沿用层级；再次显式读取则升级并排到最前。
  await files.observe([requested], files.beginObservation(), 'search-2', false, 'incidental')
  expect(files.currentViews().find((view) => view.path === 'requested.ts')!.tier).toBe('requested')
  await files.prepare()
  expect(files.currentViews()[0]).toMatchObject({ path: 'requested.ts', tier: 'requested', status: 'fresh' })
  expect(files.currentViews()[1]!.tier).toBe('incidental')
  await files.observe([disk.get('hit-119.ts')!], files.beginObservation(), 'read-2')
  expect(files.currentViews()[0]).toMatchObject({ path: 'hit-119.ts', tier: 'requested' })
})
