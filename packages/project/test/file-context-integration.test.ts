import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ModelMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  compileProviderSendRequest,
  ContextGovernanceSessionRegistry,
  InMemoryContextPayloadStore,
  ProviderRequestCompiler,
} from '@velaros-ai/agent'
import { fileContextFor } from '@velaros-ai/agent/tool-contract'

import { registerProjectFileContext } from '../src/agent/ProjectFileContext'
import type { ProjectToolContext } from '../src/agent/Types'
import { legacyProjectTools as projectTools } from '../src/compatibility/agent-tools'
import { createProjectKernel } from '../src/index'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-file-context-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function fixture(options: Parameters<typeof createProjectKernel>[0] = { root }) {
  const kernel = await createProjectKernel({ ...options, root })
  const store = new InMemoryContextPayloadStore()
  const ctx: ProjectToolContext = {
    sessionId: 'integration',
    codingSession: {},
    contextPayloadStore: store,
    abortSignal: new AbortController().signal,
    project: {
      getRootPath: () => root,
      kernel: async () => kernel,
      runInDirectory: async (_path, run) => run(),
      runWithApproval: async (run) => run(),
      prepareMutation: async () => ({ approved: true, rootPath: root }),
      queryCode: async () => ({}),
      runCommand: async () => ({}) as never,
    },
    system: { canStartBackgroundCommands: () => false },
    approval: {} as never,
  }
  registerProjectFileContext(ctx)
  const history: ModelMessage[] = [{ role: 'user', content: 'Fix and verify the project.' }]
  let id = 0
  const call = async (name: string, args: Record<string, unknown>) => {
    const toolCallId = `call-${++id}`
    const input = projectTools[name]!.schema.parse(args)
    const result = await projectTools[name]!.execute(input, { ...ctx, toolCallId })
    history.push(
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolName: name, toolCallId, input: args }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolName: name,
            toolCallId,
            output: { type: 'json', value: JSON.parse(JSON.stringify(result)) },
          },
        ],
      }
    )
    return result as any
  }
  const compiler = new ProviderRequestCompiler(
    new ContextGovernanceSessionRegistry({ config: { dashboard: false } })
  )
  const send = async () =>
    compileProviderSendRequest(
      {
        sessionId: 'integration',
        rawHistoryMessages: history,
        toolContext: ctx as never,
        payloadStore: store,
        phase: 'stream',
        model: 'gpt-test',
        systemPrompt: 'system',
        contextWindow: 64000,
        availableToolNames: [
          ...Object.keys(projectTools).map((name) => name.replaceAll(':', '_')),
          'context_recall',
        ],
        toolNameAliases: Object.fromEntries(
          [...Object.keys(projectTools), 'context:recall'].map((name) => [
            name,
            name.replaceAll(':', '_'),
          ])
        ),
      },
      compiler
    )
  return { kernel, store, ctx, call, send, history, files: fileContextFor(ctx)! }
}

describe('Project tools maintain current file context', () => {
  test('read A, edit B, provider sees B, edit C without another read; A stays recallable', async () => {
    const original = 'const ready = false\n// 尾部🙂\\n\n'
    await writeFile(join(root, 'a.ts'), original)
    const { call, send, files } = await fixture()
    const read = await call('project:read', { path: 'a.ts' })
    const a = read.files[0].snapshot.revision
    const b = await call('project:edit', {
      edits: [
        {
          type: 'replace_lines',
          path: 'a.ts',
          baseRevision: a,
          startLine: 1,
          endLine: 1,
          newLines: ['const ready = true'],
        },
      ],
    })
    const sent = JSON.stringify((await send()).messages)
    expect(sent).toContain('const ready = true')
    const current = (await send()).messages.find((message) => typeof message.content === 'string' && message.content.startsWith('[Current project files]'))
    expect(String(current?.content)).not.toContain('const ready = false')
    await call('project:edit', {
      edits: [
        {
          type: 'replace_lines',
          path: 'a.ts',
          baseRevision: b.newRevisions['a.ts'],
          startLine: 1,
          endLine: 1,
          newLines: ['const ready = verified()'],
        },
      ],
    })
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe(
      'const ready = verified()\n// 尾部🙂\\n\n'
    )
    expect(((await files.recall({ path: 'a.ts', revision: a })) as any).content).toBe(original)
  })

  test('rename, delete and rollback publish actual current existence and source', async () => {
    await writeFile(join(root, 'a.ts'), '// original\r\n// 中文🙂\r\n')
    const { call, files } = await fixture()
    const read = await call('project:read', { path: 'a.ts' })
    const moved = await call('project:edit', {
      edits: [{ type: 'rename_file', from: 'a.ts', to: 'b.ts' }],
    })
    expect(files.currentViews().find((v) => v.path === 'a.ts')!.status).toBe('deleted')
    expect(files.currentViews().find((v) => v.path === 'b.ts')!.snapshots[0]!.content).toContain(
      '中文🙂'
    )
    expect(
      ((await files.recall({ path: 'b.ts', revision: read.files[0].snapshot.revision })) as any)
        .content
    ).toContain('original')
    await call('project:rollback', { transactionId: moved.transactionId })
    expect(files.currentViews().find((v) => v.path === 'a.ts')!.snapshots[0]!.content).toBe(
      '// original\r\n// 中文🙂\r\n'
    )
    expect(files.currentViews().find((v) => v.path === 'b.ts')!.status).toBe('deleted')
    expect(
      ((await files.recall({ path: 'a.ts', revision: read.files[0].snapshot.revision })) as any)
        .content
    ).toContain('original')
  })

  test('external same-size same-mtime modification is refreshed before provider send', async () => {
    await writeFile(join(root, 'a.ts'), 'first')
    const { call, send, files } = await fixture()
    await call('project:read', { path: 'a.ts' })
    const before = await stat(join(root, 'a.ts'))
    await writeFile(join(root, 'a.ts'), 'other')
    await utimes(join(root, 'a.ts'), before.atime, before.mtime)
    expect(JSON.stringify((await send()).messages)).toContain('other')
    expect(files.currentViews()[0]!.snapshots[0]!.content).toBe('other')
  })

  test('successful write survives archive failure and is not repeated', async () => {
    const { call, store, files } = await fixture()
    store.put = async () => {
      throw new Error('archive unavailable')
    }
    const result = await call('project:write', {
      path: 'report.txt',
      mode: 'create',
      content: 'created once',
    })
    expect(result.changed).toBe(true)
    expect(await readFile(join(root, 'report.txt'), 'utf8')).toBe('created once')
    expect(files.currentViews()[0]!.error).toContain('archive unavailable')
  })

  test('committed snapshot archives obey redaction and current historical-read policy', async () => {
    let denied = false
    const secret = 'PRIVATE_VALUE'
    await writeFile(join(root, 'a.txt'), `key=${secret}\nvalue=1\n`)
    const { call, store, files } = await fixture({
      root,
      providers: {
        secretRedaction: {
          redact: ({ content }) => ({
            content: content.replaceAll(secret, '[hidden]'),
            redacted: content.includes(secret),
          }),
        },
        policy: { decide: ({ action }) => ({ allow: !(denied && action === 'read') }) },
      },
    })
    const read = await call('project:read', { path: 'a.txt' })
    const revision = read.files[0].snapshot.revision
    await call('project:edit', {
      edits: [{ type: 'replace_text', path: 'a.txt', oldText: 'value=1', newText: 'value=2' }],
    })
    const archives = (await store.listForSession('integration')).filter(
      (r) => r.toolName === '__file_snapshot__'
    )
    expect(archives.length).toBeGreaterThan(0)
    expect(archives.every((r) => !r.serializedResult.includes(secret))).toBe(true)
    expect(((await files.recall({ path: 'a.txt', revision })) as any).content).toContain('[hidden]')
    denied = true
    const blocked = (await files.recall({ path: 'a.txt', revision })) as any
    expect(blocked.found).toBe(false)
    expect(blocked.reason).toContain('policy')
  })

  test('archives committed B even when an external writer immediately advances disk to C', async () => {
    await writeFile(join(root, 'a.txt'), 'A')
    const { kernel, call, files } = await fixture()
    await call('project:read', { path: 'a.txt' })
    const apply = kernel.applyEdit.bind(kernel)
    kernel.applyEdit = async (input) => {
      const applied = await apply(input)
      await writeFile(join(root, 'a.txt'), 'C')
      return applied
    }
    const edit = await call('project:edit', {
      edits: [{ type: 'replace_text', path: 'a.txt', oldText: 'A', newText: 'B' }],
    })
    expect(files.currentViews()[0]!.snapshots[0]!.content).toBe('C')
    expect(
      ((await files.recall({ path: 'a.txt', revision: edit.newRevisions['a.txt'] })) as any).content
    ).toBe('B')
  })

  test('100-file transaction archives all versions and bounds provider source coverage', async () => {
    await Promise.all(
      Array.from({ length: 100 }, (_, i) => writeFile(join(root, `${i}.txt`), `before-${i}`))
    )
    const { call, files, send } = await fixture()
    const edited = await call('project:edit', {
      edits: Array.from({ length: 100 }, (_, i) => ({
        type: 'replace_text',
        path: `${i}.txt`,
        oldText: `before-${i}`,
        newText: `after-${i}`,
      })),
    })
    expect(edited.changedFiles).toHaveLength(100)
    expect(files.currentViews()).toHaveLength(100)
    for (const view of files.currentViews()) {
      expect(view.snapshots[0]!.revision).toBe(edited.newRevisions[view.path])
      expect(view.snapshots[0]!.content).toBe(`after-${view.path.replace('.txt', '')}`)
    }
    const request = await send()
    expect(request.decision.okToSend).toBe(true)
    const current = request.messages.find(
      (message) =>
        typeof message.content === 'string' && message.content.startsWith('[Current project files]')
    )
    expect(String(current?.content).length).toBeLessThanOrEqual(32000)
  }, 30000)

  test('read target replaces its exact lines and a stale target cannot overwrite later edits', async () => {
    await writeFile(join(root, 'target.ts'), 'const a = 1\nconst b = 2\n')
    const { call } = await fixture()
    const read = (await call('project:read', {
      path: 'target.ts',
      range: { startLine: 1, endLine: 1 },
    })) as any
    for (const options of [{ maxChars: 2 }, { range: { startLine: 1, endLine: 1, endColumn: 3 } }, { range: { startLine: 99, endLine: 100 } }]) {
      const partial = await call('project:read', { path: 'target.ts', ...options })
      expect(partial.files[0].editTarget).toBeUndefined()
    }
    const ref = read.files[0].editTarget
    expect(ref).toStartWith('selection:')
    await call('project:edit', {
      edits: [{ type: 'replace_selection', selectionRef: ref, newLines: ['const a = 3'] }],
    })
    expect(await readFile(join(root, 'target.ts'), 'utf8')).toBe('const a = 3\nconst b = 2\n')
    await expect(
      call('project:edit', {
        edits: [{ type: 'replace_selection', selectionRef: ref, newLines: ['const a = 9'] }],
      })
    ).rejects.toThrow()
    expect(await readFile(join(root, 'target.ts'), 'utf8')).toBe('const a = 3\nconst b = 2\n')
  })

  test('500 edits in 20000 lines keep current excerpts at the new revision', async () => {
    const original = Array.from({ length: 20000 }, (_, i) => `line ${i + 1}`).join('\n')
    await writeFile(join(root, 'large.txt'), original)
    const { call, files, send } = await fixture()
    const result = await call('project:read', {
      path: 'large.txt',
      range: { startLine: 1000, endLine: 1010 },
    })
    const baseRevision = result.files[0].snapshot.revision
    const edits = Array.from({ length: 500 }, (_, i) => ({
      type: 'replace_lines',
      path: 'large.txt',
      baseRevision,
      startLine: 1000 + i * 20,
      endLine: 1000 + i * 20,
      newLines: [`changed ${i}`],
    }))
    const changed = await call('project:edit', { edits })
    const current = files.currentViews()[0]!
    expect(current.snapshots.every((s) => s.revision === changed.newRevisions['large.txt'])).toBe(
      true
    )
    expect(current.snapshots.some((s) => s.content.includes('changed 0'))).toBe(true)
    expect(JSON.stringify((await send()).messages)).toContain('changed 0')
    const archive = (await files.recall({ path: 'large.txt', revision: baseRevision })) as any
    expect(archive.complete).toBe(true)
    expect(archive.range.startLine).toBe(1)
    expect(archive.content).toBe(original.slice(0, 8000))
  }, 30000)
})
