import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import {
  AgentTurnHistoryHelper,
  compileProviderSendRequest,
  ContextGovernanceSessionRegistry,
  fileContextFor,
  InMemoryContextPayloadStore,
  ProviderRequestCompiler,
  ToolExecutionPolicy,
  type ToolExecutionPolicyContext,
  ToolExecutor,
  type ToolExecutorEvents,
} from '@velaros-ai/agent'
import { logRuntime } from '@velaros-ai/core/logger'

import { finalizeProjectModelResult } from '../src/agent/presentation/source-window'
import { projectTools } from '../src/agent/Project.tool'
import type { ProjectToolContext } from '../src/agent/Types'
import { ProjectError } from '../src/errors'
import { createProjectKernel } from '../src/index'
import type { ProjectPlugin } from '../src/types/plugin'

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'project-validation-reuse-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function fixture(plugins: ProjectPlugin[] = []) {
  const kernel = await createProjectKernel({ root, plugins })
  const context: ProjectToolContext & ToolExecutionPolicyContext = {
    sessionId: 'validation-reuse',
    contextPayloadStore: new InMemoryContextPayloadStore(),
    abortSignal: new AbortController().signal,
    log: logRuntime.tag('ProjectValidationReuse'),
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
  const call = async (toolCallId: string, name: string, args: Record<string, unknown>) => {
    const executor = new ToolExecutor(context, events, policy)
    executor.enqueue(toolCallId, name, args, false)
    const [result] = await executor.collectAll()
    return result!
  }
  const read = async (path: string) => {
    const result = await call('read-source', 'project:read', { path })
    expect(result.error).toBeUndefined()
    const visible = await finalizeProjectModelResult(context, result.result) as { files: Array<{ fileRef: string }> }
    return visible.files[0]!.fileRef
  }
  return { context, kernel, call, read }
}

test.each([false, true])('candidate syntax failure preserves a large input and succeeds by changing only its range; excerpt=%s', async (wrapped) => {
  const original = 'export class Example {\n  run() {\n    const old = true\n    return old\n  }\n}\n'
  await writeFile(join(root, 'example.ts'), original)
  const { context, call, read } = await fixture()
  const fileRef = await read('example.ts')
  const text = `  run() {\n${'    // 中文🙂 C:\\src\\path 字面转义 \\n\n'.repeat(100)}    return false\n  }`
  expect(text.length).toBeGreaterThan(3000)
  const input = { files: [{ fileRef, edits: [{ op: 'replace', range: [2, 4], text }] }] }
  const failed = await call('failed-candidate', 'project:edit', input)
  expect(failed.result).toMatchObject({
    code: 'VALIDATION_FAILED', executionOutcome: 'not-applied',
    details: { executionOutcome: 'not-applied' },
    inputReuse: { reuse: 'attempt:failed-candidate' },
  })
  expect(await readFile(join(root, 'example.ts'), 'utf8')).toBe(original)

  const history: any[] = [{ role: 'user', content: 'Make the authorized change.' },
    { role: 'assistant', content: [{ type: 'tool-call', toolName: 'project:edit', toolCallId: 'failed-candidate', input }] }]
  await new AgentTurnHistoryHelper().appendToolResultsToHistory(history, {
    collectAll: async () => [failed], getTerminalError: () => undefined,
  })
  const output = history[2].content[0].output
  if (wrapped) output.value = JSON.stringify({ __contextRef: 'tool-output', ref: 'failed-candidate', excerpt: output.value,
    retrieval: { tool: 'context:recall', args: { ref: 'failed-candidate' } } })
  const originalFailure = JSON.stringify(history[2])
  const compiler = new ProviderRequestCompiler(new ContextGovernanceSessionRegistry({ config: { dashboard: false } }))
  const compile = () => compileProviderSendRequest({
    sessionId: context.sessionId!, toolContext: context as never, payloadStore: context.contextPayloadStore,
    rawHistoryMessages: history, phase: 'stream', model: 'gpt-test', systemPrompt: 'system', contextWindow: 64000,
    availableToolNames: ['project_edit', 'context_recall'], toolNameAliases: { 'project:edit': 'project_edit', 'context:recall': 'context_recall' },
  }, compiler)
  const shownFailure = (messages: any[]) => {
    const part = messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .find((entry) => entry.type === 'tool-result' && entry.toolCallId === 'failed-candidate')
    const value = JSON.parse(part.output.value)
    return wrapped ? JSON.parse(value.excerpt) : value
  }
  const shown = shownFailure((await compile()).messages)
  expect(shown.details.recovery).toMatchObject({ kind: 'project-edit-validation', coordinateSpace: 'candidate', applied: false })
  expect(shown.details.recovery.windows.length).toBeGreaterThan(0)
  for (const window of shown.details.recovery.windows) {
    expect(window).not.toHaveProperty('fileRef')
    expect(window.kind).not.toBe('project-source-window')
  }
  expect(fileContextFor(context)!.currentViews().find((view) => view.path === 'example.ts')!.snapshots[0]!.content).toBe(original)
  expect(JSON.stringify(history[2])).toBe(originalFailure)

  const retry = { reuse: 'attempt:failed-candidate', changes: [{ op: 'set', path: ['files', 0, 'edits', 0, 'range'], value: [2, 5] }] }
  expect(JSON.stringify(retry).length).toBeLessThan(text.length / 10)
  const completed = await call('fixed-candidate', 'project:edit', retry)
  expect(completed.error).toBeUndefined()
  expect(completed.result).toMatchObject({ changed: true })
  expect(await readFile(join(root, 'example.ts'), 'utf8')).toBe(`export class Example {\n${text}\n}\n`)
  const records = await context.contextPayloadStore!.listForSession(context.sessionId!)
  const saved = records.filter((record) => record.toolName === '__tool_attempt_input__').map((record) => JSON.parse(record.serializedResult))
  expect(saved).toHaveLength(2)
  expect(saved.map((record) => record.args.files[0].edits[0].text)).toEqual([text, text])
  const outcomes = records.filter((record) => record.toolName === '__tool_attempt_outcome__').map((record) => JSON.parse(record.serializedResult))
  expect(outcomes.map((record) => record.outcome)).toEqual(['not-applied', 'completed'])
  expect(outcomes[1].metrics).toMatchObject({ reused: true, requestedChars: JSON.stringify(retry).length })
  history.push({ role: 'assistant', content: [{ type: 'tool-call', toolName: 'project:edit', toolCallId: 'fixed-candidate', input: retry }] })
  await new AgentTurnHistoryHelper().appendToolResultsToHistory(history, {
    collectAll: async () => [completed], getTerminalError: () => undefined,
  })
  expect(shownFailure((await compile()).messages).details.recovery).toMatchObject({ kind: 'project-edit-validation', status: 'archived' })
  expect(shownFailure((await compile()).messages).details.recovery.windows).toBeUndefined()
  expect(JSON.stringify(history[2])).toBe(originalFailure)
})

test('a validator rejecting without diagnostics still returns safe reuse through the Agent executor', async () => {
  const { call } = await fixture([{
    name: 'test.empty-validation', version: '1', setup(registry) {
      registry.registerValidator({ id: 'test.empty', canValidate: () => true,
        validate: () => ({ ok: false, diagnostics: [], checks: [{ id: 'test.empty', ok: false }] }) })
    },
  }])
  const failure = await call('empty-diagnostics', 'project:file', { actions: [{ op: 'create', path: 'new.txt', text: 'content' }] })
  expect(failure.result).toMatchObject({ code: 'VALIDATION_FAILED', executionOutcome: 'not-applied', inputReuse: { reuse: 'attempt:empty-diagnostics' } })
  await expect(readFile(join(root, 'new.txt'))).rejects.toThrow()
})

test('an error after a committed write cannot gain reuse merely by using a validation reason', async () => {
  await writeFile(join(root, 'value.txt'), 'before\n')
  const { kernel, call, read } = await fixture()
  const fileRef = await read('value.txt')
  const apply = kernel.applyEdit.bind(kernel)
  kernel.applyEdit = async (input) => {
    await apply(input)
    throw new ProjectError('VALIDATION_FAILED', 'injected failure after commit')
  }
  const failed = await call('committed-failure', 'project:edit', { files: [{ fileRef, edits: [{ op: 'replace', range: 1, text: 'after' }] }] })
  expect(failed.error).toBeDefined()
  expect(failed.result).toMatchObject({ executionOutcome: 'unknown' })
  expect(failed.result).not.toHaveProperty('inputReuse')
  expect(await readFile(join(root, 'value.txt'), 'utf8')).toBe('after\n')
})
