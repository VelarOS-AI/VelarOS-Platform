import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import {
  AgentTurnHistoryHelper,
  compileProviderSendRequest,
  ContextGovernanceSessionRegistry,
  InMemoryContextPayloadStore,
  ProviderRequestCompiler,
  ToolExecutionPolicy,
  type ToolExecutionPolicyContext,
  ToolExecutor,
  type ToolExecutorEvents,
} from '@velaros-ai/agent'
import { logRuntime } from '@velaros-ai/core/logger'

import { projectTools } from '../src/agent/Project.tool'
import { registerProjectFileContext } from '../src/agent/ProjectFileContext'
import type { ProjectToolContext } from '../src/agent/Types'
import { createProjectKernel } from '../src/index'

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'project-batch-visibility-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const kernel = await createProjectKernel({ root })
  const context: ProjectToolContext & ToolExecutionPolicyContext = {
    sessionId: 'batch-visibility',
    contextPayloadStore: new InMemoryContextPayloadStore(),
    abortSignal: new AbortController().signal,
    log: logRuntime.tag('ProjectBatchVisibility'),
    role: { id: 'assistant' },
    execution: null,
    getCurrentVisibleToolSurfaceProfile: () => null,
    codingSession: {
      recordToolResult: () => undefined,
      getRedundantToolCallMessage: () => null,
      consumePendingAutoApprovalNotice: () => null,
      hasSessionToolCategoryApproval: () => true,
      getToolSurfaceProfile: () => 'full',
      setToolSurfaceProfile: (value) => value,
      getRunProfile: () => 'auto',
      setRunProfile: (value) => value,
    },
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
  registerProjectFileContext(context)
  const tools = Object.fromEntries(Object.entries(projectTools).map(([name, tool]) => [name, {
    ...tool,
    execute: (args: Record<string, unknown>, executionContext: ToolExecutionPolicyContext) => tool.execute(args, { ...context, ...executionContext }),
  }]))
  const policy = new ToolExecutionPolicy({
    get: (name) => tools[name],
    listAvailable: (_context, names) => (names ?? []).filter((name) => !!projectTools[name]).map((name) => ({ name })),
    getDescriptor: () => null,
  })
  const events: ToolExecutorEvents = {
    emitRuntime: () => undefined,
    emitNotice: () => undefined,
    emitToolStart: () => undefined,
    emitToolProgress: () => undefined,
    emitToolMetadata: () => undefined,
    emitToolDone: () => undefined,
  }
  return { context, policy, events }
}

const toolResult = (messages: any[], toolCallId: string) => messages
  .flatMap((message) => Array.isArray(message.content) ? message.content : [])
  .find((part) => part.type === 'tool-result' && part.toolCallId === toolCallId)

test('a batch read over the page-out budget and a same-batch search both stay visible: complete JSON, explicit files ahead of search windows', async () => {
  const modules = Array.from({ length: 6 }, (_, index) => `module-${index}.ts`)
  for (const [index, path] of modules.entries()) {
    const lines = Array.from({ length: 120 }, (_, line) => `export const value_${index}_${line} = "中文🙂 ${'x'.repeat(28)}" // beacon`)
    await writeFile(join(root, path), `${lines.join('\n')}\n`)
  }
  for (let index = 0; index < 40; index++)
    await writeFile(join(root, `hit-${index}.ts`), `// before\nexport const needle_${index} = ${index}\n// after\n`)
  const { context, policy, events } = await fixture()

  const executor = new ToolExecutor(context, events, policy)
  const readArgs = { files: modules.map((path) => ({ path })), maxChars: 60_000 }
  const searchArgs = { query: 'needle', limit: 100, contextLines: 3 }
  executor.enqueue('read-batch', 'project:read', readArgs, false)
  executor.enqueue('search-needle', 'project:search', searchArgs, false)
  const results = await executor.collectAll()
  expect(results.map((result) => result.error)).toEqual([undefined, undefined])
  // 完整结果远超 24K 页出阈值；模型看到的版本必须仍是完整结构，而不是头尾拼接的残片。
  expect(JSON.stringify(results.find((result) => result.toolCallId === 'read-batch')!.result).length).toBeGreaterThan(24_000)

  const history: any[] = [
    { role: 'user', content: 'Explain how the modules use needle.' },
    { role: 'assistant', content: [
      { type: 'tool-call', toolName: 'project:read', toolCallId: 'read-batch', input: readArgs },
      { type: 'tool-call', toolName: 'project:search', toolCallId: 'search-needle', input: searchArgs },
    ] },
  ]
  await new AgentTurnHistoryHelper().appendToolResultsToHistory(history, { collectAll: async () => results, getTerminalError: () => undefined })
  const compiler = new ProviderRequestCompiler(new ContextGovernanceSessionRegistry({ config: { dashboard: false } }))
  const compiled = await compileProviderSendRequest({
    sessionId: context.sessionId!, toolContext: context as never, payloadStore: context.contextPayloadStore,
    rawHistoryMessages: history, phase: 'stream', model: 'gpt-test', systemPrompt: 'system', contextWindow: 64000,
    availableToolNames: ['project_read', 'project_search', 'context_recall'],
    toolNameAliases: { 'project:read': 'project_read', 'project:search': 'project_search', 'context:recall': 'context_recall' },
  }, compiler)
  expect(compiled.decision.okToSend).toBe(true)

  const shownRead = JSON.parse(toolResult(compiled.messages, 'read-batch').output.value)
  expect(shownRead.__contextRef).toBeUndefined()
  expect(shownRead.files.map((file: any) => file.path)).toEqual(modules)
  const tailMessage = compiled.messages.find((message) => typeof message.content === 'string' && message.content.startsWith('[Current project files]'))
  const tailText = String(tailMessage?.content)
  const tail = JSON.parse(tailText.slice(tailText.indexOf('\n{') + 1))
  const tailPaths: string[] = tail.files.map((file: any) => file.path)
  // 显式读取的文件排在搜索窗口之前；预算不足时先省略搜索命中。
  const firstHit = tailPaths.findIndex((path) => path.startsWith('hit-'))
  const lastModule = tailPaths.reduce((last, path, index) => modules.includes(path) ? index : last, -1)
  expect(lastModule).toBeGreaterThanOrEqual(0)
  expect(firstHit === -1 || firstHit > lastModule).toBe(true)
  // 每个显式读取的文件都能看到源码：回执里是完整行记录，或当前视图里有摘录。
  for (const [index, path] of modules.entries()) {
    const inline = shownRead.files.find((file: any) => file.path === path)
    const view = tail.files.find((file: any) => file.path === path)
    const inlineLines = inline?.kind === 'project-source-window' ? inline.lines : []
    const tailLines = view?.excerpts?.flatMap((excerpt: any) => excerpt.lines ?? []) ?? []
    const visible = [...inlineLines, ...tailLines]
    expect(visible.length, path).toBeGreaterThan(0)
    expect(visible[0], path).toEqual([1, `export const value_${index}_0 = "中文🙂 ${'x'.repeat(28)}" // beacon`])
    // 被回执化的文件必须在当前视图里有正文，反之亦然。
    if (inline?.kind === 'file-view-receipt') expect(tailLines.length, path).toBeGreaterThan(0)
    if (inlineLines.length > 0 && inline.hasMore) expect(typeof inline.continuation === 'string' || typeof inline.continuationUnavailable === 'string', path).toBe(true)
  }
  // 搜索窗口进入了当前视图或搜索回执，但只作为顺带观察。
  const shownSearch = JSON.parse(toolResult(compiled.messages, 'search-needle').output.value)
  expect(shownSearch.__contextRef).toBeUndefined()
  expect(shownSearch.hits).toHaveLength(40)
  // 窗口预算按呈现 JSON 计算；没有拿到窗口的命中保留定位并标明不可直接编辑。
  const windowed = new Set(shownSearch.files.map((file: any) => file.path))
  expect(windowed.size).toBeGreaterThan(0)
  for (const hit of shownSearch.hits) expect(windowed.has(hit.path) ? hit.editable : hit.editable === false, hit.path).not.toBe(false)
}, 30_000)
