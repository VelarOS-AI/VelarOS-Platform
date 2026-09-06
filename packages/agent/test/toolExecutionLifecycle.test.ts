import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import { AgentTurnHistoryHelper } from '../src/agent/history'
import { KernelToolLoopGuard } from '../src/kernel/tool-loop-guard'
import { AgentModSeamDispatcher } from '../src/mods/AgentModSeams'
import { clampedInt } from '../src/tool-contract'
import { ToolExecutionPolicy, type ToolExecutionPolicyContext } from '../src/tools/ExecutionPolicy'
import { ToolExecutor, type ToolExecutorEvents, type ToolResult } from '../src/tools/Executor'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function harness(
  run: (context: ToolExecutionPolicyContext, input?: unknown) => unknown = () => ({ ok: true }),
  options: {
    schema?: { safeParse(input: unknown): unknown }
    surface?: {
      schema: { safeParse(input: unknown): unknown }
      normalize: (input: any, context: ToolExecutionPolicyContext) => Record<string, unknown>
    }
    isConcurrencySafe?: (input: Record<string, unknown>) => boolean
    isAvailable?: () => boolean
    getRedundantMessage?: (args: Record<string, unknown>) => string | null
    onRedundantArgs?: (args: Record<string, unknown>) => void
    onRecordToolCallResult?: (args: Record<string, unknown>) => void
  } = {}
) {
  const abort = new AbortController()
  const emitted: unknown[] = []
  const metadata: unknown[] = []
  const tool = {
    permissions: ['project:write'],
    schema: options.schema ?? { safeParse: (input: unknown) => ({ success: true, data: input }) },
    surfaces: options.surface ? { guided: options.surface } : undefined,
    isConcurrencySafe: options.isConcurrencySafe,
    execute: (input: unknown, context: ToolExecutionPolicyContext) => run(context, input),
  }
  const context: ToolExecutionPolicyContext = {
    abortSignal: abort.signal,
    log: logRuntime.tag('ToolExecutionLifecycleTest'),
    role: { id: 'assistant' },
    execution: null,
    getCurrentVisibleToolSurfaceProfile: () => options.surface ? 'guided' : null,
    codingSession: {
      recordToolResult: () => undefined,
      recordToolCallResult: (_toolName, args) => options.onRecordToolCallResult?.(args),
      getRedundantToolCallMessage: (_toolName, args) => {
        options.onRedundantArgs?.(args)
        return options.getRedundantMessage?.(args) ?? null
      },
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
    listAvailable: (_context, names) => options.isAvailable?.() === false
      ? []
      : (names ?? []).map((name) => ({ name })),
    getDescriptor: () => null,
  })
  const events: ToolExecutorEvents = {
    emitRuntime: () => undefined,
    emitNotice: () => undefined,
    emitToolStart: () => undefined,
    emitToolProgress: () => undefined,
    emitToolMetadata: (value) => { metadata.push(value) },
    emitToolDone: (value) => { emitted.push(value) },
  }
  return { abort, context, policy, events, emitted, metadata }
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
  test('executes, records, and reports the effective schema-normalized arguments', async () => {
    let executedInput: unknown
    const h = harness(
      (_context, input) => {
        executedInput = input
        return { ok: true }
      },
      {
        schema: z.object({
          limit: clampedInt(1, 50),
          mode: z.enum(['brief', 'full']).default('brief'),
        }),
      }
    )
    const executor = new ToolExecutor(h.context, h.events, h.policy)
    executor.enqueue('normalized', 'probe:write', { limit: 1_000, extra: true }, false)

    const [result] = await executor.collectAll()

    expect(executedInput).toEqual({ limit: 50, mode: 'brief' })
    expect(result?.args).toEqual({ limit: 50, mode: 'brief' })
    expect(h.metadata).toContainEqual(expect.objectContaining({
      toolCallId: 'normalized',
      metadata: expect.objectContaining({ inputAdjusted: true }),
    }))
  })

  test('uses overwrite-normalized action parameters for dedupe, execution, and history', async () => {
    const exactSchema = z.discriminatedUnion('action', [
      z.object({
        action: z.literal('navigate'),
        navigationAction: z.enum(['goto', 'back']).default('goto'),
        url: z.string(),
      }),
      z.object({ action: z.literal('type'), text: z.string() }),
    ])
    const schema = z
      .object({
        action: z.enum(['navigate', 'type']),
        navigationAction: z.enum(['goto', 'back']).optional(),
        url: z.string().optional(),
        text: z.string().optional(),
      })
      .superRefine((input, context) => {
        const exact = exactSchema.safeParse(input)
        if (exact.success) return
        for (const issue of exact.error.issues) {
          context.addIssue({ code: 'custom', path: issue.path, message: issue.message })
        }
      })
      .overwrite((input) => {
        const exact = exactSchema.safeParse(input)
        return exact.success ? exact.data : input
      })
    let executedInput: unknown
    let dedupeArgs: Record<string, unknown> | undefined
    const h = harness(
      (_context, input) => {
        executedInput = input
        return { ok: true }
      },
      {
        schema,
        onRedundantArgs: (args) => { dedupeArgs = args },
      }
    )
    const executor = new ToolExecutor(h.context, h.events, h.policy)
    executor.enqueue('action-overwrite', 'probe:write', {
      action: 'navigate',
      url: 'https://example.test',
      text: 'belongs to another action',
    }, false)

    const [result] = await executor.collectAll()
    const effective = {
      action: 'navigate',
      navigationAction: 'goto',
      url: 'https://example.test',
    }

    expect(dedupeArgs).toEqual(effective)
    expect(executedInput).toEqual(effective)
    expect(result?.args).toEqual(effective)
    expect(h.metadata).toContainEqual(expect.objectContaining({
      toolCallId: 'action-overwrite',
      metadata: expect.objectContaining({
        inputAdjusted: true,
        inputAdjustments: expect.arrayContaining([
          expect.objectContaining({ field: 'text', action: 'ignored' }),
          expect.objectContaining({ field: 'navigationAction', action: 'defaulted' }),
        ]),
      }),
    }))
  })

  test('uses surface-normalized arguments for dedupe, loop guard, execution, and history', async () => {
    let dedupeArgs: Record<string, unknown> | undefined
    const h = harness(
      () => ({ ok: true }),
      {
        schema: z.object({
          limit: clampedInt(1, 50),
          mode: z.enum(['brief', 'full']).default('brief'),
        }),
        surface: {
          schema: z.object({ amount: z.string() }),
          normalize: ({ amount }) => ({ limit: Number(amount) }),
        },
        onRedundantArgs: (args) => { dedupeArgs = args },
      }
    )
    const loopGuard = new KernelToolLoopGuard()
    const execute = async (id: string, amount: string): Promise<ToolResult> => {
      const executor = new ToolExecutor(h.context, h.events, h.policy, { loopGuard })
      executor.enqueue(id, 'probe:write', { amount }, false)
      return (await executor.collectAll()).at(-1)!
    }

    expect((await execute('surface-1', '100')).error).toBeUndefined()
    expect(dedupeArgs).toEqual({ limit: 50, mode: 'brief' })
    expect((await execute('surface-2', '200')).args).toEqual({ limit: 50, mode: 'brief' })
    expect((await execute('surface-3', '300')).result).toMatchObject({ error: 'tool_loop_guard' })
  })

  test('normalizes a surface once and preserves its provider-shaped history input', async () => {
    let normalizeCalls = 0
    let dedupeArgs: Record<string, unknown> | undefined
    let executedInput: unknown
    const providerArgs = { amount: '10' }
    const h = harness(
      (_context, input) => {
        executedInput = input
        return { ok: true }
      },
      {
        schema: z.object({ limit: z.number() }),
        surface: {
          schema: z.object({ amount: z.string() }),
          normalize: ({ amount }) => {
            normalizeCalls += 1
            return { limit: Number(amount) + normalizeCalls }
          },
        },
        onRedundantArgs: (args) => { dedupeArgs = args },
      }
    )
    const executor = new ToolExecutor(h.context, h.events, h.policy)
    executor.enqueue('stateful-surface', 'probe:write', providerArgs, false)

    const [result] = await executor.collectAll()

    expect(normalizeCalls).toBe(1)
    expect(dedupeArgs).toEqual({ limit: 11 })
    expect(executedInput).toEqual({ limit: 11 })
    expect(result?.args).toEqual({ limit: 11 })
    expect(providerArgs).toEqual({ amount: '10' })
  })

  test('admits rewritten calls in reception order using their once-normalized effective arguments', async () => {
    let beforeCalls = 0
    let normalizeCalls = 0
    let active = 0
    let maxActive = 0
    const started: string[] = []
    const releaseEarlierBefore = deferred()
    const laterPrepared = deferred()
    const anyEntered = deferred()
    const observedSafetyArgs: Array<Record<string, unknown>> = []
    const h = harness(
      async (context, input) => {
        const effective = input as { id: string; mutate: boolean; mode: string }
        started.push(effective.id)
        active += 1
        maxActive = Math.max(maxActive, active)
        anyEntered.resolve()
        await new Promise<void>((resolve) => {
          if (context.abortSignal.aborted) {
            resolve()
            return
          }
          context.abortSignal.addEventListener('abort', () => resolve(), { once: true })
        })
        active -= 1
        return { ok: true }
      },
      {
        schema: z.object({
          id: z.string(),
          mutate: z.boolean(),
          mode: z.enum(['brief', 'full']).default('brief'),
        }),
        surface: {
          schema: z.object({ id: z.string(), intent: z.enum(['inspect', 'mutate']) }),
          normalize: ({ id, intent }) => {
            normalizeCalls += 1
            if (id === 'second') laterPrepared.resolve()
            return { id, mutate: intent === 'mutate' }
          },
        },
        isConcurrencySafe: (input) => {
          observedSafetyArgs.push(input)
          return input.mutate !== true
        },
      }
    )
    const seams = new AgentModSeamDispatcher()
    seams.beginRegistration()
    seams.register({
      modId: 'test.lifecycle', id: 'rewrite-for-concurrency', event: 'tool-call:before',
      handler: async (event) => {
        beforeCalls += 1
        if (event.toolCallId === 'first') await releaseEarlierBefore.promise
        return { args: { ...event.args, intent: 'mutate' } }
      },
    })
    seams.seal()
    const executor = new ToolExecutor(h.context, h.events, h.policy, { seams })

    executor.enqueue('first', 'probe:write', { id: 'first', intent: 'inspect' }, true)
    executor.enqueue('second', 'probe:write', { id: 'second', intent: 'inspect' }, true)
    await laterPrepared.promise
    await Promise.resolve()
    await Promise.resolve()
    expect(started).toEqual([])

    releaseEarlierBefore.resolve()
    await anyEntered.promise
    expect(started).toEqual(['first'])
    expect(maxActive).toBe(1)
    expect(beforeCalls).toBe(2)
    expect(normalizeCalls).toBe(2)
    expect(observedSafetyArgs).toEqual(expect.arrayContaining([
      { id: 'first', mutate: true, mode: 'brief' },
      { id: 'second', mutate: true, mode: 'brief' },
    ]))

    h.abort.abort('test waiting admission cancellation')
    const results = await executor.collectAll()
    expect(started).toEqual(['first'])
    expect(results.map((result) => result.toolCallId)).toEqual(['first', 'second'])
    expect(results[1]?.result).toMatchObject({ error: 'tool_cancelled' })
  })

  test('runs effective read-only calls eight at a time despite conservative caller hints', async () => {
    let active = 0
    let maxActive = 0
    let started = 0
    const eightEntered = deferred()
    const release = deferred()
    const h = harness(
      async () => {
        active += 1
        started += 1
        maxActive = Math.max(maxActive, active)
        if (started === 8) eightEntered.resolve()
        await release.promise
        active -= 1
        return { ok: true }
      },
      { isConcurrencySafe: () => true }
    )
    const executor = new ToolExecutor(h.context, h.events, h.policy)
    for (let index = 0; index < 10; index++) {
      executor.enqueue(`read-${index}`, 'probe:write', { index }, false)
    }

    await eightEntered.promise
    expect(started).toBe(8)
    expect(maxActive).toBe(8)
    release.resolve()

    const results = await executor.collectAll()
    expect(results).toHaveLength(10)
    expect(started).toBe(10)
    expect(maxActive).toBe(8)
  })

  test('rechecks effective dedupe state after an earlier exclusive write succeeds', async () => {
    let recorded = false
    let writes = 0
    const h = harness(
      () => {
        writes += 1
        return { changed: true }
      },
      {
        isConcurrencySafe: () => false,
        getRedundantMessage: () => recorded ? 'same effective write already completed' : null,
        onRecordToolCallResult: () => { recorded = true },
      }
    )
    const executor = new ToolExecutor(h.context, h.events, h.policy)
    executor.enqueue('write-1', 'probe:write', { path: 'same.txt' }, true)
    executor.enqueue('write-2', 'probe:write', { path: 'same.txt' }, true)

    const results = await executor.collectAll()
    expect(writes).toBe(1)
    expect(results[0]?.error).toBeUndefined()
    expect(results[1]?.error).toBe('same effective write already completed')
  })

  test('rechecks availability after an exclusive call waits for its execution slot', async () => {
    let available = true
    const executed: string[] = []
    const firstEntered = deferred()
    const releaseFirst = deferred()
    const secondPrepared = deferred()
    const h = harness(
      async (_context, input) => {
        const { id } = input as { id: string }
        executed.push(id)
        if (id === 'first') {
          firstEntered.resolve()
          await releaseFirst.promise
        }
        return { ok: true }
      },
      {
        isAvailable: () => available,
        isConcurrencySafe: (input) => {
          if (input.id === 'second') secondPrepared.resolve()
          return false
        },
      }
    )
    const executor = new ToolExecutor(h.context, h.events, h.policy)
    executor.enqueue('available-1', 'probe:write', { id: 'first' }, true)
    executor.enqueue('available-2', 'probe:write', { id: 'second' }, true)
    await Promise.all([firstEntered.promise, secondPrepared.promise])

    available = false
    releaseFirst.resolve()
    const results = await executor.collectAll()
    expect(executed).toEqual(['first'])
    expect(results[1]?.error).toBe(
      'Tool is not available in the current context: probe:write'
    )
  })

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

  test.each(['matches', 'transform'] as const)('a result middleware %s failure stops writes after the operation took effect', async (failureStage) => {
    let writes = 0
    const h = harness(() => { writes++; return { ok: true } })
    h.context.capabilityPorts = {
      extensions: [{
        descriptor: {
          id: 'test.result-failure', version: '1.0.0',
          toolNames: ['probe:write'], categoryIds: [], operationIds: [],
        },
        resultMiddlewares: [{
          id: 'failing-result',
          matches: () => {
            if (failureStage === 'matches') throw new Error('result matching failed')
            return true
          },
          transform: () => { throw new Error('result transformation failed') },
        }],
      }],
    }
    const executor = new ToolExecutor(h.context, h.events, h.policy)
    executor.enqueue('first', 'probe:write', { value: 'one' }, false)
    executor.enqueue('second', 'probe:write', { value: 'two' }, false)

    const results = await executor.collectAll()

    expect(writes).toBe(1)
    expect(results[0]?.result).toMatchObject({ error: 'tool_result_finalization_failed' })
    expect(results[0]?.error).toContain('may already have taken effect')
    expect(results[1]?.result).toMatchObject({ error: 'tool_cancelled' })
    expect(executor.getTerminalError()?.code).toBe('TOOL_RESULT_FINALIZATION_FAILED')
    expect(h.emitted).toHaveLength(2)
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
