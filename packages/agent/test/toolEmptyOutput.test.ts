import { expect, test } from 'bun:test'

import type { ContextPayloadStore } from '../src/agent/context/ContextPayloadStore'
import {
  ContextPayloadKernelToolOutputStore,
  InMemoryKernelToolOutputStore,
} from '../src/kernel/tool-output-store'
import { ToolExecutionPolicy, type ToolExecutionPolicyContext } from '../src/tools/ExecutionPolicy'
import { ToolExecutor } from '../src/tools/Executor'

test('empty successful outputs stay paired and do not cancel following writes', async () => {
  for (const outputStore of [
    new InMemoryKernelToolOutputStore(),
    new ContextPayloadKernelToolOutputStore({} as ContextPayloadStore),
  ]) {
    let executions = 0
    const definition = {
      permissions: ['fs:write'],
      schema: { safeParse: (input: unknown) => ({ success: true, data: input }) },
      execute: async () => {
        executions += 1
      },
    }
    const context = {
      abortSignal: new AbortController().signal,
      role: { id: 'assistant' },
      execution: null,
      getCurrentVisibleToolSurfaceProfile: () => null,
      codingSession: {
        getToolSurfaceProfile: () => 'full',
        getRedundantToolCallMessage: () => null,
        recordToolResult: () => {},
        recordToolCallResult: () => {},
        consumePendingAutoApprovalNotice: () => null,
      },
    } as unknown as ToolExecutionPolicyContext
    const policy = new ToolExecutionPolicy({
      get: () => definition as never,
      listAvailable: (_context, names) => (names ?? []).map((name) => ({ name })),
      getDescriptor: () => null,
    })
    const executor = new ToolExecutor(
      context,
      {
        emitRuntime: () => {},
        emitNotice: () => {},
        emitToolStart: () => {},
        emitToolDone: () => {},
      },
      policy,
      { outputStore }
    )
    executor.enqueue('empty-1', 'fixture:write', {}, false)
    executor.enqueue('empty-2', 'fixture:write', {}, false)
    const results = await executor.collectAll()
    expect(executions).toBe(2)
    expect(executor.getTerminalError()).toBeNull()
    expect(results.map((result) => [result.toolCallId, result.error, result.modelResult])).toEqual([
      ['empty-1', undefined, null],
      ['empty-2', undefined, null],
    ])
  }
})
