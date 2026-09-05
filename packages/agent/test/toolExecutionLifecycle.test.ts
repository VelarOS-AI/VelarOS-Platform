import { describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import { AgentTurnHistoryHelper } from '../src/agent/history'
import { KernelToolLoopGuard } from '../src/kernel/tool-loop-guard'
import { AgentModSeamDispatcher } from '../src/mods/AgentModSeams'
import { ToolExecutionPolicy, type ToolExecutionPolicyContext } from '../src/tools/ExecutionPolicy'
import { ToolExecutor, type ToolExecutorEvents, type ToolResult } from '../src/tools/Executor'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function harness(run: (context: ToolExecutionPolicyContext) => unknown = () => ({ ok: true })) {
  const abort = new AbortController()
  const emitted: unknown[] = []
  const tool = {
    permissions: ['project:write'],
    schema: { safeParse: (input: unknown) => ({ success: true, data: input }) },
    execute: (_args: unknown, context: ToolExecutionPolicyContext) => run(context),
  }
  const context: ToolExecutionPolicyContext = {
    abortSignal: abort.signal,
    log: logRuntime.tag('ToolExecutionLifecycleTest'),
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
  }
  const policy = new ToolExecutionPolicy({
    get: () => tool as never,
    listAvailable: (_context, names) => (names ?? []).map((name) => ({ name })),
    getDescriptor: () => null,
  })
  const events: ToolExecutorEvents = {
    emitRuntime: () => undefined,
    emitNotice: () => undefined,
    emitToolStart: () => undefined,
    emitToolProgress: () => undefined,
    emitToolDone: (value) => { emitted.push(value) },
  }
  return { abort, context, policy, events, emitted }
}

function beforeHook(entered: ReturnType<typeof deferred>, release: ReturnType<typeof deferred>): AgentModSeamDispatcher {
  const seams = new AgentModSeamDispatcher()
  seams.beginRegistration()
  seams.register({
    modId: 'test.lifecycle', id: 'before', event: 'tool-call:before',
    handler: async () => { entered.resolve(); await release.promise; return {} },
  })
  seams.seal()
  return seams
}

async function call(executor: ToolExecutor, id: string): Promise<ToolResult> {
  executor.enqueue(id, 'probe:write', { value: 'same' }, false)
  return (await executor.collectAll()).at(-1)!
}

describe('tool execution lifecycle', () => {
  test('cancellation during the before hook prevents the tool side effect', async () => {
    let writes = 0
    const h = harness(() => { writes++; return { ok: true } })
    const entered = deferred(); const release = deferred()
    const executor = new ToolExecutor(h.context, h.events, h.policy, {
      seams: beforeHook(entered, release),
    })
    const result = call(executor, 'cancelled-hook')
    await entered.promise
    h.abort.abort('user cancelled')
    release.resolve()
    expect((await result).result).toMatchObject({ error: 'tool_cancelled' })
    expect(writes).toBe(0)
    expect(h.emitted).toHaveLength(1)
  })

  test('sibling cancellation while a before hook waits also prevents execution', async () => {
    let attempts = 0
    const failFirst = deferred(); const entered = deferred(); const release = deferred(); const failed = deferred()
    const h = harness(async () => {
      attempts++
      await failFirst.promise
      throw new AppError('EXECUTION_DENIED', 'test sibling failure')
    })
    const seams = new AgentModSeamDispatcher()
    seams.beginRegistration()
    seams.register({
      modId: 'test.lifecycle', id: 'before', event: 'tool-call:before',
      handler: async (event) => {
        if (event.toolCallId === 'waiting') { entered.resolve(); await release.promise }
        return {}
      },
    })
    seams.seal()
    const executor = new ToolExecutor(h.context, {
      ...h.events,
      emitToolDone: (result) => { h.events.emitToolDone(result); if (result.toolCallId === 'failing') failed.resolve() },
    }, h.policy, { seams })
    executor.enqueue('failing', 'probe:write', {}, true)
    executor.enqueue('waiting', 'probe:write', {}, true)
    await entered.promise
    failFirst.resolve()
    await failed.promise
    release.resolve()
    const results = await executor.collectAll()
    expect(attempts).toBe(1)
    expect(results[1]?.result).toMatchObject({ error: 'tool_cancelled' })
    expect(executor.getTerminalError()?.code).toBe('EXECUTION_DENIED')
  })

  test('cancellation during asynchronous approval preparation prevents execution', async () => {
    let writes = 0
    const h = harness(() => { writes++; return { ok: true } })
    const executor = new ToolExecutor(h.context, h.events, h.policy)
    executor.enqueue('cancelled-approval', 'probe:write', {}, false)
    h.abort.abort('cancelled while approval resolves')
    await executor.collectAll()
    expect(writes).toBe(0)
    expect(executor.getTerminalError()?.code).toBe('EXECUTION_ABORTED')
  })

  test('a finalization failure preserves call/result pairing and stops queued side effects', async () => {
    let writes = 0
    const h = harness(() => { writes++; return { ok: true } })
    const executor = new ToolExecutor(h.context, h.events, h.policy, {
      outputStore: { project: () => { throw new Error('ENOSPC: test storage failure') } },
    })
    executor.enqueue('first', 'probe:write', {}, false)
    executor.enqueue('second', 'probe:write', { value: 'next' }, false)
    const results = await executor.collectAll()
    expect(writes).toBe(1)
    expect(results.map((result) => result.toolCallId)).toEqual(['first', 'second'])
    expect(results[0]?.result).toMatchObject({ error: 'tool_result_finalization_failed' })
    expect(executor.getTerminalError()?.code).toBe('TOOL_RESULT_FINALIZATION_FAILED')
    expect(h.emitted).toHaveLength(2)
    const history: any[] = []
    await expect(new AgentTurnHistoryHelper().appendToolResultsToHistory(history, executor)).rejects.toMatchObject({ code: 'TOOL_RESULT_FINALIZATION_FAILED' })
    expect(history[0].content.map((result: any) => result.toolCallId)).toEqual(['first', 'second'])
  })

  test('publisher errors keep the committed result and become terminal errors', async () => {
    const h = harness()
    const executor = new ToolExecutor(h.context, {
      ...h.events, emitToolDone: () => { throw new Error('test publisher failure') },
    }, h.policy)
    const result = await call(executor, 'publisher')
    expect(result.result).toEqual({ ok: true })
    expect(executor.getTerminalError()?.code).toBe('TOOL_RESULT_FINALIZATION_FAILED')
  })

  test('repeated writes are guarded across turn executors and reset after new evidence', async () => {
    let writes = 0
    const h = harness(() => { writes++; return { ok: true } })
    const loopGuard = new KernelToolLoopGuard()
    const next = (): ToolExecutor => new ToolExecutor(h.context, h.events, h.policy, { loopGuard })
    expect((await call(next(), 'turn-1')).error).toBeUndefined()
    expect((await call(next(), 'turn-2')).error).toBeUndefined()
    expect((await call(next(), 'turn-3')).result).toMatchObject({ error: 'tool_loop_guard' })
    expect(writes).toBe(2)
    loopGuard.recordSuccess({ toolName: 'probe:read', args: {}, writeLike: false })
    expect((await call(next(), 'turn-4')).error).toBeUndefined()
    expect(writes).toBe(3)
    expect((await call(new ToolExecutor(h.context, h.events, h.policy), 'new-run')).error).toBeUndefined()
  })

  test('failure batches are counted across turns without recounting collected results', async () => {
    const h = harness(() => { throw new AppError('IO', 'same deterministic failure') })
    const loopGuard = new KernelToolLoopGuard()
    for (let turn = 1; turn <= 3; turn++) {
      const executor = new ToolExecutor(h.context, h.events, h.policy, { loopGuard })
      const result = await call(executor, `turn-${turn}`)
      if (turn === 3) expect(result.result).toMatchObject({ error: 'tool_loop_guard' })
      else expect(result.result).not.toMatchObject({ error: 'tool_loop_guard' })
      await executor.collectAll()
    }
  })
})

test('model call identity and inherited host ports survive a frozen Query context', async () => {
  let observed: string | undefined
  const h = harness((context) => {
    observed = context.toolCallId
    expect(context.role.id).toBe('assistant')
    expect(context.codingSession).toBe(h.context.codingSession)
    return { ok: true }
  })
  const child: ToolExecutionPolicyContext = Object.freeze(Object.create(h.context))
  const executor = new ToolExecutor(child, h.events, h.policy)
  expect((await call(executor, 'provider-original-call')).result).toEqual({ ok: true })
  expect(observed).toBe('provider-original-call')
})
